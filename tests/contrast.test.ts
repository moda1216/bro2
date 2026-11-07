import { test } from "node:test";
import assert from "node:assert/strict";
import {
  behavioralContrast,
  proposeProbeCompose,
  failureSignals,
  type RunSummary,
} from "../src/rsi/contrast.ts";

const base: RunSummary = {
  steps: 1,
  toolCalls: 0,
  toolErrors: 0,
  loopAdvisories: 3,
  groundingRejects: 0,
  protocolViolations: 0,
  missingTool: true,
  answerMatches: false,
};

test("failureSignals 从摘要推导失败信号", () => {
  const s = failureSignals(base);
  assert.ok(s.includes("missing-tool"));
  assert.ok(s.includes("loop"));
  assert.ok(s.includes("answer"));
});

test("missing-tool：探测轮调用了工具 → 行为对比成立", () => {
  const probed: RunSummary = { ...base, toolCalls: 1, missingTool: false };
  const r = behavioralContrast(base, probed, "missing-tool");
  assert.equal(r.contrast, true);
  assert.match(r.evidence, /调用了 1 次工具/);
});

test("missing-tool：探测轮仍不调用工具 → 不成立（不靠分数刷分）", () => {
  const probed: RunSummary = { ...base, toolCalls: 0, missingTool: true };
  const r = behavioralContrast(base, probed, "missing-tool");
  assert.equal(r.contrast, false);
});

test("loop：循环告警下降 → 成立", () => {
  const probed: RunSummary = { ...base, loopAdvisories: 0 };
  const r = behavioralContrast(base, probed, "loop");
  assert.equal(r.contrast, true);
});

test("loop：告警未下降 → 不成立", () => {
  const probed: RunSummary = { ...base, loopAdvisories: 3 };
  const r = behavioralContrast(base, probed, "loop");
  assert.equal(r.contrast, false);
});

test("探测轮出现协议违规 → 一律拒绝（守住治理不变量）", () => {
  const probed: RunSummary = { ...base, toolCalls: 1, missingTool: false, protocolViolations: 1 };
  const r = behavioralContrast(base, probed, "missing-tool");
  assert.equal(r.contrast, false);
  assert.match(r.evidence, /协议违规/);
});

test("探测轮引入新失败模式 → 拒绝（防止拆东墙补西墙）", () => {
  const probed: RunSummary = {
    ...base,
    toolCalls: 1,
    missingTool: false,
    toolErrors: 2, // 基线没有 tool-error，这是新引入的失败
  };
  const r = behavioralContrast(base, probed, "missing-tool");
  assert.equal(r.contrast, false);
  assert.match(r.evidence, /新的失败模式/);
});

test("proposeProbeCompose：只保留行为对比成立的候选", () => {
  const candidates = [
    { id: "c-good", description: "启用工具调用指导", focus: "missing-tool" as const, probed: { ...base, toolCalls: 2, missingTool: false } },
    { id: "c-bad", description: "只把分数刷高", focus: "answer" as const, probed: { ...base, answerMatches: false } },
    { id: "c-loop", description: "收敛循环", focus: "loop" as const, probed: { ...base, loopAdvisories: 0 } },
  ];
  const out = proposeProbeCompose(base, candidates);
  assert.deepEqual(out.accepted.map((c) => c.id), ["c-good", "c-loop"]);
  assert.deepEqual(out.rejected.map((x) => x.candidate.id), ["c-bad"]);
  assert.equal(out.evidence.length, 3);
});

test("无需真值标签即可判定：answerMatches 仅作为焦点信号，不参与计分", () => {
  // 即使基线/探测都没有真值（answerMatches=false），missing-tool 修复仍可被接受
  const probed: RunSummary = { ...base, toolCalls: 1, missingTool: false, answerMatches: false };
  const r = behavioralContrast(base, probed, "missing-tool");
  assert.equal(r.contrast, true);
});
