/**
 * CachedProvider 单元测试：透明响应缓存 + 效率统计。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CachedProvider, type StatsProvider } from "../src/models/cache.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const mkReq = (over: Partial<LLMRequest> = {}): LLMRequest =>
  ({ messages: [{ role: "user", content: "hi" }], ...over }) as LLMRequest;

const resp = (marker: string): LLMResponse => ({
  content: marker,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: "fake",
  durationMs: 1,
  provider: "fake",
});

class FakeProvider implements LLMProvider {
  name = "fake";
  calls = 0;
  private readonly marker: string;
  constructor(marker: string) {
    this.marker = marker;
  }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    return resp(`${this.marker}#${this.calls}`);
  }
}

test("相同请求第二次命中缓存，底层 provider 只调用一次", async () => {
  const inner = new FakeProvider("R");
  const p = new CachedProvider("c", inner);
  const r1 = await p.complete(mkReq());
  const r2 = await p.complete(mkReq());
  assert.equal(inner.calls, 1, "底层只应被调用一次");
  assert.equal(r1.content, "R#1");
  assert.equal(r2.content, "R#1", "缓存命中应返回首次结果");
  assert.ok((p as StatsProvider).inferenceStats().cacheHits >= 1);
});

test("不同请求（不同消息）各自打到远程，不互相命中", async () => {
  const inner = new FakeProvider("R");
  const p = new CachedProvider("c", inner);
  await p.complete(mkReq({ messages: [{ role: "user", content: "a" }] as never }));
  await p.complete(mkReq({ messages: [{ role: "user", content: "b" }] as never }));
  assert.equal(inner.calls, 2, "两次不同请求都应打到远程");
});

test("inferenceStats 正确统计 hits/misses/remoteAvoided", async () => {
  const inner = new FakeProvider("R");
  const p = new CachedProvider("c", inner);
  await p.complete(mkReq()); // miss
  await p.complete(mkReq()); // hit
  await p.complete(mkReq()); // hit
  const s = (p as StatsProvider).inferenceStats();
  assert.equal(s.remoteCalls, 1);
  assert.equal(s.cacheHits, 2);
  assert.equal(s.remoteAvoided, 2);
  assert.ok(Math.abs(s.remoteCallRatio - 1 / 3) < 1e-9);
});
