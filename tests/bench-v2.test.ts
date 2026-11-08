/**
 * W1 · v2 任务 schema 与分层装载器测试
 *
 * 守住的四条不变量：
 *  1. 旧任务升格是幂等的、不改原始字段 → 迁移零漂移
 *  2. 校验一次报全部问题（不是遇到第一个就抛）→ 可一次修完
 *  3. v2 专有字段在进入评测器前被剥离 → 执行层只看到 EvalTask
 *  4. l1 指纹与既有 eval 报告一致 → 单一事实源，没有第二份任务集
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK_SCHEMA, toEvalTask, upgradeLegacy, validateTaskV2, type TaskV2,
} from "../src/bench/schema.ts";
import { loadLayer, loadLayers, LAYER_FILES } from "../src/bench/loader.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const base = {
  id: "x01", category: "tool-use", input: "do something",
  expectedAnswer: ["ok"], maxSteps: 4,
};

test("upgradeLegacy：补 schema/layer 并从旧字段派生 budget，原始字段不变", () => {
  const t = upgradeLegacy({ ...base }, "l1");
  assert.equal(t.schema, TASK_SCHEMA);
  assert.equal(t.layer, "l1");
  assert.deepEqual(t.budget, { maxSteps: 4, maxTokens: undefined });
  assert.equal(t.id, "x01");
  assert.equal(t.category, "tool-use");
  assert.deepEqual(t.expectedAnswer, ["ok"]);
});

test("upgradeLegacy：幂等——已是 v2 时不覆盖既有 layer 与 budget", () => {
  const once = upgradeLegacy({ ...base }, "l1");
  const twice = upgradeLegacy(once as unknown as Record<string, unknown>, "l2");
  assert.equal(twice.layer, "l1", "不得把已声明的 layer 改写成所在层");
  assert.deepEqual(twice.budget, once.budget);
});

test("validateTaskV2：一次返回全部问题，且能定位到 id", () => {
  const bad = {
    schema: TASK_SCHEMA, layer: "l2", id: "", category: "not-a-category", input: "  ",
    budget: { maxSteps: -1 },
  } as unknown as TaskV2;
  const p = validateTaskV2(bad);
  assert.ok(p.some((x) => x.includes("id 必须")), "缺 id 应报错");
  assert.ok(p.some((x) => x.includes("category 非法")), "非法 category 应报错");
  assert.ok(p.some((x) => x.includes("input 必须")), "空 input 应报错");
  assert.ok(p.some((x) => x.includes("budget.maxSteps")), "负预算应报错");
  assert.ok(p.length >= 4, `应一次报全，实际 ${p.length} 项`);
});

test("validateTaskV2：合法任务零问题", () => {
  assert.deepEqual(validateTaskV2(upgradeLegacy({ ...base }, "l1")), []);
});

test("toEvalTask：剥离 v2 字段，budget 回填到 maxSteps/maxTokens", () => {
  const v2 = upgradeLegacy({ ...base, maxSteps: undefined, budget: { maxSteps: 6, maxTokens: 900 } }, "l2");
  const flat = toEvalTask(v2) as Record<string, unknown>;
  for (const k of ["schema", "layer", "repo", "commit", "hiddenTests", "budget", "sample"]) {
    assert.ok(!(k in flat), `执行层不应看到 v2 字段 ${k}`);
  }
  assert.equal(flat.maxSteps, 6);
  assert.equal(flat.maxTokens, 900);
});

test("loadLayer(l1)：读出 19 条旧任务、零问题、指纹与既有评测报告一致", () => {
  const l = loadLayer(ROOT, "l1");
  assert.ok(l.exists);
  assert.deepEqual(l.problems, []);
  assert.equal(l.v2.length, 19);
  assert.equal(l.tasks.length, 19);

  const reportPath = join(ROOT, "data/eval-report.json");
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { taskSetHash: string };
    assert.equal(l.hash, report.taskSetHash, "v2 装载器必须与 eval 看到同一份任务集（单一事实源）");
  }
});

test("loadLayers：跨层合并后 id 唯一，且 l2 以 v2 原生格式装载", () => {
  const all = loadLayers(ROOT, ["l1", "l2"]);
  assert.deepEqual(all.problems, []);
  const l2 = all.layers.find((x) => x.layer === "l2")!;
  // 不写死总数：任务集会增长，但「合并后不丢不重」必须始终成立。
  assert.equal(all.tasks.length, 19 + l2.v2.length);
  assert.equal(new Set(all.tasks.map((t) => t.id)).size, all.tasks.length);
  assert.ok(l2.v2.length >= 18, `l2 任务不少于 18 个，实际 ${l2.v2.length}`);
  assert.ok(l2.v2.every((t) => t.schema === TASK_SCHEMA && t.layer === "l2"));
  assert.ok(l2.v2.every((t) => t.repo && t.hiddenTests?.length), "l2 真实任务必须绑定仓库与隐藏验收");
});

function withTempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bro2-bench-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test("loadLayer：重复 id 与非法行都被报告，而不是静默丢弃", () => {
  const dir = withTempRepo({
    [LAYER_FILES.l2]: [
      JSON.stringify({ ...base, schema: TASK_SCHEMA, layer: "l2" }),
      JSON.stringify({ ...base, schema: TASK_SCHEMA, layer: "l2" }),
      "{ not json",
    ].join("\n"),
  });
  try {
    const l = loadLayer(dir, "l2");
    assert.ok(l.problems.some((p) => p.includes("重复")), "应报告重复 id");
    assert.ok(l.problems.some((p) => p.includes("JSON 解析失败")), "应报告坏行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLayer：fixture 仓库缺失时拒绝装载（不拿残缺任务集产分数）", () => {
  const dir = withTempRepo({
    [LAYER_FILES.l2]: JSON.stringify({
      ...base, schema: TASK_SCHEMA, layer: "l2", repo: "no-such-repo",
    }),
  });
  try {
    const l = loadLayer(dir, "l2");
    assert.ok(l.problems.some((p) => p.includes("fixture 仓库不存在")), "应报告缺失 fixture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLayer：文件不存在时 exists=false 且不抛异常", () => {
  const dir = withTempRepo({ "keep.txt": "x" });
  try {
    const l = loadLayer(dir, "l3");
    assert.equal(l.exists, false);
    assert.deepEqual(l.problems, []);
    assert.equal(l.tasks.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
