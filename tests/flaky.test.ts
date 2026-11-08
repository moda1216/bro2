/**
 * 故障注入与路由重试的行为契约：
 * 1. flaky 包装器前 N 次注入、之后透传，injected 计数准确；
 * 2. 路由层对瞬时故障（429/5xx）原地退避重试，非瞬时故障不重试；
 * 3. attempts=0 时一次都不重试（消融对照的「唯一变量」成立）；
 * 4. malformed-args 拼错首个长参数名（命中 repair 分支）；
 * 5. 脏故障：timeout / retry-after / empty-response，及空响应守卫的消融唯一变量。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  wrapFlaky, isTransientError, isEmptyResponse, EmptyResponseError, ProviderRouter,
} from "../src/models/router.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

function stub(name: string, failTimes: number, msg = "HTTP 429: rate limit exceeded"): LLMProvider & { calls: number } {
  let calls = 0;
  return {
    name,
    get calls() { return calls; },
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      calls += 1;
      if (calls <= failTimes) throw new Error(msg);
      return { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: name, durationMs: 1, provider: name };
    },
  };
}

test("flaky：前 times 次注入限流错误，之后透传", async () => {
  const base = stub("base", 0);
  const f = wrapFlaky(base, { kind: "rate-limit", times: 2 });
  await assert.rejects(() => f.complete({ messages: [] }), /HTTP 429/);
  await assert.rejects(() => f.complete({ messages: [] }), /HTTP 429/);
  const r = await f.complete({ messages: [] });
  assert.equal(r.content, "ok");
  assert.equal(f.injected, 2);
  assert.equal(base.calls, 1); // 注入的两次不打到真实端点（不烧钱）
});

test("flaky：malformed-args 把首个长参数名拼错（repair 的真实分支），工具名不动", async () => {
  const base: LLMProvider = {
    name: "base",
    async complete() {
      return {
        content: "", toolCalls: [{ id: "c1", name: "file_edit", arguments: { path: "a.ts", max: 5 } }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: "base", durationMs: 1, provider: "base",
      };
    },
  };
  const f = wrapFlaky(base, { kind: "malformed-args", times: 1 });
  const r = await f.complete({ messages: [] });
  assert.equal(r.toolCalls[0]!.name, "file_edit");
  assert.deepEqual(r.toolCalls[0]!.arguments, { pat: "a.ts", max: 5 }); // path → pat
  assert.equal(f.injected, 1);
  // 第二次调用不再污染
  const r2 = await f.complete({ messages: [] });
  assert.deepEqual(r2.toolCalls[0]!.arguments, { path: "a.ts", max: 5 });
});

test("flaky：全短键参数退化为标量字符串化", async () => {
  const base: LLMProvider = {
    name: "base",
    async complete() {
      return {
        content: "", toolCalls: [{ id: "c1", name: "calc", arguments: { n: 5 } }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: "b", durationMs: 1, provider: "b",
      };
    },
  };
  const f = wrapFlaky(base, { kind: "malformed-args", times: 1 });
  const r = await f.complete({ messages: [] });
  assert.deepEqual(r.toolCalls[0]!.arguments, { n: "5" });
});

test("flaky：模型未发工具调用时不消耗注入额度（下次再注）", async () => {
  let calls = 0;
  const base: LLMProvider = {
    name: "base",
    async complete() {
      calls += 1;
      const toolCalls = calls === 1 ? [] : [{ id: "c", name: "calc", arguments: { expr: 1 } }];
      return { content: "x", toolCalls, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: "b", durationMs: 1, provider: "b" };
    },
  };
  const f = wrapFlaky(base, { kind: "malformed-args", times: 1 });
  await f.complete({ messages: [] }); // 无工具调用，不注入
  assert.equal(f.injected, 0);
  const r = await f.complete({ messages: [] });
  assert.deepEqual(r.toolCalls[0]!.arguments, { exp: 1 }); // expr → exp（拼错优先于字符串化）
  assert.equal(f.injected, 1);
});

test("isTransientError：429/5xx/网络错误可重试，fatal 与业务错误不可", () => {
  assert.ok(isTransientError(new Error("HTTP 429: rate limit")));
  assert.ok(isTransientError(new Error("HTTP 503: unavailable")));
  assert.ok(isTransientError(new Error("fetch failed")));
  assert.ok(!isTransientError(Object.assign(new Error("HTTP 400: bad request"), { fatal: true })));
  assert.ok(!isTransientError(new Error("HTTP 400: bad request")));
  assert.ok(!isTransientError(new Error("模型响应缺少 body")));
});

test("router：瞬时故障原地重试，成功路径不清空熔断计数语义", async () => {
  const router = new ProviderRouter("flaky-one");
  const p = stub("flaky-one", 3, "HTTP 500: boom");
  router.register("flaky-one", p);
  router.setStrict(true);
  router.setRetry({ attempts: 3, baseMs: 1 });
  const r = await router.complete({ messages: [] });
  assert.equal(r.content, "ok");
  assert.equal(p.calls, 4); // 1 次原始 + 3 次重试
  assert.equal(router.retryAttempts, 3);
});

test("router：attempts=0 时瞬时故障直接失败（消融的唯一变量）", async () => {
  const router = new ProviderRouter("flaky-one");
  const p = stub("flaky-one", 3, "HTTP 429: limited");
  router.register("flaky-one", p);
  router.setStrict(true);
  router.setRetry({ attempts: 0, baseMs: 0 });
  await assert.rejects(() => router.complete({ messages: [] }), /全部模型均不可用/);
  assert.equal(p.calls, 1);
  assert.equal(router.retryAttempts, 0);
});

test("router：非瞬时故障（400）不重试，直接计入熔断", async () => {
  const router = new ProviderRouter("p1");
  const p = stub("p1", 5, "HTTP 400: bad request");
  router.register("p1", p);
  router.setStrict(true);
  router.setRetry({ attempts: 3, baseMs: 1 });
  await assert.rejects(() => router.complete({ messages: [] }), /400/);
  assert.equal(p.calls, 1); // 不重试
  assert.equal(router.retryAttempts, 0);
});

// ---------------------------------------------------------------- 脏故障形态（v2.8.0）
const okRes = (content = "ok"): LLMResponse => ({
  content, toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: "base", durationMs: 1, provider: "base",
});

test("timeout：短 stall 后抛与真实超时同构的错误，可被瞬态判定识别", async () => {
  const base: LLMProvider = { name: "base", async complete() { return okRes(); } };
  const f = wrapFlaky(base, { kind: "timeout", times: 1, stallMs: 5 });
  await assert.rejects(() => f.complete({ messages: [] }), /ETIMEDOUT.*timed out/);
  assert.ok(isTransientError(new Error("fetch failed: ETIMEDOUT connection timed out")));
  assert.equal((await f.complete({ messages: [] })).content, "ok");
  assert.equal(f.injected, 1);
});

test("retry-after：错误携带 retryAfterMs 供路由层尊重", async () => {
  const base: LLMProvider = { name: "base", async complete() { return okRes(); } };
  const f = wrapFlaky(base, { kind: "retry-after", times: 1, retryAfterMs: 7 });
  await assert.rejects(() => f.complete({ messages: [] }), (e: unknown) => {
    assert.match((e as Error).message, /Retry-After/);
    assert.equal((e as { retryAfterMs?: number }).retryAfterMs, 7);
    return true;
  });
  assert.equal(f.injected, 1);
});

test("empty-response：返回 200 但空内容，不抛错；isEmptyResponse 为真", async () => {
  const base: LLMProvider = { name: "base", async complete() { return okRes(); } };
  const f = wrapFlaky(base, { kind: "empty-response", times: 2 });
  const r1 = await f.complete({ messages: [] });
  assert.ok(isEmptyResponse(r1), "半截响应必须能被守卫识别");
  await f.complete({ messages: [] });
  assert.ok(!isEmptyResponse(await f.complete({ messages: [] })), "times 之后必须透传");
  assert.equal(f.injected, 2);
});

test("isEmptyResponse：content 或 toolCalls 任一非空即不算半截", () => {
  assert.ok(isEmptyResponse({ ...okRes(""), toolCalls: [] }));
  assert.ok(!isEmptyResponse(okRes("hi")));
  assert.ok(!isEmptyResponse({ ...okRes(""), toolCalls: [{ id: "c", name: "calc", arguments: {} }] }));
});

test("router：emptyGuard 默认拦半截响应并重试恢复", async () => {
  const router = new ProviderRouter("p");
  router.register("p", wrapFlaky({ name: "p", async complete() { return okRes("done"); } }, { kind: "empty-response", times: 2 }));
  router.setStrict(true);
  router.setRetry({ attempts: 3, baseMs: 1 });
  const r = await router.complete({ messages: [] });
  assert.equal(r.content, "done");
  assert.equal(router.emptyGuardHitCount, 2);
  assert.equal(router.retryAttempts, 2);
});

test("router：emptyGuard=false 时半截响应冒充合法终答返回（消融唯一变量）", async () => {
  const router = new ProviderRouter("p");
  router.register("p", wrapFlaky({ name: "p", async complete() { return okRes("done"); } }, { kind: "empty-response", times: 2 }));
  router.setStrict(true);
  router.setRetry({ attempts: 3, baseMs: 1 });
  router.setEmptyGuard(false);
  const r = await router.complete({ messages: [] });
  assert.equal(r.content, "", "守卫关闭 → 空响应直接返回");
  assert.equal(router.emptyGuardHitCount, 0);
});

test("router：retry-after 尊重服务端等待（等待时长被 clamp 不拖慢）", async () => {
  const router = new ProviderRouter("p");
  const p = stub("p", 1, "HTTP 429: rate limit");
  router.register("p", p);
  router.setStrict(true);
  router.setRetry({ attempts: 2, baseMs: 1 });
  const t0 = Date.now();
  const r = await router.complete({ messages: [] });
  assert.equal(r.content, "ok");
  assert.ok(Date.now() - t0 < 1000, "退避不应拖慢评测");
});
