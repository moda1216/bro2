/**
 * KeylessAggregator 单元测试：统一聚合、智能选优、限流感知故障转移、
 * 能力感知路由、应急兜底与网状统计。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeylessAggregator, isMeshProvider, type KeylessBackend } from "../src/models/keyless.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const resp = (marker: string): LLMResponse => ({
  content: marker,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: "fake",
  durationMs: 1,
  provider: marker,
});

/** 可控的假上游：可配置是否失败、是否限流、是否支持工具、延迟。 */
class FakeBackend implements LLMProvider {
  name: string;
  calls = 0;
  /** 失败次数预算：>0 时前 N 次抛错（用于模拟限流/抖动），用尽后成功。 */
  failTimes: number;
  rateLimit: boolean;
  supportsTools: boolean;
  latencyMs: number;
  constructor(name: string, opts: { failTimes?: number; rateLimit?: boolean; supportsTools?: boolean; latencyMs?: number } = {}) {
    this.name = name;
    this.failTimes = opts.failTimes ?? 0;
    this.rateLimit = opts.rateLimit ?? false;
    this.supportsTools = opts.supportsTools ?? true;
    this.latencyMs = opts.latencyMs ?? 1;
  }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      const msg = this.rateLimit ? "HTTP 429: FreeUsageLimitError — rate limited" : "HTTP 500: upstream";
      throw new Error(msg);
    }
    await new Promise((r) => setTimeout(r, this.latencyMs));
    return resp(this.name);
  }
}

const be = (p: LLMProvider, extra: Partial<KeylessBackend> = {}): KeylessBackend => ({ provider: p, ...extra });

test("isMeshProvider：仅 KeylessAggregator 实例为真", () => {
  const agg = new KeylessAggregator({ name: "k", backends: [be(new FakeBackend("a"))] });
  assert.equal(isMeshProvider(agg), true);
  assert.equal(isMeshProvider(new FakeBackend("x")), false);
  assert.equal(isMeshProvider({}), false);
});

test("统一接口：单次请求只打一个上游，返回聚合后的 provider 标记", async () => {
  const a = new FakeBackend("A");
  const agg = new KeylessAggregator({ name: "mesh", backends: [be(a, { priority: 1 }), be(new FakeBackend("B"), { priority: 0 })] });
  const r = await agg.complete({ messages: [{ role: "user", content: "hi" }] } as LLMRequest);
  assert.equal(a.calls, 1, "高优先级 A 应被选中");
  assert.equal(r.provider, "mesh/A", `provider 应带聚合器前缀（实际 ${r.provider}）`);
});

test("智能选优：高优先级/低延迟上游优先；全部成功则网状 attempts=成功数", async () => {
  const slow = new FakeBackend("slow", { latencyMs: 10 });
  const fast = new FakeBackend("fast", { latencyMs: 1 });
  const agg = new KeylessAggregator({ name: "m", backends: [be(slow, { priority: 0 }), be(fast, { priority: 1 })] });
  await agg.complete({ messages: [{ role: "user", content: "x" }] } as LLMRequest);
  assert.equal(fast.calls, 1);
  assert.equal(slow.calls, 0);
  const ms = agg.meshStats();
  assert.equal(ms.meshAttempts, 1);
  assert.equal(ms.successes, 1);
});

test("限流感知故障转移：上游 429 后被冷却并切到下一个，不全失败", async () => {
  const limited = new FakeBackend("limited", { failTimes: 1, rateLimit: true });
  const ok = new FakeBackend("ok");
  const agg = new KeylessAggregator({
    name: "m",
    backends: [be(limited, { priority: 2 }), be(ok, { priority: 1 })],
    rateLimitCooldownMs: 60_000,
  });
  const r = await agg.complete({ messages: [{ role: "user", content: "x" }] } as LLMRequest);
  assert.equal(limited.calls, 1, "limited 应被尝试一次并触发限流");
  assert.equal(ok.calls, 1, "故障转移应打到 ok");
  assert.equal(r.provider, "m/ok");
  const ms = agg.meshStats();
  const lb = ms.backends.find((b) => b.name === "limited")!;
  assert.equal(lb.rateLimited, true, "limited 应被标记为限流冷却");
  assert.equal(ms.rateLimitFailovers, 1);
});

