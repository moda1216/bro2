/**
 * L7 交互层 · REST + SSE API（node:http，零依赖）
 */
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "../kernel/events.ts";
import type { Event } from "../kernel/events.ts";
import { mountConnector, HttpConnector } from "../tools/mcp.ts";
import { policySnapshot } from "../runtime/policy.ts";
import { loadMetaState } from "../rsi/shadow.ts";
import type { AgentOS } from "../index.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

export interface ServerOptions {
  host: string;
  port: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function sseInit(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  res.write(": connected\n\n");
}

function sseSend(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 客户端断开
  }
}

export async function startServer(os: AgentOS, options: ServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    void handle(os, req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else sseSend(res, "error", { error: String(err) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return server;
}

async function handle(os: AgentOS, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") { json(res, 204, {}); return; }

  // ---- 静态 ----
  if (path === "/" || path === "/index.html") {
    const p = join(WEB_DIR, "index.html");
    if (!existsSync(p)) { json(res, 404, { error: "Web UI 文件缺失" }); return; }
    const html = readFileSync(p, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }

  // ---- 状态 ----
  if (path === "/api/status" && method === "GET") {
    json(res, 200, {
      name: os.name,
      root: os.root,
      model: os.router.defaultName,
      models: os.router.list(),
      permission: os.permissions.currentLevel,
      autoApprove: os.approvals.isAutoApprove,
      tools: os.registry.list(),
      presets: os.presets.list(),
      skills: os.skills.list(),
      plugins: { loaded: os.runtime.pluginNames(), available: Object.keys(os.runtime.get<Record<string, unknown>>("pluginCatalog") ?? {}) },
      hooks: os.runtime.hooks.count(),
      metrics: os.tracer.snapshot(),
      // 已通过门禁的演进状态是否真的作用到运行时（评测器显式关闭该通道）
      evolution: {
        loopDetectionThreshold: os.config.budget.loopDetectionThreshold,
        compactTokens: os.config.budget.compactTokens ?? null,
        stateFile: "data/evolve/state.json",
        // 已通过双门禁并真正作用到运行时的行为策略
        policy: policySnapshot(os.policy),
        // 已通过冻结 fitness 晋升并作用于下一次 evolve 的元状态
        meta: loadMetaState(os.root),
      },
      sessionCount: os.sessions.list().length,
    });
    return;
  }

  // ---- 会话 ----
  if (path === "/api/sessions" && method === "GET") {
    json(res, 200, { sessions: os.sessions.list().slice(0, 60) });
    return;
  }
  if (path === "/api/sessions" && method === "POST") {
    const b = await bodyJson(req);
    const preset = String(b.preset ?? "standard");
    if (!os.presets.get(preset)) { json(res, 400, { error: `未知 Preset: ${preset}` }); return; }
    const s = os.createSession(preset);
    json(res, 201, { session: s.meta });
    return;
  }
  if (path === "/api/fork" && method === "POST") {
    const b = await bodyJson(req);
    const child = os.sessions.fork(String(b.sessionId ?? ""));
    if (!child) { json(res, 404, { error: "会话不存在" }); return; }
    json(res, 201, { session: child.meta });
    return;
  }

  // ---- 轨迹 / 指标 / 工具 ----
  if (path === "/api/trace" && method === "GET") {
    const id = url.searchParams.get("session") ?? "";
    const s = os.getSession(id);
    if (!s) { json(res, 404, { error: "会话不存在" }); return; }
    const all = s.trajectory.events();
    const limit = Number(url.searchParams.get("limit") ?? 300);
    json(res, 200, { sessionId: id, total: all.length, events: all.slice(-limit), stats: s.trajectory.stats() });
    return;
  }
  if (path === "/api/metrics" && method === "GET") {
    json(res, 200, { metrics: os.tracer.snapshot(), recent: os.tracer.recent(60) });
    return;
  }

  // ---- 审批 ----
  if (path === "/api/approvals" && method === "GET") {
    json(res, 200, { approvals: os.approvals.list() });
    return;
  }
  if (path.startsWith("/api/approvals/") && method === "POST") {
    const id = path.slice("/api/approvals/".length);
    const b = await bodyJson(req);
    const decision = String(b.decision ?? "deny");
    const ok = os.approvals.resolve(id, decision as "approve" | "deny" | "always");
    json(res, ok ? 200 : 404, { ok, id, decision });
    return;
  }

  // ---- 插件 / 连接器 ----
  if (path === "/api/plugins" && method === "POST") {
    const b = await bodyJson(req);
    const catalog = os.runtime.get<Record<string, { name: string; setup: (r: unknown) => void }>>("pluginCatalog") ?? {};
    const def = catalog[String(b.name ?? "")];
    if (!def) { json(res, 404, { error: "未知插件" }); return; }
    try {
      await os.runtime.loadPlugin(def as never);
      json(res, 200, { ok: true, loaded: os.runtime.pluginNames() });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (path === "/api/connectors/http" && method === "POST") {
    const b = await bodyJson(req);
    const connector = new HttpConnector({ name: String(b.name ?? "ext"), url: String(b.url ?? "") });
    try {
      const unmount = await mountConnector(os.runtime, os.registry, connector);
      os.runtime.register(`connector.unmount.${connector.name}`, unmount);
      json(res, 200, { ok: true, name: connector.name, tools: os.registry.size });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ---- 模型切换 ----
  if (path === "/api/model" && method === "POST") {
    const b = await bodyJson(req);
    try { os.router.setDefault(String(b.name ?? "")); json(res, 200, { ok: true, model: os.router.defaultName }); }
    catch (err) { json(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
    return;
  }

  // ---- 对话（SSE 流式）----
  if (path === "/api/chat" && method === "POST") {
    const b = await bodyJson(req);
    const text = String(b.text ?? "").trim();
    if (!text) { json(res, 400, { error: "text 不能为空" }); return; }
    let sessionId = String(b.sessionId ?? "");
    if (!sessionId || !os.getSession(sessionId)) {
      const s = os.createSession(String(b.preset ?? "standard"));
      sessionId = s.id;
    }
    sseInit(res);
    sseSend(res, "session", { sessionId });
    const dispose = os.runtime.bus.on("*", (e: Event) => {
      if (e.sessionId === sessionId) sseSend(res, "event", e);
    });
    // 保活心跳，避免代理断开
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    os.run(sessionId, text, {
      onChunk: (c) => sseSend(res, "chunk", c),
    })
      .then((r) => sseSend(res, "done", r))
      .catch((err) => sseSend(res, "error", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        clearInterval(heartbeat);
        dispose();
        if (!res.writableEnded) res.end();
      });
    return;
  }

  json(res, 404, { error: `未知路由: ${method} ${path}` });
}

export { EventType };
