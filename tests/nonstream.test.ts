/**
 * v2.13.0 · 非流式 provider 与接入门禁盲点的行为契约
 *
 * 背景：llama.cpp server 的 chatml-function-calling handler 在 stream:true 下
 * 不产出 tool_calls delta，非流式却返回规范 tool_calls。旧 complete() 硬编码流式，
 * 且 preflight 把「非流式 tool_calls」与「流式普通应答」分开测，从未覆盖
 * live 评测真正走的「流式 + 带 tools」路径 —— 本地端点因此 preflight PASS
 * 却在 live 里零工具调用。
 *
 * 本测试用离线 fake server 复现该端点形态，钉住：
 *  1) 显式 stream:false → 不发 stream_options、非流式 tool_calls 被正确解析；
 *  2) 缺省不配 → 仍走流式（向后兼容，所有既有端点行为不变）；
 *  3) probe 区分 streamMode，且盲点（流式带 tools 无 delta）被观测记录；
 *  4) preflight 在非流式模式放行，但「必须原生 tool_calls」的硬门槛不放松。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import { runPreflight } from "../src/models/preflight.ts";

interface Recorded { path: string; body: Record<string, unknown> }

async function fakeServer(mode: "native" | "no-tools" = "native"): Promise<{
  url: string;
  records: Recorded[];
  close: () => Promise<void>;
}> {
  const records: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      records.push({ path: req.url ?? "", body });
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
        return;
      }
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const toolCalls = mode === "native" && hasTools
        ? [{ id: "call_1", type: "function", function: { name: "probe_ping", arguments: '{"value":"hello-agent-os"}' } }]
        : [];
      if (body.stream === true) {
        // 复现 llama.cpp server：流式下即使带 tools 也不产出 tool_calls delta
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: {
          role: "assistant",
          content: mode === "native" ? "" : "I cannot call tools",
          tool_calls: toolCalls,
        } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fake server 未取得端口");
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    records,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const mk = (url: string, stream?: boolean): OpenAICompatProvider =>
  new OpenAICompatProvider({
    name: "fake", baseUrl: url, apiKey: "", model: "fake-model",
    maxRetries: 0, timeoutMs: 10000,
    ...(stream === undefined ? {} : { stream }),
  });

const req = {
  messages: [{ role: "user" as const, content: "ping" }],
  tools: [{
    name: "probe_ping", description: "ping",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  }],
};

const chatCalls = (records: Recorded[]): Recorded[] =>
  records.filter((x) => x.path.endsWith("/chat/completions"));

test("显式 stream:false → 不发 stream_options，非流式 tool_calls 被解析为可执行调用", async () => {
  const s = await fakeServer();
  try {
    const r = await mk(s.url, false).complete(req);
    const calls = chatCalls(s.records);
    assert.equal(calls[0]!.body.stream, false);
    assert.equal("stream_options" in calls[0]!.body, false, "非流式不应请求 stream_options");
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0]!.name, "probe_ping");
    assert.deepEqual(r.toolCalls[0]!.arguments, { value: "hello-agent-os" });
    assert.equal(r.usage.inputTokens, 12);
  } finally {
    await s.close();
  }
});

test("缺省不配 stream → 仍走流式 SSE（向后兼容，既有端点行为不变）", async () => {
  const s = await fakeServer();
  try {
    await mk(s.url).complete(req);
    const calls = chatCalls(s.records);
    assert.equal(calls[0]!.body.stream, true);
    assert.ok(calls[0]!.body.stream_options, "流式模式仍请求 include_usage");
  } finally {
    await s.close();
  }
});

test("probe 非流式模式：streamMode=nonstream、跳过 SSE 探测、toolCalling 仍为 native", async () => {
  const s = await fakeServer();
  try {
    const r = await mk(s.url, false).probe();
    assert.equal(r.streamMode, "nonstream");
    assert.equal(r.streaming, false);
    assert.equal(r.toolCalling, "native");
    assert.equal(r.streamToolCalls, false);
    assert.ok(r.warnings.some((w) => w.includes("跳过 SSE 探测")));
  } finally {
    await s.close();
  }
});

test("门禁盲点被观测：流式 + 带 tools 无 tool_calls delta 会留下可操作告警", async () => {
  const s = await fakeServer();
  try {
    const r = await mk(s.url, true).probe();
    assert.equal(r.streamMode, "stream");
    assert.equal(r.streaming, true);
    assert.equal(r.streamToolCalls, false);
    assert.ok(r.warnings.some((w) => w.includes("建议该端点设 stream=false")));
  } finally {
    await s.close();
  }
});

test("preflight 非流式模式放行，但『必须原生 tool_calls』硬门槛不放松", async () => {
  const ok = await fakeServer();
  try {
    const pf = await runPreflight(mk(ok.url, false));
    assert.equal(pf.ready, true);
    assert.equal(pf.checks.find((c) => c.id === "streaming")!.severity, "info");
  } finally {
    await ok.close();
  }

  const bad = await fakeServer("no-tools");
  try {
    const pf2 = await runPreflight(mk(bad.url, false));
    assert.equal(pf2.ready, false, "不支持 tool_calls 的模型即便关流式也必须 BLOCKED");
    assert.ok(pf2.blockers.some((b) => b.includes("原生 tool_calls")));
  } finally {
    await bad.close();
  }
});
