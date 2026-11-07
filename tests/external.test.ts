/**
 * 外部证据导入通道 · 单元测试
 *
 * 重点不是「能读文件」，而是「伪造 / 畸形 / 自封结论的证据不能提升证据等级」。
 * 所有文件操作都在临时目录，绝不触碰真实的 data/benchmark/external-results.json。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateExternalResult, loadExternalResults,
  EXTERNAL_REQUIRED, EXTERNAL_OPTIONAL, EXTERNAL_FORBIDDEN_FIELDS,
} from "../src/benchmark/external.ts";
import { assessEvidenceLadder, EXTERNAL_RESULT_SCHEMA } from "../src/benchmark/ladder.ts";
import { PROTECTED_FILES } from "../src/rsi/guardrails.ts";

const VALID: Record<string, unknown> = {
  benchmark: "BFCL-v3",
  model: "qwen3:8b",
  date: "2026-11-07",
  score: 0.87,
  metric: "overall_accuracy",
  tasks: 200,
  repeat: 3,
  confidenceInterval: [0.84, 0.9],
  harness: "bro2",
  reproducibleCommand: "npm run eval:live -- --tasks data/benchmark/bfcl.jsonl --k 3",
  notes: "需注明模型版本与评分脚本",
};

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "bro2-external-"));
}

function writeExternal(root: string, content: unknown): void {
  mkdirSync(join(root, "data", "benchmark"), { recursive: true });
  writeFileSync(join(root, "data", "benchmark", "external-results.json"), JSON.stringify(content));
}

const reasonOf = (raw: unknown): string => {
  const r = validateExternalResult(raw);
  return r.ok ? "" : r.reason;
};

// ---------------------------------------------------------------- 单条校验

test("合法外部结果通过校验，字段被规范化保留", () => {
  const r = validateExternalResult(VALID);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.score, 0.87);
  assert.equal(r.value.benchmark, "BFCL-v3");
  assert.deepEqual(r.value.confidenceInterval, [0.84, 0.9]);
  assert.equal(r.value.reproducibleCommand.startsWith("npm run"), true);
});

test("空对象因缺少必填字段被拒", () => {
  assert.match(reasonOf({}), /缺少必填字段/);
});

test("缺少 reproducibleCommand 被拒", () => {
  const { reproducibleCommand: _ignored, ...rest } = VALID;
  assert.match(reasonOf(rest), /缺少必填字段 reproducibleCommand/);
});

test("score 越界 / 字符串 / NaN 一律被拒", () => {
  assert.match(reasonOf({ ...VALID, score: 1.5 }), /score/);
  assert.match(reasonOf({ ...VALID, score: "0.87" }), /score/);
  assert.match(reasonOf({ ...VALID, score: Number.NaN }), /score/);
  assert.match(reasonOf({ ...VALID, score: -0.1 }), /score/);
});

test("date 不存在 / 未来 / 格式错一律被拒", () => {
  assert.match(reasonOf({ ...VALID, date: "2026-02-30" }), /date/);
  assert.match(reasonOf({ ...VALID, date: "2099-01-01" }), /晚于今天/);
  assert.match(reasonOf({ ...VALID, date: "2026/11/07" }), /date/);
});

test("未知字段被拒（严格白名单）", () => {
  assert.match(reasonOf({ ...VALID, extraField: 1 }), /未知字段/);
});

test("自带结论字段被拒，且归因精确", () => {
  const r = reasonOf({ ...VALID, verdict: "proven" });
  assert.match(r, /结论字段/);
  assert.match(r, /verdict/);
});

test("占位式复现命令被拒", () => {
  assert.match(reasonOf({ ...VALID, reproducibleCommand: "N/A" }), /复现命令/);
  assert.match(reasonOf({ ...VALID, reproducibleCommand: "TODO" }), /复现命令/);
});

test("confidenceInterval 倒序 / 越界 / 长度错被拒", () => {
  assert.match(reasonOf({ ...VALID, confidenceInterval: [0.9, 0.8] }), /下界/);
  assert.match(reasonOf({ ...VALID, confidenceInterval: [0.8, 1.2] }), /confidenceInterval/);
  assert.match(reasonOf({ ...VALID, confidenceInterval: [0.8] }), /confidenceInterval/);
});

test("tasks / repeat 非正整数被拒", () => {
  assert.match(reasonOf({ ...VALID, tasks: 0 }), /tasks/);
  assert.match(reasonOf({ ...VALID, repeat: 1.5 }), /repeat/);
});

// ---------------------------------------------------------------- schema 与保护面

test("schema 定义与校验器同源，不再只是文档常量", () => {
  assert.deepEqual([...EXTERNAL_RESULT_SCHEMA.required], [...EXTERNAL_REQUIRED]);
  assert.deepEqual([...EXTERNAL_RESULT_SCHEMA.optional], [...EXTERNAL_OPTIONAL]);
  assert.deepEqual([...EXTERNAL_RESULT_SCHEMA.forbidden], [...EXTERNAL_FORBIDDEN_FIELDS]);
  assert.equal(EXTERNAL_REQUIRED.length, 6);
  assert.equal(EXTERNAL_OPTIONAL.length, 5);
  assert.ok(EXTERNAL_RESULT_SCHEMA.constraints.score.includes("[0,1]"));
  assert.match(EXTERNAL_RESULT_SCHEMA.note, /未提供即视为未导入/);
});

test("外部结果校验器在写保护面内", () => {
  assert.ok(PROTECTED_FILES.includes("src/benchmark/external.ts"));
  assert.ok(PROTECTED_FILES.includes("src/benchmark/ladder.ts"));
  assert.ok(PROTECTED_FILES.includes("src/benchmark/scoring.ts"));
});

// ---------------------------------------------------------------- 文件级校验

test("文件不存在 = 未导入，且不算错误", () => {
  const root = tmpRoot();
  try {
    const v = loadExternalResults(join(root, "data/benchmark/external-results.json"));
    assert.equal(v.submitted, 0);
    assert.equal(v.accepted.length, 0);
    assert.equal(v.ok, true);
    assert.equal(v.fileErrors.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("顶层格式错 / 非法 JSON 记为文件级错误", () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, "data", "benchmark"), { recursive: true });
    const p = join(root, "data", "benchmark", "external-results.json");
    writeFileSync(p, JSON.stringify({ result: [] }));
    assert.match(loadExternalResults(p).fileErrors.join(" "), /顶层/);
    writeFileSync(p, "{not json");
    assert.match(loadExternalResults(p).fileErrors.join(" "), /JSON 解析失败/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("混合记录只采纳合法项，被拒项带索引与原因", () => {
  const root = tmpRoot();
  try {
    writeExternal(root, { results: [VALID, {}, VALID] });
    const v = loadExternalResults(join(root, "data/benchmark/external-results.json"));
    assert.equal(v.submitted, 3);
    assert.equal(v.accepted.length, 2);
    assert.equal(v.rejected.length, 1);
    assert.equal(v.rejected[0]!.index, 1);
    assert.equal(v.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 证据阶梯（关键）

test("伪造空记录不能把 L4 从 not-achieved 提上去", () => {
  const root = tmpRoot();
  try {
    writeExternal(root, { results: [{}] });
    const a = assessEvidenceLadder(root);
    assert.equal(a.levels.find((l) => l.id === 4)!.status, "not-achieved");
    assert.equal(a.externalValidation.accepted, 0);
    assert.equal(a.externalValidation.rejected.length, 1);
    assert.equal(a.claim.verdict, "not-proven");
    assert.equal(a.claim.externalBenchmarksImported, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("自带结论字段 / 未来日期的记录同样不能升级 L4", () => {
  const root = tmpRoot();
  try {
    writeExternal(root, { results: [
      { ...VALID, verdict: "proven" },
      { ...VALID, date: "2099-01-01" },
    ] });
    const a = assessEvidenceLadder(root);
    assert.equal(a.levels.find((l) => l.id === 4)!.status, "not-achieved");
    assert.equal(a.externalValidation.rejected.length, 2);
    assert.equal(a.claim.verdict, "not-proven");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("benchmark-report.json 手塞 external 不算外部证据", () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "benchmark-report.json"), JSON.stringify({
      ablation: [], external: [{ ...VALID, verdict: "proven" }],
    }));
    const a = assessEvidenceLadder(root);
    assert.equal(a.levels.find((l) => l.id === 4)!.status, "not-achieved");
    assert.equal(a.claim.externalBenchmarksImported, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("合法外部结果只把 L4 提到 partial，verdict 仍恒为 not-proven", () => {
  const root = tmpRoot();
  try {
    writeExternal(root, { results: [VALID, { ...VALID, benchmark: "tau-bench", score: 0.79 }] });
    const a = assessEvidenceLadder(root);
    assert.equal(a.levels.find((l) => l.id === 4)!.status, "partial");
    assert.equal(a.externalValidation.accepted, 2);
    assert.deepEqual(a.externalValidation.benchmarks.sort(), ["BFCL-v3", "tau-bench"]);
    assert.equal(a.claim.verdict, "not-proven");
    assert.equal(a.claim.externalBenchmarksImported, 2);
    assert.match(a.levels.find((l) => l.id === 4)!.gap, /第三方/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
