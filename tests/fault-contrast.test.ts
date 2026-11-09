/**
 * 确定性故障对照判定的行为契约（v2.9.0）：
 * 1. 正常的成败级 / 效率级对照被接受；
 * 2. 哑弹故障、注入未打完、机制计数器为零 → 一律拒绝（v2.7 教训固化）；
 * 3. 唯一变量被破坏（公共配置 / 任务哈希不一致、变量取值相同）→ 拒绝；
 * 4. 机制关侧也通过、协议违规 → 拒绝；
 * 5. 自报增益字段绝不参与判定（防 reward hacking）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeContrast } from "../src/observability/eval-grade.ts";
import type { ContrastSpec } from "../src/observability/eval-grade.ts";
import type { EvalRunMetrics } from "../src/observability/eval.ts";

function mkRun(patch: Partial<EvalRunMetrics> = {}): EvalRunMetrics {
  return {
    taskId: "t", category: "robustness", repeat: 0, ok: true, reasons: [],
    stoppedBy: "completed", steps: 2, toolCalls: 1, toolErrors: 0, guards: 0,
    approvalsDenied: 0, compactions: 0, protocolViolations: 0, repairs: 0,
    groundingRejects: 0, loopAdvisories: 0, compactionEvidence: 0, tools: { calc: 1 },
    providerRetries: 0, faultsInjected: 2, emptyGuardHits: 0, tokens: 100,
    latencyMs: 1, provider: "mock", answer: "完成：工具结果已确认", ...patch,
  };
}

const passSpec = (patch: Partial<ContrastSpec> = {}): ContrastSpec => ({
  id: "retry", mechanism: "retry", effect: "pass", times: 2,
  variableOn: 3, variableOff: 0,
  sharedHashOn: "same", sharedHashOff: "same",
  taskHashOn: "task", taskHashOff: "task", ...patch,
});

/** 成败级 standard 样本：机制开通过、关失败，重试计数真实。 */
const passOn = () => mkRun({ providerRetries: 2 });
const passOff = () => mkRun({ ok: false, answer: "", stoppedBy: "exception", faultsInjected: 1 });

test("成败级对照：机制开通过、关失败，重试计数真实 → 接受", () => {
  const v = judgeContrast(passSpec(), passOn(), passOff());
  assert.equal(v.accepted, true, v.reasons.join("; "));
  assert.deepEqual(v.reasons, []);
});

test("效率级对照（repair）：两侧都完成，只差 repairs/toolErrors → 接受", () => {
  const spec = passSpec({ id: "repair", mechanism: "repair", effect: "efficiency", times: 1, variableOn: "repair", variableOff: "fail" });
  const v = judgeContrast(spec,
    mkRun({ faultsInjected: 1, repairs: 1, toolErrors: 0 }),
    mkRun({ faultsInjected: 1, repairs: 0, toolErrors: 1 }));
  assert.equal(v.accepted, true, v.reasons.join("; "));
});

test("哑弹故障：两侧都没实际注入 → 拒绝，且不误判为『机制无效』", () => {
  const v = judgeContrast(passSpec(), mkRun({ providerRetries: 2, faultsInjected: 0 }), mkRun({ ok: false, answer: "", faultsInjected: 0 }));
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => r.includes("哑弹")));
});

test("机制开侧注入未打完（1/2）→ 拒绝，恢复结论不可信", () => {
  const v = judgeContrast(passSpec(), mkRun({ providerRetries: 1, faultsInjected: 1 }), passOff());
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => r.includes("注入未打完")));
});

test("机制计数器为零 / 关侧未归零 → 拒绝（差异不能只是波动）", () => {
  const v1 = judgeContrast(passSpec(), mkRun({ providerRetries: 0 }), passOff());
  assert.equal(v1.accepted, false);
  assert.ok(v1.reasons.some((r) => r.includes("重试计数")));
  const v2 = judgeContrast(passSpec(), passOn(), mkRun({ ok: false, answer: "", faultsInjected: 1, providerRetries: 1 }));
  assert.equal(v2.accepted, false);
  assert.ok(v2.reasons.some((r) => r.includes("机制关侧仍有")));
});

test("唯一变量被破坏 → 全部拒绝", () => {
  const cases = [
    passSpec({ sharedHashOn: "a", sharedHashOff: "b" }),
    passSpec({ taskHashOn: "a", taskHashOff: "b" }),
    passSpec({ variableOn: 3, variableOff: 3 }),
  ];
  for (const spec of cases) {
    const v = judgeContrast(spec, passOn(), passOff());
    assert.equal(v.accepted, false);
    assert.ok(v.reasons.length > 0);
  }
});

test("机制关侧也通过（成败级）→ 差异不存在，拒绝", () => {
  const v = judgeContrast(passSpec(), passOn(), mkRun({ faultsInjected: 1 }));
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => r.includes("差异不存在")));
});

test("效率级对照有一侧失败 → 拒绝（不许把通过率差异粉饰成效率）", () => {
  const spec = passSpec({ mechanism: "repair", effect: "efficiency", times: 1, variableOn: "repair", variableOff: "fail" });
  const v = judgeContrast(spec,
    mkRun({ faultsInjected: 1, repairs: 1 }),
    mkRun({ ok: false, answer: "", faultsInjected: 1, toolErrors: 1 }));
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => r.includes("两侧都应完成")));
});

test("empty-guard：守卫计数为零 / 关侧仍命中 → 拒绝", () => {
  const spec = passSpec({ id: "empty-guard", mechanism: "empty-guard" });
  const v1 = judgeContrast(spec, mkRun({ emptyGuardHits: 0, providerRetries: 2 }), passOff());
  assert.equal(v1.accepted, false);
  const v2 = judgeContrast(spec, mkRun({ emptyGuardHits: 2, providerRetries: 2 }), mkRun({ ok: false, answer: "", faultsInjected: 1, emptyGuardHits: 1 }));
  assert.equal(v2.accepted, false);
});

test("repair：开侧未修复 / 关侧无工具错误 → 拒绝", () => {
  const spec = passSpec({ id: "repair", mechanism: "repair", effect: "efficiency", times: 1, variableOn: "repair", variableOff: "fail" });
  const v = judgeContrast(spec,
    mkRun({ faultsInjected: 1, repairs: 0, toolErrors: 1 }),
    mkRun({ faultsInjected: 1, repairs: 0, toolErrors: 0 }));
  assert.equal(v.accepted, false);
  assert.equal(v.reasons.length, 2);
});

test("协议违规 → 治理不变量优先，直接拒绝", () => {
  const v = judgeContrast(passSpec(), mkRun({ providerRetries: 2, protocolViolations: 1 }), passOff());
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => r.includes("协议违规")));
});

test("自报增益字段绝不参与判定：塞 scoreGain 不改变结论", () => {
  const clean = judgeContrast(passSpec(), passOn(), passOff());
  const withSelfReport = judgeContrast(
    { ...passSpec(), scoreGain: 999, selfReportedImprovement: true } as ContrastSpec,
    passOn(), passOff(),
  );
  assert.equal(withSelfReport.accepted, clean.accepted);
  assert.deepEqual(withSelfReport.reasons, clean.reasons);
  // 反例：只抬分数、没有行为对比，仍然拒绝
  const fake = judgeContrast(passSpec(), mkRun({ providerRetries: 0 }), mkRun({ faultsInjected: 1 }));
  assert.equal(fake.accepted, false);
});
