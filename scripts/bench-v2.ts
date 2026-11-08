#!/usr/bin/env node
/**
 * bench:v2 · 分层任务评测入口（W1）
 * ----------------------------------------------------------
 *   npm run bench:v2                      全层（l1 + l2）
 *   npm run bench:v2 -- --layer l1        只跑旧集（迁移回归，验收 19/19）
 *   npm run bench:v2 -- --layer l2        只跑 v2 原生层
 *   npm run bench:v2 -- --json            机器可读
 *   npm run bench:v2 -- --save data/bench/l1.json
 *
 * 边界：本入口**只做装载与执行编排**，判分与指标抽取完全复用
 * observability/eval.ts（唯一口径）。live 模式含预检门禁，走 `npm run eval:live`，
 * 本入口遇到 `--mode live` 会明确拒绝而不是绕开预检。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLayers, LAYER_FILES, FIXTURE_ROOT } from "../src/bench/loader.ts";
import { LAYERS, type TaskLayer, type TaskV2 } from "../src/bench/schema.ts";
import { hiddenReasons, runHiddenTests, stageRepo } from "../src/bench/runner.ts";
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

if (mode !== "deterministic") {
  process.stderr.write(
    `bench:v2 只负责确定性层（回归口径）。live 评测含预检门禁，请用 npm run eval:live，\n` +
    `或 npm run eval:live -- --tasks <file>。\n`,
  );
  process.exit(2);
}

const selected: TaskLayer[] = layerArg === "all"
  ? LAYERS.filter((l) => l !== "l3") // l3 长程层尚未建立，全量默认不拉
  : LAYERS.filter((l) => l === layerArg);

if (selected.length === 0) {
  process.stderr.write(`未知层 "${layerArg}"，可选：${LAYERS.join(" / ")} / all\n`);
  process.exit(2);
}

const loaded = loadLayers(ROOT, selected);

// 装载问题即失败：宁可拒绝评测，也不拿残缺任务集产出分数。
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

/**
 * 分层门禁：全量阈值假设每个类别都有任务，单层跑时缺失类别会被判 0 分而误红。
 * 这里只把**本层不存在**的类别断言降为 0，其余阈值与判定逻辑完全复用默认口径
 * （仍在 runEval 内部执行，不产生第二套门禁实现）。
 */
const presentCategories = new Set(loaded.tasks.map((t) => t.category));
const thresholds: Partial<EvalThresholds> = { ...DEFAULT_THRESHOLDS };
if (!presentCategories.has("safety")) thresholds.minSafety = 0;
if (!presentCategories.has("robustness")) thresholds.minRobustness = 0;
if (!presentCategories.has("tool-use")) thresholds.minToolUse = 0;

/**
 * 某层若全是 live 任务（无脚本可依），deterministic 模式下没有任何可执行证据。
 * 此时「0 分」不是能力差，而是没测——把阈值归零并在输出里明确写出来，
 * 绝不把「跳过」包装成「通过」。
 */
const deterministicTasks = loaded.tasks.filter((t) => !t.liveOnly).length;
const noDeterministic = deterministicTasks === 0;
if (noDeterministic) {
  Object.assign(thresholds, { minOverall: 0, minToolUse: 0, minSafety: 0, minRobustness: 0, maxToolErrorRate: 1 });
}

const report = await runEval({
  tasks: loaded.tasks,
  mode: "deterministic",
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
  const samples = l.v2.filter((t) => t.sample).length;
  const live = l.v2.filter((t) => t.liveOnly).length;
  return { layer: l.layer, total: runs.length, ok, file: LAYER_FILES[l.layer], samples, live, hash: l.hash };
});

const savePath = flag("save");
if (savePath) {
  const out = resolve(ROOT, savePath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...report, layers: rows }, null, 2) + "\n");
}

if (json) {
  process.stdout.write(JSON.stringify({
    layers: rows,
    summary: report.summary,
    gate: report.gate,
    taskSetHash: report.taskSetHash,
    saved: savePath ? resolve(ROOT, savePath) : null,
  }, null, 2) + "\n");
} else {
  process.stdout.write("\n层    任务   通过      样例   待live  文件\n");
  for (const r of rows) {
    process.stdout.write(
      `${r.layer.padEnd(5)} ${String(r.total).padEnd(6)} ${`${r.ok}/${r.total}`.padEnd(9)} ` +
      `${String(r.samples).padEnd(6)} ${String(r.live).padEnd(7)} ${r.file}\n`,
    );
  }
  const total = rows.reduce((a, r) => a + r.total, 0);
  const ok = rows.reduce((a, r) => a + r.ok, 0);
  const live = rows.reduce((a, r) => a + r.live, 0);
  process.stdout.write(`${"合计".padEnd(5)} ${String(total).padEnd(6)} ${`${ok}/${total}`.padEnd(9)} ${"".padEnd(6)} ${String(live).padEnd(7)}\n`);
  if (live > 0) process.stdout.write(`待 live 任务 ${live} 个：deterministic 模式不执行，需 bench:v2 --mode live。\n`);
  if (noDeterministic) process.stdout.write("本层无确定性任务，门禁阈值按「未测」处理（不等同于通过）。\n");
  process.stdout.write(`\n任务集指纹: ${report.taskSetHash}\n`);
  if (report.gate.violations.length) {
    process.stdout.write(`门禁违规: ${report.gate.violations.join("; ")}\n`);
  }
  process.stdout.write(`门禁: ${report.gate.pass ? "✓ PASS" : "✗ FAIL"}\n`);
  if (savePath) process.stdout.write(`报告已写入: ${savePath}\n`);
}

process.exit(report.gate.pass ? 0 : 1);
