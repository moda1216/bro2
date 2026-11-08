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
import { loadLayers, LAYER_FILES } from "../src/bench/loader.ts";
import { LAYERS, type TaskLayer } from "../src/bench/schema.ts";
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

const report = await runEval({
  tasks: loaded.tasks,
  mode: "deterministic",
  root: ROOT,
  thresholds,
  onProgress: quiet ? undefined : (line) => process.stdout.write(line + "\n"),
});

const rows = present.map((l) => {
  const runs = report.runs.filter((r) => layerOf.get(r.taskId) === l.layer);
  const ok = runs.filter((r) => r.ok).length;
  const samples = l.v2.filter((t) => t.sample).length;
  return { layer: l.layer, total: runs.length, ok, file: LAYER_FILES[l.layer], samples, hash: l.hash };
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
  process.stdout.write("\n层    任务   通过      样例   文件\n");
  for (const r of rows) {
    process.stdout.write(
      `${r.layer.padEnd(5)} ${String(r.total).padEnd(6)} ${`${r.ok}/${r.total}`.padEnd(9)} ` +
      `${String(r.samples).padEnd(6)} ${r.file}\n`,
    );
  }
  const total = rows.reduce((a, r) => a + r.total, 0);
  const ok = rows.reduce((a, r) => a + r.ok, 0);
  process.stdout.write(`${"合计".padEnd(5)} ${String(total).padEnd(6)} ${`${ok}/${total}`.padEnd(9)}\n`);
  process.stdout.write(`\n任务集指纹: ${report.taskSetHash}\n`);
  if (report.gate.violations.length) {
    process.stdout.write(`门禁违规: ${report.gate.violations.join("; ")}\n`);
  }
  process.stdout.write(`门禁: ${report.gate.pass ? "✓ PASS" : "✗ FAIL"}\n`);
  if (savePath) process.stdout.write(`报告已写入: ${savePath}\n`);
}

process.exit(report.gate.pass ? 0 : 1);
