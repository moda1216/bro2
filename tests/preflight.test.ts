/**
 * 接入预检门禁单元测试
 *
 * 重点验证「诊断力」：网络不可达与认证被拒必须给出不同的结论与下一步，
 * 否则真机接入时会把「Key 错」误判成「服务没起」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import { runPreflight, formatPreflight } from "../src/models/preflight.ts";
import { startOllamaBridge } from "../examples/ollama-bridge.ts";

function compat(baseUrl: string, model = "qwen3:8b"): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: "test", baseUrl, apiKey: "", model,
    apiKeyOptional: true, timeoutMs: 8000, maxRetries: 0,
  });
}

async function startAuthRejectServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { message: "Authentication Fails, invalid api key", type: "authentication_error" },
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    async close(): Promise<void> { await new Promise<void>((r) => server.close(() => r())); },
  };
}

test("native 端点：六项检查全过，ready=true，并给出可开跑指引", async () => {
  const bridge = await startOllamaBridge("native");
  try {
    const r = await runPreflight(compat(bridge.url, bridge.model));
    assert.equal(r.ready, true);
    assert.equal(r.checks.length, 6);
    assert.ok(r.checks.every((c) => c.ok));
    assert.equal(r.blockers.length, 0);
    assert.ok(r.probe);
    assert.equal(r.probe!.toolCalling, "native");
    assert.equal(r.probe!.networkReachable, true);
    assert.equal(r.probe!.authRejected, false);
    assert.equal(r.probe!.httpStatus, 200);
    assert.ok(r.nextSteps.some((s) => s.includes("eval:live")));
  } finally {
    await bridge.close();
  }
});

test("text-json 端点：模型把工具写进正文 → 原生 tool_calls 阻断", async () => {
  const bridge = await startOllamaBridge("text-json");
  try {
    const r = await runPreflight(compat(bridge.url, bridge.model));
    assert.equal(r.ready, false);
    assert.equal(r.probe!.toolCalling, "text-json");
    assert.ok(r.checks.find((c) => c.id === "toolCalling")!.ok === false);
    assert.ok(r.blockers.some((b) => b.includes("原生 tool_calls")));
  } finally {
    await bridge.close();
  }
});

test("unsupported 端点：完全不响应工具 → 阻断", async () => {
  const bridge = await startOllamaBridge("unsupported");
  try {
    const r = await runPreflight(compat(bridge.url, bridge.model));
    assert.equal(r.ready, false);
    assert.equal(r.probe!.toolCalling, "unsupported");
    assert.ok(r.blockers.some((b) => b.includes("原生 tool_calls")));
  } finally {
    await bridge.close();
  }
});

test("网络不可达：networkReachable=false，指引是恢复服务而非换 Key", async () => {
  const r = await runPreflight(compat("http://127.0.0.1:1/v1"));
  assert.equal(r.ready, false);
  assert.equal(r.probe!.networkReachable, false);
  assert.equal(r.probe!.httpStatus, null);
  assert.equal(r.probe!.authRejected, false);
  assert.ok(r.blockers.some((b) => b.includes("端点可达")));
  assert.ok(r.nextSteps.some((s) => s.includes("恢复服务") || s.includes("ollama serve")));
  assert.ok(!r.nextSteps.some((s) => s.includes("修正 API Key")), "网络故障不应误导用户去改 Key");
  // auth 检查在网络不可达时应降为 info，避免重复计入阻断项
  assert.equal(r.checks.find((c) => c.id === "auth")!.severity, "info");
});

test("401 认证被拒：网络可达但 authRejected=true，指引是修 Key 而非恢复服务", async () => {
  const srv = await startAuthRejectServer();
  try {
    const r = await runPreflight(compat(srv.url));
    assert.equal(r.ready, false);
    assert.equal(r.probe!.networkReachable, true, "401 是网络可达的证据");
    assert.equal(r.probe!.authRejected, true);
    assert.equal(r.probe!.httpStatus, 401);
    assert.ok(r.blockers.some((b) => b.includes("认证")));
    assert.ok(r.nextSteps.some((s) => s.includes("API Key")));
    assert.ok(!r.nextSteps.some((s) => s.includes("先恢复服务")), "认证错误不应误导用户去查服务");
  } finally {
    await srv.close();
  }
});

test("未配置 provider：不发网络请求，probe=null，给出配置指引", async () => {
  const r = await runPreflight(new OpenAICompatProvider({
    name: "test", baseUrl: "", apiKey: "", model: "",
  }));
  assert.equal(r.ready, false);
  assert.equal(r.probe, null);
  assert.equal(r.checks.find((c) => c.id === "configured")!.ok, false);
  assert.equal(r.checks.filter((c) => c.severity === "info").length, 5);
  assert.ok(r.nextSteps.some((s) => s.includes("OLLAMA_BASE_URL")));
  assert.ok(r.nextSteps.some((s) => s.includes("OPENAI_API_KEY")));
});

test("formatPreflight 输出包含门禁结论与阻断项，且不含任何凭据", async () => {
  const r = await runPreflight(compat("http://127.0.0.1:1/v1"));
  const text = formatPreflight(r);
  assert.ok(text.includes("ready=✗ BLOCKED"));
  assert.ok(text.includes("【阻断项】"));
  assert.ok(text.includes("【下一步】"));
  assert.ok(text.includes("endpoint"));
  assert.ok(!text.includes("Bearer "));
  assert.ok(!text.includes("sk-"));
});
