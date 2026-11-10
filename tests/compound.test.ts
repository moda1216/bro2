/**
 * v2.1.0 · 复利中枢单测（两大设计目标的可证伪落点）
 *
 * 目标 1「越用改进越快」：经验库裁剪探测集 → attempts 下降、firstTryHit 上升，
 *   且**不改判定**（防 reward hacking 复用）、经验不灵必回退、OOD 可失效。
 * 目标 2「越用越省/越稳」：学习型路由把原本走远程的请求压到本地，
 *   远程失败→本地兜底的经验跨会话累积并反哺成本。
 *
 * 全部用临时目录，不污染仓库运行时账本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExperienceBank, failureSignature, requestSignature, endpointSignature,
} from "../src/rsi/experience.ts";
import { VelocityLedger, MIN_SAMPLES } from "../src/rsi/velocity.ts";
import { compoundProbe } from "../src/rsi/contrast.ts";
import { LearnedRoutePolicy } from "../src/models/route-experience.ts";
import type { LLMRequest } from "../src/models/base.ts";
import type { LiveCandidate, RunSummary } from "../src/rsi/index.ts";

let seq = 0;
const tmp = (name: string): string =>
  join(mkdtempSync(join(tmpdir(), "bro2-compound-")), `${name}-${seq++}.jsonl`);

const baseline = (over: Partial<RunSummary> = {}): RunSummary => ({
  steps: 10, toolCalls: 3, toolErrors: 4, loopAdvisories: 2,
  groundingRejects: 0, protocolViolations: 0, missingTool: false, answerMatches: false,
  ...over,
});

const cand = (
  id: string, focus: LiveCandidate["focus"], probed: RunSummary, scoreGain?: number,
): LiveCandidate => ({ id, description: id, focus, probed, ...(scoreGain !== undefined ? { scoreGain } : {}) });

/** 真修复：工具错误 4→0、循环告警 2→0；伪修复：只自报加分不改行为。 */
const candidates = (): LiveCandidate[] => [
  cand("fake-gain", "tool-error", baseline(), 0.6),
  cand("no-op", "loop", baseline()),
  cand("fix-real", "tool-error", baseline({ toolErrors: 0, loopAdvisories: 0, toolCalls: 4, steps: 8 })),
];

const tools = [{ name: "echo", description: "echo", parameters: { type: "object" } }] as unknown as LLMRequest["tools"];
const mkReq = (lastRole: "user" | "tool", n = 3): LLMRequest => ({
  messages: Array.from({ length: n }, (_, i) => ({
    role: (i === n - 1 ? lastRole : "user") as LLMRequest["messages"][number]["role"],
    content: "短内容",
  })),
  tools,
});

// ---------------------------------------------------------------- A. 指纹
test("failureSignature：相同失败模式 → 相同指纹，且不编码任务 id / 答案", () => {
  const a = failureSignature(baseline());
  const b = failureSignature(baseline({ steps: 99, answerMatches: true }));
  assert.equal(a, b, "steps 与 answerMatches 不应进入指纹");
  assert.ok(!a.includes("t-") && !a.includes("answer"), "指纹不得含任务或真值信息");
  assert.notEqual(a, failureSignature(baseline({ protocolViolations: 1 })));
});

test("requestSignature：只取任务结构、不含末条角色，使经验有机会覆盖启发式", () => {
  const a = requestSignature(mkReq("user"));
  const b = requestSignature(mkReq("tool"));
  assert.equal(a, b, "末条角色刻意不进指纹，否则经验无法覆盖 cheapToLocalPolicy");
  assert.equal(a, requestSignature({ ...mkReq("user"), messages: [
    { role: "user", content: "完全不同的另一段短文本" },
    { role: "user", content: "短" },
    { role: "user", content: "短" },
  ] }), "内容文本不得进入指纹（防记忆任务集）");
  assert.notEqual(a, requestSignature({ ...mkReq("user"), tools: [] }));
});

