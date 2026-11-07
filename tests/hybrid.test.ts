/**
 * HybridProvider 单元测试：本地+远程协同路由、缓存优先、限流降级、效率统计。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridProvider, cheapToLocalPolicy, remoteOnlyPolicy, type RoutePolicy } from "../src/models/hybrid.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const toolReq = (lastRole: string, content = "x"): LLMRequest =>
  ({
    messages: [
      { role: "user", content: "plan" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "f", arguments: {} }] },
      { role: lastRole as "tool", content, toolCallId: "c1" },
    ],
    tools: [{ name: "f", description: "f", parameters: {} }],
  }) as unknown as LLMRequest;

const chatReq = (): LLMRequest => ({ messages: [{ role: "user", content: "hi" }] }) as LLMRequest;

const resp = (marker: string): LLMResponse => ({
  content: marker,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: "fake",
  durationMs: 1,
  provider: marker,
});

class FakeProvider implements LLMProvider {
  name: string;
  calls = 0;
  constructor(name: string) {
    this.name = name;
  }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    return resp(this.name);
  }
}

test("cheapToLocalPolicy：无工具→本地，工具结果短→本地，需推理→远程", () => {
  assert.equal(cheapToLocalPolicy.decide(chatReq(), { turn: 0 }), "local");
  assert.equal(cheapToLocalPolicy.decide(toolReq("tool", "short"), { turn: 1 }), "local");
  assert.equal(cheapToLocalPolicy.decide(toolReq("user", "long query that needs reasoning"), { turn: 2 }), "remote");
});

test("路由：便宜请求走本地、远程不被调用；需推理请求走远程", async () => {
  const remote = new FakeProvider("remote");
  const local = new FakeProvider("local");
  const h = new HybridProvider("hyb", { remote, local, policy: cheapToLocalPolicy });

  await h.complete(chatReq()); // local
  await h.complete(toolReq("tool", "short")); // local
  await h.complete(toolReq("user", "long reasoning needed")); // remote

  assert.equal(local.calls, 2, "本地应处理 2 个便宜请求");
  assert.equal(remote.calls, 1, "远程应只处理 1 个需推理请求");
});

test("缓存优先：相同请求第二次零调用（不落远程也不落本地）", async () => {
  const remote = new FakeProvider("remote");
  const local = new FakeProvider("local");
  const h = new HybridProvider("hyb", { remote, local, policy: remoteOnlyPolicy });

  await h.complete(chatReq());
  await h.complete(chatReq());
  assert.equal(remote.calls, 1, "remoteOnly 下两次相同请求只打一次远程");
  assert.equal(local.calls, 0);
  const s = h.inferenceStats();
  assert.equal(s.cacheHits, 1);
  assert.equal(s.remoteAvoided, 1);
});

test("限流降级：远程 429/限流时自动降级到本地而非失败", async () => {
  const local = new FakeProvider("local");
  let remoteCalls = 0;
  const remote: LLMProvider = {
    name: "remote",
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      remoteCalls += 1;
      throw new Error("HTTP 429: FreeUsageLimitError — rate limited");
    },
  };
  const h = new HybridProvider("hyb", { remote, local, policy: remoteOnlyPolicy });

  const r = await h.complete(chatReq());
  assert.equal(remoteCalls, 1, "远程应被尝试一次");
  assert.equal(local.calls, 1, "降级应打到本地一次");
  assert.equal(r.provider, "local/hybrid-fallback");
  const s = h.inferenceStats();
  assert.equal(s.remoteCalls, 1);
  assert.equal(s.localCalls, 1);
  assert.equal(s.remoteAvoided, 1, "降级应计入「避免的远程调用」");
});

test("关闭降级时远程失败直接抛出（不掩盖真实故障）", async () => {
  const local = new FakeProvider("local");
  const remote: LLMProvider = {
    name: "remote",
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      throw new Error("HTTP 500: upstream");
    },
  };
  const h = new HybridProvider("hyb", { remote, local, policy: remoteOnlyPolicy, fallbackOnRateLimit: false });
  await assert.rejects(() => h.complete(chatReq()), /HTTP 500/);
});
