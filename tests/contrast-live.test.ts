/**
 * P1 · 对比式改进接入 live RSI（无真值 verifier）单测。
 *
 * 验证 ROADMAP P1 的验收标准：
 *  - 接受「修复了具体失败模式」的改动；
 *  - 拒绝「仅提升分数但没解掉失败」的改动（防 reward hacking）；
 *  - 协议违规候选直接拒绝（治理不变量）；
 *  - 多轮累积仍收敛、且全程不依赖真值标签。
 * 关键：scoreGain（自报分数提升）绝不参与接受判定。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvalRunMetrics } from "../src/observability/eval.ts";
import {
  toRunSummary, baselineFromRuns, evaluateLiveCandidates,
  LiveContrastVerifier,
} from "../src/rsi/live-contrast.ts";
import type { LiveCandidate, RunSummary } from "../src/rsi/index.ts";

const metrics = (over: Partial<EvalRunMetrics> = {}): EvalRunMetrics => ({
  taskId: "t", category: "robustness", repeat: 0, ok: true, reasons: [],
  stoppedBy: "completed", steps: 2, toolCalls: 1, toolErrors: 0,
  guards: 0, approvalsDenied: 0, compactions: 0, protocolViolations: 0,
  repairs: 0, groundingRejects: 0, loopAdvisories: 0, compactionEvidence: 0,
  tokens: 10, latencyMs: 1, provider: "mock", answer: "ok",
  ...over,
});

const base = (over: Partial<RunSummary> = {}): RunSummary => ({
  steps: 2, toolCalls: 0, toolErrors: 0, loopAdvisories: 0,
  groundingRejects: 0, protocolViolations: 0, missingTool: true, answerMatches: false,
  ...over,
});

const cand = (
  id: string, focus: LiveCandidate["focus"], probed: RunSummary, scoreGain?: number,
): LiveCandidate => ({
  id, description: id, focus, probed, ...(scoreGain !== undefined ? { scoreGain } : {}),
});

// ---------------------------------------------------------------- 轨迹适配
test("toRunSummary：把真实 EvalRunMetrics 归一化为行为摘要（无真值标签）", () => {
  const s = toRunSummary(metrics({ toolCalls: 0, toolErrors: 2, loopAdvisories: 1, protocolViolations: 0 }));
  assert.equal(s.missingTool, true, "零工具调用应标记为 missingTool");
  assert.equal(s.toolErrors, 2);
  assert.equal(s.loopAdvisories, 1);
  assert.equal(s.answerMatches, false, "开放世界缺省不提供真值命中");
});

test("baselineFromRuns：聚合一批任务为域级基线；空批次退化为全零基线", () => {
  const agg = baselineFromRuns([
    metrics({ toolErrors: 1, toolCalls: 1 }),
    metrics({ toolErrors: 2, toolCalls: 1, loopAdvisories: 3 }),
  ]);
  assert.equal(agg.toolErrors, 3);
  assert.equal(agg.loopAdvisories, 3);
  assert.equal(agg.missingTool, false);
  const empty = baselineFromRuns([]);
  assert.equal(empty.toolCalls, 0);
  assert.equal(empty.missingTool, true);
});

// ---------------------------------------------------------------- 行为对比判定
test("接受：修复 missing-tool 的改动（基线零工具→探测轮调用工具）", () => {
  const baseline = base();
  const good = cand("fix-tool", "missing-tool", base({ toolCalls: 2, missingTool: false }));
  const r = evaluateLiveCandidates(baseline, [good]);
  assert.equal(r.decisions[0]!.accepted, true);
  assert.match(r.decisions[0]!.evidence, /行为对比成立/);
});

test("防 reward hacking：自报高分数提升但无行为对比 → 拒绝并标记拦截", () => {
  const baseline = base();
  // 分数涨了，但 missing-tool 没修好（探测轮仍零工具）
  const gaming = cand("score-only", "missing-tool", base(), 0.9);
  const r = evaluateLiveCandidates(baseline, [gaming]);
  const d = r.decisions[0]!;
  assert.equal(d.accepted, false, "分数不得影响判定");
  assert.equal(d.scoreGain, 0.9);
  assert.equal(d.rewardHackingBlocked, true);
  assert.equal(r.rewardHackingBlocked, 1);
  assert.ok(r.evidence.some((e) => e.includes("reward hacking")));
});

test("分数提升不影响「真修复」的接受：好改动即便 scoreGain=0 仍被接受", () => {
  const baseline = base();
  const good = cand("real-fix", "missing-tool", base({ toolCalls: 1, missingTool: false }), 0);
  const gaming = cand("fake-fix", "missing-tool", base(), 0.99);
  const r = evaluateLiveCandidates(baseline, [good, gaming]);
  assert.equal(r.decisions.find((d) => d.id === "real-fix")!.accepted, true);
  assert.equal(r.decisions.find((d) => d.id === "fake-fix")!.accepted, false);
});

test("治理不变量：探测轮出现协议违规 → 直接拒绝", () => {
  const baseline = base();
  const bad = cand("protocol-bad", "missing-tool", base({ toolCalls: 1, missingTool: false, protocolViolations: 1 }));
  const r = evaluateLiveCandidates(baseline, [bad]);
  assert.equal(r.decisions[0]!.accepted, false);
  assert.match(r.decisions[0]!.evidence, /协议违规/);
});

test("拒绝：探测轮未修复焦点失败模式（loop 告警未下降）", () => {
  const baseline = base({ loopAdvisories: 3, missingTool: false });
  const noop = cand("noop", "loop", base({ loopAdvisories: 3, missingTool: false }));
  const r = evaluateLiveCandidates(baseline, [noop]);
  assert.equal(r.decisions[0]!.accepted, false);
});

// ---------------------------------------------------------------- 多轮收敛
test("LiveContrastVerifier：多轮累积不靠真值标签收敛，完整性 OK", () => {
  const v = new LiveContrastVerifier();
  // 轮 1：真修复被接受、伪修复被拒
  v.probe(base(), [
    cand("r1-fix", "missing-tool", base({ toolCalls: 1, missingTool: false })),
    cand("r1-gaming", "tool-error", base({ missingTool: false }), 0.5),
  ]);
  // 轮 2：工具错误下降被接受；另一个伪修复被拒
  v.probe(base({ toolErrors: 3, missingTool: false }), [
    cand("r2-fix", "tool-error", base({ toolErrors: 1, missingTool: false })),
    cand("r2-gaming", "tool-error", base({ toolErrors: 3, missingTool: false }), 0.8),
  ]);

  const rep = v.report();
  assert.equal(rep.rounds, 2);
  assert.equal(rep.usedGroundTruthVerifier, false, "全程不依赖真值 verifier");
  assert.deepEqual(rep.accepted.sort(), ["r1-fix", "r2-fix"]);
  assert.deepEqual(rep.rejected.sort(), ["r1-gaming", "r2-gaming"]);
  assert.equal(rep.rewardHackingBlocked, 2);
  assert.equal(rep.integrity.ok, true, `完整性应 OK：${rep.integrity.reasons.join("; ")}`);
  assert.equal(rep.decisions.length, 4);
});

test("LiveContrastVerifier：所有被接受项都带正向行为变化（无「分数驱动」晋升）", () => {
  const v = new LiveContrastVerifier();
  const d = v.probe(base(), [
    cand("a", "missing-tool", base({ toolCalls: 3, missingTool: false })),
    cand("b", "missing-tool", base(), 1.0),
  ]);
  const rep = v.report();
  assert.equal(d[0]!.accepted, true);
  assert.equal(d[1]!.accepted, false);
  assert.equal(rep.accepted.length, 1);
  assert.ok(rep.integrity.ok);
});