// ---------------------------------------------------------------- B. 经验库
test("ExperienceBank：事件式只增，新建实例即可读到历史（跨会话）", () => {
  const path = tmp("bank");
  const b1 = new ExperienceBank(path);
  b1.observeOutcome("harness-edit", "F:x", "edit-1", "success");
  b1.observeOutcome("harness-edit", "F:x", "edit-1", "success");
  const b2 = new ExperienceBank(path);
  assert.equal(b2.events().length, 2);
  assert.equal(b2.fold()[0].successes, 2);
  assert.equal(b1.stats().events, 2);
});

test("fold / invalidate：失效只增记录、不删历史，OOD 退化后经验不再可复用", () => {
  const b = new ExperienceBank(tmp("inval"));
  b.observeOutcome("harness-edit", "F:x", "edit-1", "success");
  assert.equal(b.retrieve("harness-edit", "F:x").length, 1);
  b.invalidate("harness-edit", "F:x", "edit-1", "OOD 任务集上出现回归");
  assert.equal(b.retrieve("harness-edit", "F:x").length, 0);
  assert.equal(b.events().length, 2, "失效不删除历史");
  assert.equal(b.stats().invalidated, 1);
});

test("retrieve：拒绝净成功非正与已失效的经验；prioritize 只重排不增减候选", () => {
  const b = new ExperienceBank(tmp("prio"));
  b.observeOutcome("harness-edit", "F:x", "good", "success");
  b.observeOutcome("harness-edit", "F:x", "good", "success");
  b.observeOutcome("harness-edit", "F:x", "bad", "failure");
  b.observeOutcome("harness-edit", "F:x", "bad", "failure");
  b.observeOutcome("harness-edit", "F:x", "bad", "success");
  const usable = b.retrieve("harness-edit", "F:x");
  assert.deepEqual(usable.map((e) => e.prescription), ["good"]);
  const cs = ["a", "bad", "good", "b"];
  const p = b.prioritize("harness-edit", "F:x", cs, (x) => x);
  assert.equal(p.prioritized.length + p.deferred.length, cs.length, "不得增减候选");
  assert.equal(p.prioritized[0], "good", "经验命中的应排最前");
  assert.equal(p.hits, 1);
  const cut = b.prioritize("harness-edit", "F:x", cs, (x) => x, 2);
  assert.equal(cut.prioritized.length, 2);
  assert.equal(cut.deferred.length, 2);
});

// ---------------------------------------------------------------- C. 复利闭环
test("compoundProbe 冷启动：无经验时全量探测，autoPruned=false", () => {
  const r = compoundProbe(
    baseline(), candidates(), new ExperienceBank(tmp("cold")), new VelocityLedger(tmp("v1")),
  );
  assert.equal(r.attempts, 3);
  assert.equal(r.autoPruned, false);
  assert.equal(r.improvement, 1);
  assert.deepEqual(r.decisions.filter((d) => d.accepted).map((d) => d.id), ["fix-real"]);
  assert.equal(r.rewardHackingBlocked, 1, "伪修复被记一次 reward hacking");
});

test("compoundProbe 复利：同一指纹第二次自动裁剪，attempts 下降且首轮命中", () => {
  const bp = tmp("bank2");
  const vp = tmp("v2");
  const first = compoundProbe(baseline(), candidates(), new ExperienceBank(bp), new VelocityLedger(vp));
  const second = compoundProbe(baseline(), candidates(), new ExperienceBank(bp), new VelocityLedger(vp));
  assert.equal(first.autoPruned, false);
  assert.equal(second.autoPruned, true);
  assert.ok(second.attempts < first.attempts, "有经验后探测次数必须下降");
  assert.ok(second.probesAvoided > 0);
  assert.equal(second.firstTryHit, true);
  assert.equal(second.improvement, 1, "裁剪不得牺牲正确性");
  assert.equal(second.usedFallback, false);
  // 探索位刻意保留 1 个非经验候选，恰好是伪修复：它被探测但照样被行为判定拦截
  assert.equal(second.effectiveTopK, 2);
  assert.equal(second.rewardHackingBlocked, 1, "经验裁剪不改变判定，伪修复仍被拦");
  assert.equal(second.decisions.find((d) => d.id === "fake-gain")?.accepted, false);
});