test("能力感知：带 tools 时跳过不支持 function calling 的上游", async () => {
  const noTools = new FakeBackend("noTools", { supportsTools: false });
  const withTools = new FakeBackend("withTools", { supportsTools: true });
  const agg = new KeylessAggregator({
    name: "m",
    // 能力感知在读 KeylessBackend.supportsTools，必须在 backend 元数据上声明
    backends: [be(noTools, { priority: 5, supportsTools: false }), be(withTools, { priority: 0, supportsTools: true })],
  });
  const req = {
    messages: [{ role: "user", content: "call the tool" }],
    tools: [{ name: "f", description: "f", parameters: {} }],
  } as LLMRequest;
  await agg.complete(req);
  assert.equal(noTools.calls, 0, "不支持工具的上游不应被选中");
  assert.equal(withTools.calls, 1);
});

test("全部故障 + 应急兜底：所有上游失败但 emergencyProvider 成功，返回兜底结果", async () => {
  const a = new FakeBackend("a", { failTimes: 99, rateLimit: false });
  const b = new FakeBackend("b", { failTimes: 99, rateLimit: false });
  const emergency = new FakeBackend("local");
  const agg = new KeylessAggregator({
    name: "m",
    backends: [be(a), be(b)],
    maxAttempts: 4,
    emergencyProvider: emergency,
  });
  const r = await agg.complete({ messages: [{ role: "user", content: "x" }] } as LLMRequest);
  // 每个上游硬失败一次即进入冷却（30s），单次调用内不再重试同一上游；
  // 2 个上游各试 1 次后耗尽，转应急兜底。
  assert.equal(a.calls + b.calls, 2, "两个上游各被尝试一次后即冷却");
  assert.equal(emergency.calls, 1, "应急兜底应被调用一次");
  assert.equal(r.provider, "m/local");
});

test("全部故障且无比应急：抛聚合错误（不静默返回空响应）", async () => {
  const a = new FakeBackend("a", { failTimes: 99 });
  const agg = new KeylessAggregator({ name: "m", backends: [be(a)], maxAttempts: 2 });
  await assert.rejects(() => agg.complete({ messages: [{ role: "user", content: "x" }] } as LLMRequest), /全部上游不可用/);
});

test("inferenceStats：网状视角每次上游调用计为一次远程调用", async () => {
  const limited = new FakeBackend("limited", { failTimes: 1, rateLimit: true });
  const ok = new FakeBackend("ok");
  const agg = new KeylessAggregator({ name: "m", backends: [be(limited), be(ok)] });
  await agg.complete({ messages: [{ role: "user", content: "x" }] } as LLMRequest);
  const s = agg.inferenceStats();
  assert.equal(s.remoteCalls, 2, "1 次限流重试 + 1 次成功 = 2 次上游调用");
  assert.equal(s.remoteCallRatio, 1);
});

test("meshStats：healthy 报告含每个上游明细与聚合计数", async () => {
  const a = new FakeBackend("a", { latencyMs: 2 });
  const b = new FakeBackend("b");
  const agg = new KeylessAggregator({ name: "m", backends: [be(a, { priority: 1, tags: ["unified-gateway"] }), be(b)] });
  await agg.complete({ messages: [{ role: "user", content: "x" }] } as LLMRequest);
  const ms = agg.meshStats();
  assert.equal(ms.name, "m");
  assert.equal(ms.backendCount, 2);
  assert.equal(ms.backends.length, 2);
  assert.equal(ms.backends[0]!.name, "a");
  assert.equal(ms.backends[0]!.tags[0], "unified-gateway");
  assert.equal(ms.successes, 1);
});

test("底层穿透：underlying() 返回所有上游 provider（供 preflight 对真实端点做探针）", () => {
  const a = new FakeBackend("a");
  const b = new FakeBackend("b");
  const agg = new KeylessAggregator({ name: "m", backends: [be(a), be(b)] });
  const u = agg.underlying();
  assert.equal(u.length, 2);
  assert.ok(u.includes(a));
  assert.ok(u.includes(b));
});
