import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType, normalizeImages } from "../kernel/events.ts";
import type { Event, ImagePart } from "../kernel/events.ts";
import { mountConnector, HttpConnector } from "../tools/mcp.ts";
import { policySnapshot } from "../runtime/policy.ts";
import { loadMetaState } from "../rsi/shadow.ts";
import type { AgentOS } from "../index.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");
const activeRuns = new Set<string>(); // 本进程此刻正在执行的会话
const runtimeId = `${process.pid}-${randomUUID().slice(0, 6)}`;
let runtimeDir = "";
let authToken: string | undefined;
/** 跨实例运行态：每个实例只写自己的心跳文件；读时合并所有未过期心跳。 */
function clusterActive(): { active: string[]; byInstance: Record<string, number> } {
  const active = new Set<string>(), byInstance: Record<string, number> = {};
  if (!runtimeDir || !existsSync(runtimeDir)) return { active: [], byInstance };
  for (const f of readdirSync(runtimeDir).filter((x) => x.startsWith("active-") && x.endsWith(".json"))) {
    try {
      const row = JSON.parse(readFileSync(join(runtimeDir, f), "utf8")) as { instanceId: string; runs: string[]; ts: number };
      if (Date.now() - row.ts > 6000) continue;
      byInstance[row.instanceId] = row.runs.length;
      for (const r of row.runs) active.add(r);
    } catch { /* 半写入心跳忽略，下个周期覆盖 */ }
  }
  return { active: [...active], byInstance };
}
const authorized = (req: IncomingMessage, url: URL): boolean => !authToken || req.headers.authorization === `Bearer ${authToken}` || url.searchParams.get("token") === authToken;
/** 问责主体来自鉴权上下文，不接受请求体自报身份。 */
const principal = (): string => authToken ? "token-owner" : "local-user";

export interface ServerOptions {
  host: string;
  port: number;
  authToken?: string;
  dataDir?: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error("请求体不是合法 JSON"); }
}

function sseInit(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
  });
  res.write(": connected\n\n");
}

function sseSend(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端断开 */ }
}

