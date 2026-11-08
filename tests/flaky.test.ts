/**
 * 故障注入与路由重试的行为契约：
 * 1. flaky 包装器前 N 次注入、之后透传，injected 计数准确；
 * 2. 路由层对瞬时故障（429/5xx）原地退避重试，非瞬时故障不重试；
 * 3. attempts=0 时一次都不重试（消融对照的「唯一变量」成立）；
 * 4. malformed-args 只污染标量参数类型，工具调用结构保持完整。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapFlaky, isTransientError } from "../src/models/router.ts";
import { ProviderRouter } from "../src/models/router.ts";
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