test("防 reward hacking 复用：被污染的经验库也无法让伪修复通过行为判定", () => {
  const b = new ExperienceBank(tmp("poison"));
  const sig = failureSignature(baseline());
  // 模拟经验库被误导：把「伪修复」写成多次成功
  for (let i = 0; i < 4; i += 1) b.observeOutcome("harness-edit", sig, "fake-gain", "success");
  const r = compoundProbe(baseline(), candidates(), b, new VelocityLedger(tmp("v3")), { signature: sig });
  const fake = r.decisions.find((d) => d.id === "fake-gain");
  assert.equal(fake?.accepted, false, "经验只影响探测顺序，绝不改变判定");
  assert.equal(fake?.rewardHackingBlocked, true);
  assert.equal(r.improvement, 1, "真修复仍被找到");
  const after = b.fold().find((e) => e.prescription === "fake-gain");
  assert.ok((after?.failures ?? 0) >= 1, "伪修复被判失败并留痕，不写入成功经验");
});

test("经验不灵必回退：首批无接受项时探测 deferred，不硬信经验", () => {
  const b = new ExperienceBank(tmp("fallback"));
  const sig = failureSignature(baseline());
  for (let i = 0; i < 3; i += 1) b.observeOutcome("harness-edit", sig, "no-op", "success");
  const r = compoundProbe(baseline(), candidates(), b, new VelocityLedger(tmp("v4")), { signature: sig });
  assert.equal(r.usedFallback, true);
  assert.deepEqual(r.decisions.filter((d) => d.accepted).map((d) => d.id), ["fix-real"]);
  assert.equal(r.attempts, 3, "回退后仍探测全部候选");
});

test("经验回写只由行为判定驱动：接受记 success、拒绝记 failure", () => {
  const b = new ExperienceBank(tmp("writeback"));
  compoundProbe(baseline(), candidates(), b, new VelocityLedger(tmp("v5")));
  const byId = new Map(b.fold().map((e) => [e.prescription, e]));
  assert.equal(byId.get("fix-real")?.successes, 1);
  assert.equal(byId.get("fix-real")?.failures, 0);
  assert.equal(byId.get("fake-gain")?.successes, 0);
  assert.ok((byId.get("fake-gain")?.failures ?? 0) >= 1);
});

test("OOD 失效后不再裁剪：探测集恢复全量（防过拟合）", () => {
  const bp = tmp("ood");
  const vp = tmp("v6");
  const sig = failureSignature(baseline());
  const b = new ExperienceBank(bp);
  compoundProbe(baseline(), candidates(), b, new VelocityLedger(vp), { signature: sig });
  b.invalidate("harness-edit", sig, "fix-real", "OOD 回归");
  const after = compoundProbe(baseline(), candidates(), new ExperienceBank(bp), new VelocityLedger(vp), { signature: sig });
  assert.equal(after.autoPruned, false);
  assert.equal(after.attempts, 3);
});

// ---------------------------------------------------------------- D. 冻结速度度量
test("VelocityLedger：样本不足一律 insufficient-data，绝不宣称加速", () => {
  const l = new VelocityLedger(tmp("v7"));
  for (let i = 0; i < MIN_SAMPLES - 1; i += 1) {
    l.append({ attempts: 1, experienceHits: 1, firstTryHit: true, improvement: 1, probesAvoided: 3, usedFallback: false, protocolViolations: 0 });
  }
  const s = l.snapshot();
  assert.equal(s.trend, "insufficient-data");
  assert.equal(s.honesty.selfReported, false);
  assert.equal(s.honesty.frozenMetric, true);
});

