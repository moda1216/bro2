/**
 * bro2 · 预算软预警契约（v2.31.0）
 *
 * 外部实测（docs/TRAJECTORY-ANALYSIS.md 修正记录）发现：硬熔断是静默的，
 * 模型常在「已完成推理、尚未写出产出文件」的一步被累计 token 截断。
 * 软预警在硬熔断前注入一次收尾提示，但**绝不放宽任何预算**。
 * 本测试把「不放宽」钉死：预警不改变阈值、不重置计数、不阻止随后的熔断。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Guards, newGuardState } from "../src/governance/guards.ts";

const cfg = (over: Record<string, unknown> = {}) => ({
  maxSteps: 10, maxTokens: 1000, maxSeconds: 600, loopDetectionThreshold: 3,
  ...over,
});

test("缺省（不配置）时关闭：A/B 未证明增益，默认行为必须等价于改动前", () => {
  const g = new Guards(cfg());
  const s = newGuardState(1);
  s.totalTokens = 900;
  s.steps = 9;
  const v = g.check(s);
  assert.equal(v.ok, true);
  assert.equal(v.advisory, undefined);
  assert.equal(s.budgetAdvisoryFired, false);
});

test("关闭（ratio=0）时不产生任何预警，且不影响正常检查", () => {
  const g = new Guards(cfg({ budgetAdvisoryRatio: 0 }));
  const s = newGuardState(1);
  s.totalTokens = 900; // 90% 累计 token
  s.steps = 9; // 90% 步数
  const v = g.check(s);
  assert.equal(v.ok, true);
  assert.equal(v.advisory, undefined);
  assert.equal(s.budgetAdvisoryFired, false);
});

test("显式开启 ratio=0.8：累计 token 接近上限时预警一次，且整轮仅一次", () => {
  const g = new Guards(cfg({ budgetAdvisoryRatio: 0.8 }));
  const s = newGuardState(1);
  s.totalTokens = 800;
  const v1 = g.check(s);
  assert.equal(v1.ok, true, "预警不是熔断");
  assert.equal(v1.advisory, true);
  assert.equal(v1.kind, "tokens");
  assert.equal(s.budgetAdvisoryFired, true);
  const v2 = g.check(s);
  assert.equal(v2.advisory, undefined, "整轮只注入一次，防止每步重复污染上下文");
});

test("步数接近上限同样触发（不依赖 token 计数口径）", () => {
  const g = new Guards(cfg({ budgetAdvisoryRatio: 0.8 }));
  const s = newGuardState(1);
  s.steps = 8;
  const v = g.check(s);
  assert.equal(v.advisory, true);
  assert.equal(v.kind, "steps");
});

test("预警不重置计数、不放宽预算：随后仍按原阈值硬熔断", () => {
  const g = new Guards(cfg({ budgetAdvisoryRatio: 0.8 }));
  const s = newGuardState(1);
  s.totalTokens = 800;
  s.steps = 8;
  assert.equal(g.check(s).advisory, true);
  assert.equal(s.totalTokens, 800, "预警不得清零累计 token");
  assert.equal(s.steps, 8, "预警不得清零步数");
  s.totalTokens = 1000;
  const hard = g.check(s);
  assert.equal(hard.ok, false, "超过上限仍必须熔断");
  assert.equal(hard.kind, "tokens");
});

test("未接近阈值时不预警（不干扰短任务）", () => {
  const g = new Guards(cfg({ budgetAdvisoryRatio: 0.8 }));
  const s = newGuardState(1);
  s.totalTokens = 100;
  s.steps = 1;
  const v = g.check(s);
  assert.equal(v.ok, true);
  assert.equal(v.advisory, undefined);
});
