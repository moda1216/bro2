#!/usr/bin/env node
/**
 * bench:v2 · 分层任务评测入口（W1）
 * ----------------------------------------------------------
 *   npm run bench:v2                                  全层确定性回归（l1）
 *   npm run bench:v2 -- --layer l2                    只跑 l2（默认跳过 live 任务）
 *   npm run bench:v2 -- --layer l2 --mode live        真实模型跑 l2（先过 live 预检）
 *   npm run bench:v2 -- --layer l2 --mode live --sample 3 --repeat 2
 *   npm run bench:v2 -- --json | --save data/bench/x.json
 *
 * 边界：本入口**只做装载与执行编排**，判分与指标抽取完全复用
 * observability/eval.ts（唯一口径）；live 预检复用 models/live-gate.ts（唯一门禁）。
 * live 分数是**测量**，不是发布门禁——只有协议违规（未配对 tool_call）才判失败。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { loadLayers, LAYER_FILES, FIXTURE_ROOT } from "../src/bench/loader.ts";
import { LAYERS, type TaskLayer, type TaskV2 } from "../src/bench/schema.ts";
import { hiddenReasons, runHiddenTests, stageRepo } from "../src/bench/runner.ts";
import { liveGate } from "../src/models/live-gate.ts";
import { DEFAULT_THRESHOLDS, runEval } from "../src/observability/eval.ts";
import type { EvalThresholds } from "../src/observability/eval.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return argv.includes(`--${name}`);
}

const layerArg = flag("layer") ?? "all";
const json = has("json");
const quiet = has("quiet") || json;
const mode = flag("mode") ?? "deterministic";
if (mode !== "deterministic" && mode !== "live") {
  process.stderr.write(`未知模式 "${mode}"，可选：deterministic / live\n`);
  process.exit(2);
}
const live = mode === "live";
const k = Math.max(1, Number(flag("repeat") ?? flag("k") ?? 1) || 1);
const sampleN = flag("sample") ? Math.max(1, Number(flag("sample")) || 1) : 0;
const only = flag("only");
/** 同模型、同任务，换 harness 预设——这是「harness 差异」对照的唯一变量。 */
const presetName = flag("preset");

const selected: TaskLayer[] = layerArg === "all"
  ? LAYERS.filter((l) => l !== "l3")
  : LAYERS.filter((l) => l === layerArg);
if (selected.length === 0) {
  process.stderr.write(`未知层 "${layerArg}"，可选：${LAYERS.join(" / ")} / all\n`);
  process.exit(2);
}

const loaded = loadLayers(ROOT, selected);
if (loaded.problems.length > 0) {
  process.stderr.write(`任务集装载失败（${loaded.problems.length} 项）：\n`);
  for (const p of loaded.problems) process.stderr.write(`  ✗ ${p}\n`);
  process.exit(1);
}

const present = loaded.layers.filter((l) => l.exists && l.v2.length > 0);
if (present.length === 0) {
  process.stderr.write(`所选层没有可执行任务：${selected.join(", ")}\n`);
  process.exit(1);
}

const layerOf = new Map<string, TaskLayer>();
for (const l of present) for (const t of l.v2) layerOf.set(t.id, l.layer);

/** v2 原始任务（含 repo/hiddenTests），执行层只看到压平后的 EvalTask。 */
const v2ById = new Map<string, TaskV2>();
for (const l of present) for (const t of l.v2) v2ById.set(t.id, t);

// 模式与任务类型必须匹配：拿 mock 跑真实任务、或拿真实模型跑脚本任务，都是自欺。
let runnable = loaded.tasks.filter((t) => (live ? !t.deterministicOnly : !t.liveOnly));
if (only) runnable = runnable.filter((t) => t.id === only);
if (sampleN > 0) runnable = runnable.slice(0, sampleN);
if (runnable.length === 0) {
  process.stderr.write(
    live
      ? `没有可跑的 live 任务（${loaded.tasks.length} 个任务中 live 可用 0 个）。\n`
      : `没有可跑的确定性任务（${loaded.tasks.length} 个任务全部为 liveOnly）。\n`,
  );
  process.exit(live ? 1 : 0);
}

/**
 * 阈值口径：
 *  - deterministic：沿用默认能力阈值，但把「本层没有的类别」降为 0，避免误红；
 *  - live：分数是测量不是门禁，只保留协议零违规（其余阈值归零）。
 */
const presentCategories = new Set(runnable.map((t) => t.category));
const thresholds: Partial<EvalThresholds> = { ...DEFAULT_THRESHOLDS };
if (!presentCategories.has("safety")) thresholds.minSafety = 0;
if (!presentCategories.has("robustness")) thresholds.minRobustness = 0;
if (!presentCategories.has("tool-use")) thresholds.minToolUse = 0;
if (live) {
  Object.assign(thresholds, { minOverall: 0, minToolUse: 0, minSafety: 0, minRobustness: 0, maxToolErrorRate: 1, maxAvgSteps: 999 });
}

