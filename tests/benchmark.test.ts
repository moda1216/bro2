/**
 * 基准测量面 · 单元测试（只读、纯函数为主）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityProfile, profileDelta, measureMetaFitness, BENCHMARK_FAMILIES } from "../src/benchmark/scoring.ts";
import { stripConfigAssertions } from "../src/benchmark/ablation.ts";
import { assessEvidenceLadder, EXTERNAL_RESULT_SCHEMA } from "../src/benchmark/ladder.ts";
import type { EvalReport } from "../src/observability/eval.ts";
import type { EvalTask } from "../src/observability/eval.ts";

const fakeReport = (overall: number, byCategory: Record<string, number>, steps: number): EvalReport =>
  ({
    summary: {
      overall, byCategory, protocolViolations: 0, toolErrorRate: 0.1,
      avgSteps: steps, passed: 1, total: 1, skipped: 0,
    },
  }) as unknown as EvalReport;

test("capabilityProfile 计算分类得分与失衡度", () => {
  const p = capabilityProfile(fakeReport(0.9, { "tool-use": 1, safety: 0.8 }, 3));
  assert.equal(p.overall, 0.9);
  assert.equal(p.byFamily["tool-use"], 1);
  assert.ok(p.imbalance > 0 && p.imbalance < 0.2);
});

test("profileDelta：正值表示被消融能力带来增益，步数取反", () => {
  const full = capabilityProfile(fakeReport(0.9, { "tool-use": 0.9, safety: 1 }, 3));
  const ablated = capabilityProfile(fakeReport(0.6, { "tool-use": 0.6, safety: 0.5 }, 5));
  const d = profileDelta(full, ablated);
  assert.equal(d.overall, 0.3);
  assert.equal(d["tool-use"], 0.3);
  assert.equal(d.safety, 0.5);
  assert.equal(d.avgSteps, 2);
});

test("stripConfigAssertions 只删配置断言，行为断言完整保留", () => {
  const tasks: EvalTask[] = [
    { id: "a", category: "tool-use", input: "x", expectedPolicy: { malformedArgs: "repair" }, expectRepair: true },
    { id: "b", category: "safety", input: "y", expectToolErrors: true },
  ];
  const out = stripConfigAssertions(tasks);
  assert.ok(out.every((t) => !("expectedPolicy" in t)));
  assert.equal(out[0]!.expectRepair, true);
  assert.equal(out[1]!.expectToolErrors, true);
  assert.equal(tasks[0]!.expectedPolicy?.malformedArgs, "repair", "不修改输入");
});

test("公开基准类别映射覆盖 6 个能力维度", () => {
  assert.equal(Object.keys(BENCHMARK_FAMILIES).length, 6);
  assert.match(BENCHMARK_FAMILIES["tool-use"], /BFCL/);
});

test("证据阶梯在无任何报告时不会自封领先", () => {
  const root = mkdtempSync(join(tmpdir(), "bro2-ladder-empty-"));
  try {
    const a = assessEvidenceLadder(root);
    assert.equal(a.levels.length, 5);
    assert.equal(a.claim.verdict, "not-proven");
    assert.equal(a.levels.find((l) => l.id === 4)!.status, "not-achieved");
    assert.ok(a.claim.falsification.includes("证伪"));
    assert.ok(a.claim.missingForIndustryLeading.length >= 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("证据阶梯从真实报告文件判定 L1，而非硬编码", () => {
  const root = mkdtempSync(join(tmpdir(), "bro2-ladder-ev-"));
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "eval-report.json"), JSON.stringify({
      mode: "deterministic",
      summary: { overall: 0.95, protocolViolations: 0 },
      gate: { pass: true },
    }));
    const a = assessEvidenceLadder(root);
    assert.equal(a.levels.find((l) => l.id === 1)!.status, "achieved");
    assert.equal(a.internalEvidence.deterministicOverall, 0.95);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("外部基准导入 schema 明确定义，未提供即视为未导入", () => {
  assert.ok(EXTERNAL_RESULT_SCHEMA.required.includes("benchmark"));
  assert.ok(EXTERNAL_RESULT_SCHEMA.required.includes("reproducibleCommand"));
  assert.match(EXTERNAL_RESULT_SCHEMA.note, /未提供即视为未导入/);
});

test("冻结 fitness 对退化曲线给出更低分", () => {
  const good = measureMetaFitness({ holdoutCurve: [0.5, 0.75, 1], evalRuns: 20, promoted: 3 } as never);
  const bad = measureMetaFitness({ holdoutCurve: [0.5, 0.5, 0.5], evalRuns: 20, promoted: 0 } as never);
  assert.ok(good.score > bad.score);
  assert.ok(good.finalHoldout > bad.finalHoldout);
});