test("VelocityLedger：真实成本下降才判 accelerating，协议违规轮被排除", () => {
  const l = new VelocityLedger(tmp("v8"));
  for (let i = 0; i < 3; i += 1) {
    l.append({ attempts: 3, experienceHits: 0, firstTryHit: false, improvement: 1, probesAvoided: 0, usedFallback: false, protocolViolations: 0 });
  }
  for (let i = 0; i < 3; i += 1) {
    l.append({ attempts: 2, experienceHits: 1, firstTryHit: true, improvement: 1, probesAvoided: 1, usedFallback: false, protocolViolations: 0 });
  }
  l.append({ attempts: 1, experienceHits: 0, firstTryHit: false, improvement: 0, probesAvoided: 0, usedFallback: false, protocolViolations: 2 });
  const s = l.snapshot();
  assert.equal(s.samples, 7);
  assert.equal(s.usableSamples, 6, "协议违规轮不计入趋势");
  assert.equal(s.trend, "accelerating");
  assert.ok(s.secondHalfIPA > s.firstHalfIPA);
  assert.ok(s.avgAttempts > 0);
});

test("VelocityLedger：成本恶化时判 decelerating / flat，不粉饰", () => {
  const l = new VelocityLedger(tmp("v9"));
  for (let i = 0; i < 3; i += 1) {
    l.append({ attempts: 1, experienceHits: 1, firstTryHit: true, improvement: 1, probesAvoided: 3, usedFallback: false, protocolViolations: 0 });
  }
  for (let i = 0; i < 3; i += 1) {
    l.append({ attempts: 5, experienceHits: 0, firstTryHit: false, improvement: 1, probesAvoided: 0, usedFallback: true, protocolViolations: 0 });
  }
  assert.notEqual(l.snapshot().trend, "accelerating");
});

// ---------------------------------------------------------------- E. 学习型路由
test("LearnedRoutePolicy 冷启动：证据不足时回退启发式，不贸然压本地", () => {
  const p = new LearnedRoutePolicy(new ExperienceBank(tmp("rt1")));
  assert.equal(p.decide(mkReq("user"), { turn: 0 }), "remote");
  assert.equal(p.stats().localFromExperience, 0);
  assert.equal(p.stats().remote, 1);
});

test("LearnedRoutePolicy 越用越省：累积本地成功经验后覆盖启发式的远程决策", () => {
  const path = tmp("rt2");
  const p = new LearnedRoutePolicy(new ExperienceBank(path));
  for (let i = 0; i < 3; i += 1) p.observe(mkReq("tool"), "local", true);
  assert.equal(p.decide(mkReq("user"), { turn: 1 }), "local", "原本启发式走 remote 的请求被经验压到本地");
  assert.equal(p.stats().localFromExperience, 1);
  assert.ok(p.stats().remoteAvoided >= 1);
  // 跨会话：新实例读同一账本仍能复用
  const p2 = new LearnedRoutePolicy(new ExperienceBank(path));
  assert.equal(p2.decide(mkReq("user"), { turn: 0 }), "local");
});

test("远程失败→本地兜底：remote failure 与 local success 同时留痕并反哺成本", () => {
  const path = tmp("rt3");
  const p = new LearnedRoutePolicy(new ExperienceBank(path));
  const sig = requestSignature(mkReq("user"));
  p.observe(mkReq("user"), "remote", true, true);
  const entry = new ExperienceBank(path).fold()
    .filter((e) => e.domain === "routing" && e.signature === sig);
  const remote = entry.find((e) => e.prescription === "remote");
  const local = entry.find((e) => e.prescription === "local");
  assert.equal(remote?.failures, 1);
  assert.equal(local?.successes, 1);
  assert.equal(p.stats().fallbacks, 1);
  assert.ok(p.stats().remoteAvoided >= 1);
});

test("端点质量经验跨会话累积（补充 KeylessAggregator 的进程内健康态）", () => {
  const path = tmp("ep");
  const p = new LearnedRoutePolicy(new ExperienceBank(path));
  p.endpointOutcome("kilo", true, 300);
  p.endpointOutcome("kilo", false, 9000);
  p.endpointOutcome("pollinations", true, 1200);
  const q = new LearnedRoutePolicy(new ExperienceBank(path)).endpointQuality("kilo");
  assert.equal(q.samples, 2);
  assert.equal(q.successes, 1);
  assert.equal(q.rate, 0.5);
  assert.equal(endpointSignature("Kilo"), endpointSignature("kilo"), "端点名归一化");
});