export async function startServer(os: AgentOS, options: ServerOptions): Promise<Server> {
  const loopback = options.host === "localhost" || options.host === "::1" || /^127\./.test(options.host);
  if (!loopback && !options.authToken) throw new Error(`监听 ${options.host || "所有接口"} 非回环地址：必须配置 API token（--token 或 AGENTOS_API_TOKEN），拒绝无鉴权暴露`);
  authToken = options.authToken;
  if (options.dataDir) {
    runtimeDir = join(options.dataDir, "runtime"); mkdirSync(runtimeDir, { recursive: true });
    const hb = setInterval(() => { try { writeFileSync(join(runtimeDir, `active-${runtimeId}.json`), JSON.stringify({ instanceId: runtimeId, runs: [...activeRuns], ts: Date.now() })); } catch { /* 心跳失败不影响主流程 */ } }, 1500);
    hb.unref?.();
    process.once("exit", () => { try { rmSync(join(runtimeDir, `active-${runtimeId}.json`)); } catch { /* 已退出 */ } });
  }
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
  if (path.startsWith("/api/") && !authorized(req, url)) { json(res, 401, { error: "需要访问令牌：Bearer <token> 或 ?token=<token>" }); return; }

  if (path === "/" || path === "/index.html") {
    const p = join(WEB_DIR, "index.html");
    if (!existsSync(p)) { json(res, 404, { error: "Web UI 文件缺失" }); return; }
    const html = readFileSync(p, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }

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
      evolution: {
        loopDetectionThreshold: os.config.budget.loopDetectionThreshold,
        compactTokens: os.config.budget.compactTokens ?? null,
        stateFile: "data/evolve/state.json",
        policy: policySnapshot(os.policy),
        meta: loadMetaState(os.root),
      },
      sessionCount: os.sessions.list().length,
    });
    return;
  }

  if (path === "/api/sessions" && method === "GET") {
    const c = clusterActive();
    const sessions = os.sessions.list().slice(0, 60).map((m) => ({ ...m, running: c.active.includes(m.id) }));
    json(res, 200, { sessions, runningCount: c.active.length, instances: c.byInstance });
    return;
  }
  if (path === "/api/events/stream" && method === "GET") {
    sseInit(res);
    sseSend(res, "snapshot", { active: clusterActive().active, clusterSeq: os.orchestrator.seq() });
    const off = os.runtime.bus.on("*", (e: Event) => sseSend(res, "event", e));
    let cursor = os.orchestrator.seq();
    const hb = setInterval(() => { const c = clusterActive(); sseSend(res, "running-snapshot", { active: c.active, instances: c.byInstance }); }, 2000);
    const tail = setInterval(() => {
      for (const e of os.orchestrator.eventsSince(cursor)) { cursor = Math.max(cursor, e.seq ?? 0); sseSend(res, "event", e); }
    }, 1000);
    res.on("close", () => { clearInterval(hb); clearInterval(tail); off(); });
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
  if (path === "/api/whitebox/replay" && method === "GET") {
    let events: Record<string, unknown>[] = [];
    try {
      const p = join(os.root, "data/evidence/whitebox-panel.json");
      const d = JSON.parse(readFileSync(p, "utf8")) as { timeline?: Array<Record<string, unknown>> };
      events = (d.timeline ?? []).filter((e) => e.lane === "模型进化" || e.lane === "harness 进化")
        .map((e, i) => ({ seq: 900 + i, type: e.type, lane: e.lane, label: e.label, decision: e.decision, payload: { source: "whitebox-panel.json", note: "evidence 回放·非实时" } }));
    } catch { /* evidence 缺失则为空，不伪造 */ }
    json(res, 200, { source: "replay", events, honest: "evidence 回放，非实时，不冒充真实执行" });
    return;
  }

  if (path === "/api/maf" || path.startsWith("/api/maf/")) {
    const b = method === "POST" ? await bodyJson(req) : {};
    const str = (k: string): string => String(b[k] ?? "").trim();
    if (path === "/api/maf" && method === "GET") { json(res, 200, os.maf.list()); return; }
    if (path === "/api/maf/audit" && method === "GET") { json(res, 200, { audit: os.maf.auditTrail(), orchestration: os.orchestrator.audit() }); return; }
    if (path === "/api/maf/cluster" && method === "GET") { json(res, 200, os.orchestrator.cluster()); return; }
    if (path === "/api/maf/events" && method === "GET") {
      const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0), limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
      const all = os.sessions.list().flatMap((m) => os.getSession(m.id)?.trajectory.events() ?? []);
      const systemPath = join(os.root, "data", "system.jsonl");
      if (existsSync(systemPath)) for (const line of readFileSync(systemPath, "utf8").split("\n")) { try { const e = JSON.parse(line) as Event; if (e.seq && e.ts) all.push(e); } catch { /* 残缺末行忽略 */ } }
      all.push(...os.orchestrator.events());
      all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || a.seq - b.seq);
      json(res, 200, { total: all.length, cursor, events: all.slice(cursor, cursor + limit), nextCursor: cursor + limit < all.length ? cursor + limit : null });
      return;
    }
    if (path === "/api/maf/route" && method === "GET") { json(res, 200, { agent: os.maf.activeForDomain(url.searchParams.get("domain") ?? "") ?? null }); return; }
    if (path.startsWith("/api/maf/reproduce/") && method === "GET") {
      const [agentId, version] = path.slice("/api/maf/reproduce/".length).split("/");
      const agent = os.maf.getAgent(agentId ?? "", version ?? "");
      if (!agent) { json(res, 404, { error: "版本不存在" }); return; }
      json(res, 200, { agent, scenario: os.maf.scenario(agent.scenarioId), evaluation: os.maf.getEvaluation(agent.agentId, agent.version), release: os.maf.release(agent.agentId), audit: os.maf.auditTrail().filter((a) => a.refs.agentId === agent.agentId) });
      return;
    }
    if (path === "/api/maf/scenarios" && method === "POST") { json(res, 201, { scenario: os.maf.createScenario(b as never) }); return; }
    if (path === "/api/maf/candidates" && method === "POST") { json(res, 201, { agent: os.maf.createAgent(b as never) }); return; }
    if (path === "/api/maf/evaluate" && method === "POST") { json(res, 200, { report: await os.maf.evaluate(str("agentId"), str("version")) }); return; }
    if (path === "/api/maf/publish" && method === "POST") { json(res, 200, { agent: os.maf.publish(str("agentId"), str("version"), principal(), b.allowLimitedEvidence === true) }); return; }
    if (path === "/api/maf/rollback" && method === "POST") { json(res, 200, { agent: os.maf.rollback(str("agentId"), str("targetVersion"), principal()) }); return; }
    if (path === "/api/maf/revoke" && method === "POST") { os.maf.revoke(str("agentId"), principal()); json(res, 200, { ok: true }); return; }
    if (path === "/api/maf/distill" && method === "POST") { json(res, 201, { block: os.maf.distill(str("agentId"), str("version"), principal()) }); return; }
    if (path === "/api/maf/promote-block" && method === "POST") { json(res, 200, { block: os.maf.promoteBlock(str("blockId"), str("transferReportId"), str("globalReportId"), principal()) }); return; }
    if (path === "/api/maf/tasks" && method === "GET") { json(res, 200, { tasks: os.orchestrator.list(), due: os.orchestrator.runDue().map((t) => t.id) }); return; }
    if (path === "/api/maf/tasks" && method === "POST") { json(res, 201, { task: os.orchestrator.submit(b as never) }); return; }
    const runMatch = path.match(/^\/api\/maf\/tasks\/([^/]+)\/run$/);
    if (runMatch && method === "POST") { json(res, 200, { task: await os.orchestrator.run(decodeURIComponent(runMatch[1]!)) }); return; }
    const cancelMatch = path.match(/^\/api\/maf\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") { json(res, 200, { task: os.orchestrator.cancel(decodeURIComponent(cancelMatch[1]!)) }); return; }
    json(res, 404, { error: `未知 MAF 路由: ${method} ${path}` }); return;
  }
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

  if (path === "/api/model" && method === "POST") {
    const b = await bodyJson(req);
    try { os.router.setDefault(String(b.name ?? "")); json(res, 200, { ok: true, model: os.router.defaultName }); }
    catch (err) { json(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
    return;
  }

  if (path === "/api/chat" && method === "POST") {
    const b = await bodyJson(req);
    const text = String(b.text ?? "").trim();
    if (!text && !Array.isArray(b.images)) { json(res, 400, { error: "text 与 images 不能同时为空" }); return; }
    let images: ImagePart[] = [];
    try { images = normalizeImages(b.images); }
    catch (err) { json(res, 400, { error: err instanceof Error ? err.message : String(err) }); return; }
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
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);
    activeRuns.add(sessionId);
    sseSend(res, "running", { sessionId, running: true });
    os.run(sessionId, text, {
      ...(images.length ? { images } : {}),
      onChunk: (c) => sseSend(res, "chunk", c),
    })
      .then((r) => sseSend(res, "done", r))
      .catch((err) => sseSend(res, "error", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        activeRuns.delete(sessionId);
        sseSend(res, "running", { sessionId, running: false });
        clearInterval(heartbeat);
        dispose();
        if (!res.writableEnded) res.end();
      });
    return;
  }

  json(res, 404, { error: `未知路由: ${method} ${path}` });
}

export { EventType };