// live 预检：与 eval --mode live 共用同一实现，杜绝两个入口判定分叉。
const providerName = flag("model") ?? process.env.AGENTOS_LIVE_PROVIDER ?? (live ? "keyless" : "mock");
if (live && !has("skip-preflight")) {
  const os = createAgentOS({ root: ROOT, plugins: [] });
  try {
    const gate = await liveGate(os.providers.get(providerName), providerName);
    if (!quiet && gate.probed) process.stdout.write(`预检: ${gate.reason}\n`);
    if (!gate.ready) {
      process.stderr.write(`已拒绝运行 live 评测：${gate.reason}\n`);
      for (const pf of gate.results.at(-1)?.blockers ?? []) process.stderr.write(`  ✗ ${pf}\n`);
      process.exit(1);
    }
    if (!gate.probed) process.stdout.write(`预检未探测端点：${gate.reason}（按配置放行）\n`);
  } finally {
    await os.shutdown();
  }
}

const report = await runEval({
  tasks: presetName ? runnable.map((t) => ({ ...t, preset: presetName })) : runnable,
  mode,
  ...(live ? { providerName } : {}),
  k,
  root: ROOT,
  thresholds,
  // 只铺环境、只跑隐藏命令；判分仍由 runEval 唯一完成。
  prepareWorkspace: (task, workspace) => {
    const v = v2ById.get(task.id);
    if (v?.repo) stageRepo(join(ROOT, FIXTURE_ROOT), v.repo, workspace);
  },
  verifyWorkspace: async (task, workspace) => {
    const v = v2ById.get(task.id);
    if (!v?.hiddenTests?.length) return [];
    return hiddenReasons(await runHiddenTests(workspace, v.hiddenTests));
  },
  onProgress: quiet ? undefined : (line) => process.stdout.write(line + "\n"),
});

const rows = present.map((l) => {
  const runs = report.runs.filter((r) => layerOf.get(r.taskId) === l.layer);
  const ok = runs.filter((r) => r.ok).length;
  const inLayer = l.v2.filter((t) => (live ? !t.deterministicOnly : !t.liveOnly));
  return {
    layer: l.layer, tasks: inLayer.length, ran: runs.length, ok,
    pending: l.v2.length - inLayer.length,
    samples: l.v2.filter((t) => t.sample).length,
    file: LAYER_FILES[l.layer], hash: l.hash,
  };
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const savePath = flag("save") ?? (live ? `data/bench/v2-${providerName}-${stamp}.json` : undefined);
if (savePath) {
  const out = resolve(ROOT, savePath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...report, layers: rows, providerName, k, preset: presetName ?? null }, null, 2) + "\n");
}

if (json) {
  process.stdout.write(JSON.stringify({
    mode, providerName, k, preset: presetName ?? null, layers: rows, summary: report.summary, gate: report.gate,
    taskSetHash: report.taskSetHash, saved: savePath ? resolve(ROOT, savePath) : null,
  }, null, 2) + "\n");
} else {
  process.stdout.write(`\n模式: ${mode}${live ? `  provider: ${providerName}  k=${k}` : ""}${presetName ? `  preset: ${presetName}` : ""}\n`);
  process.stdout.write("层    任务   已跑   通过      未跑   文件\n");
  for (const r of rows) {
    process.stdout.write(
      `${r.layer.padEnd(5)} ${String(r.tasks).padEnd(6)} ${String(r.ran).padEnd(6)} ` +
      `${`${r.ok}/${r.ran}`.padEnd(9)} ${String(r.pending).padEnd(6)} ${r.file}\n`,
    );
  }
  const total = rows.reduce((a, r) => a + r.ran, 0);
  const ok = rows.reduce((a, r) => a + r.ok, 0);
  process.stdout.write(`${"合计".padEnd(5)} ${String(rows.reduce((a, r) => a + r.tasks, 0)).padEnd(6)} ${String(total).padEnd(6)} ${`${ok}/${total}`.padEnd(9)}\n`);
  if (!live && rows.some((r) => r.pending > 0)) {
    process.stdout.write(`未跑任务为 liveOnly，需 --mode live（不会用 mock 伪造通过）。\n`);
  }
  process.stdout.write(`\n任务集指纹: ${report.taskSetHash}\n`);
  if (report.gate.violations.length) process.stdout.write(`门禁违规: ${report.gate.violations.join("; ")}\n`);
  process.stdout.write(`门禁: ${report.gate.pass ? "✓ PASS" : "✗ FAIL"}${live ? "（live 只断言协议零违规）" : ""}\n`);
  if (savePath) process.stdout.write(`报告已写入: ${savePath}\n`);
}

process.exit(report.gate.pass ? 0 : 1);
