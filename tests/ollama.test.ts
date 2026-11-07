/**
 * 模型适配层回归测试：本地端点免密钥、能力探针、tool_calls delta 合并、
 * 并行调用顺序还原、函数名重复分片防护、严格路由禁止静默降级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { startOllamaBridge } from "../examples/ollama-bridge.ts";
import { OpenAICompatProvider, isLocalEndpoint } from "../src/models/openai-compat.ts";
import { ProviderRouter } from "../src/models/router.ts";
import { MockProvider } from "../src/models/mock.ts";

const mkProvider = (baseUrl: string, apiKey = ""): OpenAICompatProvider =>
  new OpenAICompatProvider({ name: "ollama", baseUrl, apiKey, model: "qwen3:8b", maxRetries: 0, timeoutMs: 5000 });

test("本地端点自动免密钥，云端端点仍要求密钥", () => {
  assert.equal(isLocalEndpoint("http://127.0.0.1:11434/v1"), true);
  assert.equal(isLocalEndpoint("http://localhost:1234/v1"), true);
  assert.equal(isLocalEndpoint("http://[::1]:8080/v1"), true);
  assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
  assert.equal(mkProvider("http://127.0.0.1:11434/v1").configured, true);
  assert.equal(mkProvider("https://api.openai.com/v1").configured, false);
  assert.equal(mkProvider("https://api.openai.com/v1", "sk-x").configured, true);
});

test("probe 判定原生 tool_calls，且本地端点不发送 Authorization", async () => {
  const bridge = await startOllamaBridge("native");
  try {
    const r = await mkProvider(bridge.url).probe();
    assert.equal(r.reachable, true);
    assert.equal(r.streaming, true);
    assert.equal(r.toolCalling, "native");
    assert.deepEqual(r.models, ["qwen3:8b"]);
    assert.ok(bridge.records.length >= 2);
    assert.ok(bridge.records.every((x) => !x.hasAuth), "本地端点不应携带 Authorization 头");
  } finally {
    await bridge.close();
  }
});

test("probe 能识别只写进正文与完全不支持工具的模型", async () => {
  for (const [mode, expected] of [["text-json", "text-json"], ["unsupported", "unsupported"]] as const) {
    const bridge = await startOllamaBridge(mode);
    try {
      const r = await mkProvider(bridge.url).probe();
      assert.equal(r.toolCalling, expected);
      assert.ok(r.suggestions.some((s) => s.includes("tool-use")), "应给出换模型的可操作建议");
    } finally {
      await bridge.close();
    }
  }
});

test("SSE tool_calls delta 分片被正确合并为可执行的工具调用", async () => {
  const bridge = await startOllamaBridge("native");
  try {
    const res = await mkProvider(bridge.url).complete({
      messages: [{ role: "user", content: "计算 sum([7,8,15])" }],
      tools: [{ name: "calc", description: "计算", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }],
    });
    assert.equal(res.provider, "ollama");
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0]!.name, "calc");
    assert.deepEqual(res.toolCalls[0]!.arguments, { expression: "sum([7,8,15])" });
  } finally {
    await bridge.close();
  }
});

test("并行工具调用按 index 还原顺序，重复下发的函数名不会拼成两次", async () => {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const c = (delta: Record<string, unknown>): string =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    // 故意让 index 1 先于 index 0 到达
    res.write(c({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "current_time", arguments: "{}" } }] }));
    res.write(c({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "calc", arguments: '{"expression":' } }] }));
    // 模拟部分本地端点重复下发完整 name 的行为
    res.write(c({ tool_calls: [{ index: 0, function: { name: "calc", arguments: '"1+1"}' } }] }));
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const res = await mkProvider(`http://127.0.0.1:${port}/v1`).complete({ messages: [{ role: "user", content: "x" }] });
    assert.deepEqual(res.toolCalls.map((c) => c.name), ["calc", "current_time"]);
    assert.equal(res.toolCalls[0]!.arguments.expression, "1+1");
    assert.equal(res.toolCalls[0]!.id, "call_a");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("strict 路由禁止降级：端点不可达时明确抛错而非回落到 Mock", async () => {
  const router = new ProviderRouter("ollama");
  router.register("mock", new MockProvider({ script: [{ content: "伪造成功" }] }));
  router.register("ollama", mkProvider("http://127.0.0.1:1/v1"));
  router.setStrict(true);
  await assert.rejects(
    () => router.complete({ messages: [{ role: "user", content: "hi" }] }),
    /全部模型均不可用/,
  );
  router.setStrict(false);
  const fallback = await router.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(fallback.content, "伪造成功");
});
