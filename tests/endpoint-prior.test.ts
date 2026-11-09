/**
 * 跨会话端点先验折叠（endpointPriorFromExperience）的行为契约（v2.12.0）：
 * 1. 历史失败→负分、成功→正分、rate=0.5→0、幅度封顶；
 * 2. 失效经验归零（回退完整探测）、样本不足冷启动保护、非 endpoint 域与缺格不冒充结论；
 * 3. 聚合器接线：先验只影响排序，不绕过冷却/限流/能力过滤；回写钩子成败都触发。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { endpointPriorFromExperience } from "../src/models/route-experience.ts";
import type { ExperienceEntry } from "../src/rsi/experience.ts";
import { KeylessAggregator, type KeylessBackend } from "../src/models/keyless.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const entry = (patch: Partial<ExperienceEntry> = {}): ExperienceEntry => ({
  id: "endpoint|E:x|x", domain: "endpoint", signature: "E:x", prescription: "x",
  applicableTo: [], successes: 0, failures: 0, invalidations: [],
  source: "test", lastTs: "2026-11-09T00:00:00.000Z", ...patch,
});

test("失败端点得负先验、成功端点得正先验、rate=0.5 得 0", () => {
  const p = endpointPriorFromExperience([
    entry({ prescription: "dead", successes: 0, failures: 4 }),
    entry({ prescription: "live", successes: 4, failures: 0 }),
    entry({ prescription: "mid", successes: 2, failures: 2 }),
  ]);
  assert.equal(p.dead, -2);
  assert.equal(p.live, 2);
  assert.equal(p.mid, 0);
});

test("幅度封顶：maxBoost 可配，且不超过 ±maxBoost", () => {
  const p = endpointPriorFromExperience(
    [entry({ prescription: "a", successes: 0, failures: 9 }), entry({ prescription: "b", successes: 9, failures: 0 })],
    { maxBoost: 1 },
  );
  assert.equal(p.a, -1);
  assert.equal(p.b, 1);
});

test("失效经验归零（回退完整探测），未失效经验仍生效", () => {
  const p = endpointPriorFromExperience([
    entry({ prescription: "dead", successes: 0, failures: 4, invalidations: ["OOD 退化"] }),
    entry({ prescription: "live", successes: 4, failures: 0 }),
  ]);
  assert.equal(p.dead, 0);
  assert.equal(p.live, 2);
});

test("样本不足冷启动保护、空事件/缺格不冒充结论", () => {
  const p = endpointPriorFromExperience([
    entry({ prescription: "cold", successes: 0, failures: 1 }), // n=1 < 3 → 0
    entry({ prescription: "nocell", successes: 0, failures: 0 }), // n=0 → 0
  ]);
  assert.equal(p.cold, 0);
  assert.equal(p.nocell, 0);
  const custom = endpointPriorFromExperience(
    [entry({ prescription: "two", successes: 0, failures: 2 })], { minSamples: 2 },
  );
  assert.equal(custom.two, -2, "minSamples 可配：2 样本即可采信");
});

test("非 endpoint 域被过滤（经验库三域共享账本，不能串域）", () => {
  const p = endpointPriorFromExperience([
    entry({ domain: "routing", prescription: "x", successes: 9, failures: 0 }),
    entry({ domain: "harness-edit", prescription: "y", successes: 9, failures: 0 }),
    entry({ prescription: "z", successes: 3, failures: 0 }),
  ]);
  assert.equal(p.x, undefined);
  assert.equal(p.y, undefined);
  assert.equal(p.z, 2);
});

class Fake implements LLMProvider {
  name: string;
  calls = 0;
  constructor(name: string) { this.name = name; }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    return {
      content: "ok", toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: "fake", durationMs: 1, provider: this.name,
    };
  }
}
const req = { messages: [{ role: "user", content: "hi" }] } as LLMRequest;
const be = (p: LLMProvider): KeylessBackend => ({ provider: p, priority: 0 });

test("聚合器接线：历史失败端点让位；回写钩子成败都触发、失败即当场让位", async () => {
  // ① 负先验降权：同优先级下，历史失败端点让位给历史成功端点；成功回写 true。
  const dead = new Fake("dead");
  const live = new Fake("live");
  const written: Array<[string, boolean]> = [];
  const agg = new KeylessAggregator({
    name: "mesh",
    backends: [be(dead), be(live)],
    endpointPrior: { dead: -2, live: 2 },
    onEndpointOutcome: (n, ok) => written.push([n, ok]),
  });
  const r = await agg.complete(req);
  assert.equal(r.provider, "mesh/live");
  assert.equal(dead.calls, 0, "负先验端点在同优先级下让位，未被调用");
  assert.deepEqual(written, [["live", true]]);

  // ② 经验说好也要如实回写新失败：历史成功端点仍被优先尝试，一旦本次失败，
  //    回写 false 让经验库更新，并当场硬冷却让位到次优端点、回写 true。
  //    这同时证明先验绝不绕过 cooldown/rate-limit 硬过滤（失败端点不会被高先验复活）。
  class Boom implements LLMProvider {
    name = "boom"; calls = 0;
    async complete(_r: LLMRequest): Promise<LLMResponse> { this.calls += 1; throw new Error("HTTP 500: upstream"); }
  }
  const ok = new Fake("ok");
  const written2: Array<[string, boolean]> = [];
  const agg2 = new KeylessAggregator({
    name: "mesh2",
    backends: [be(new Boom()), be(ok)],
    endpointPrior: { boom: 2 },
    onEndpointOutcome: (n, isOk) => written2.push([n, isOk]),
    maxAttempts: 3,
  });
  const r2 = await agg2.complete(req);
  assert.equal(r2.provider, "mesh2/ok");
  assert.deepEqual(written2, [["boom", false], ["ok", true]], "失败回写 false、故障转移成功回写 true");
});

test("缺省无先验时行为与 v2.11.0 一致（向后兼容）", async () => {
  const a = new Fake("a");
  const b = new Fake("b");
  const agg = new KeylessAggregator({ name: "m", backends: [be(a), be(b)] });
  await agg.complete(req);
  assert.equal(a.calls, 1, "无先验时同优先级选数组首个");
  assert.equal(b.calls, 0);
  const ms = agg.meshStats();
  assert.equal(ms.backends[0]!.endpointPrior, 0, "无经验时 meshStats 先验为 0");
});
