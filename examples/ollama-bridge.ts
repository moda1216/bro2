/**
 * Ollama OpenAI 兼容端点的高保真协议仿真（用于离线实证，不需要 GPU / 模型文件）
 *
 * 模拟 Ollama 0.3+ 的真实行为：
 *  - /api/tags（Ollama 原生）与 /v1/models（OpenAI 兼容）模型清单
 *  - /v1/chat/completions 非流式 JSON（含 tool_calls）
 *  - /v1/chat/completions 流式 SSE：content 分片、tool_calls delta 分片、
 *    usage 汇总块（stream_options.include_usage）、[DONE]
 *  - 忽略 Authorization（本地端点无需密钥）
 *
 * 三种模式用于验证能力探针的诊断力：
 *  - native      带 tool-use 训练的模型，原生返回 tool_calls
 *  - text-json   把工具调用写进正文（Agent 无法执行）
 *  - unsupported 完全不响应工具（Agent 退化为纯聊天）
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

export type ToolCallingMode = "native" | "text-json" | "unsupported";

export interface BridgeRecord {
  path: string;
  hasAuth: boolean;
  stream: boolean;
  hasTools: boolean;
  messageRoles: string[];
}

export interface Bridge {
  url: string;
  port: number;
  model: string;
  mode: ToolCallingMode;
  records: BridgeRecord[];
  close(): Promise<void>;
}

const MODEL = "qwen3:8b";
const CREATED = Math.floor(Date.now() / 1000);

interface ChatBody {
  model?: string;
  messages?: Array<{ role: string; content?: string }>;
  stream?: boolean;
  tools?: unknown[];
  stream_options?: { include_usage?: boolean };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function chunkOf(delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>): string {
  const obj: Record<string, unknown> = {
    id: "chatcmpl-agentos",
    object: "chat.completion.chunk",
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) {
    obj.choices = [];
    obj.usage = usage;
  }
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function startOllamaBridge(mode: ToolCallingMode = "native"): Promise<Bridge> {
  const records: BridgeRecord[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];

    if (path === "/api/tags" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, size: 5200000000, digest: "sim-bridge" }] }));
      return;
    }
    if (path === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: CREATED, owned_by: "library" }] }));
      return;
    }
    if (path !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route ${path}` } }));
      return;
    }

    let body: ChatBody;
    try {
      body = JSON.parse(await readBody(req)) as ChatBody;
    } catch {
      res.writeHead(400);
      res.end("invalid json");
      return;
    }
    const msgs = body.messages ?? [];
    records.push({
      path,
      hasAuth: Boolean(req.headers.authorization),
      stream: body.stream === true,
      hasTools: Array.isArray(body.tools) && body.tools.length > 0,
      messageRoles: msgs.map((m) => m.role),
    });

    // ---- 非流式（能力探针与常规 SDK 调用）----
    if (body.stream !== true) {
      const decide = (): { content: string; toolCalls?: unknown[] } => {
        if (body.tools && body.tools.length > 0) {
          if (mode === "native") {
            return {
              content: "",
              toolCalls: [{
                id: "call_probe_1", type: "function",
                function: { name: "probe_ping", arguments: '{"value":"hello-agent-os"}' },
              }],
            };
          }
          if (mode === "text-json") {
            return { content: '{"name":"probe_ping","arguments":{"value":"hello-agent-os"}}' };
          }
          return { content: "I cannot call tools; here is a plain text answer." };
        }
        return { content: "pong" };
      };
      const d = decide();
      const message: Record<string, unknown> = { role: "assistant", content: d.content };
      if (d.toolCalls) message.tool_calls = d.toolCalls;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-probe", object: "chat.completion", created: CREATED, model: MODEL,
        choices: [{ index: 0, message, finish_reason: d.toolCalls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 },
      }));
      return;
    }

    // ---- 流式 SSE ----
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(chunkOf({ role: "assistant", content: "" }, null));

    const hasToolResult = msgs.some((m) => m.role === "tool");
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (!hasToolResult && hasTools && mode === "native") {
      // 真实 Ollama 风格：id / name 只在首个 delta 给出，arguments 逐片到达
      res.write(chunkOf({
        tool_calls: [{ index: 0, id: "call_calc_1", type: "function", function: { name: "calc", arguments: "" } }],
      }, null));
      const args = '{"expression":"sum([7,8,15])"}';
      res.write(chunkOf({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 12) } }] }, null));
      res.write(chunkOf({ tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] }, null));
      res.write(chunkOf({}, "tool_calls"));
    } else {
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
      const text = hasToolResult
        ? `任务完成。工具返回：${String(lastTool?.content ?? "").slice(0, 100)}。合计 30。`
        : "pong";
      res.write(chunkOf({ content: text }, null));
      res.write(chunkOf({}, "stop"));
    }
    // include_usage 汇总块 + 结束标记
    res.write(chunkOf({}, null, { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 }));
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    model: MODEL,
    mode,
    records,
    async close(): Promise<void> {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
