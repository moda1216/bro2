import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentOS } from "../src/index.ts";
import { startServer } from "../src/interfaces/api.ts";

const ROOT = join(import.meta.dirname, "..");
const cases = () => Object.fromEntries(["visible", "hidden", "replay", "shadow"].map((s) => [s, [{ id: `${s}-1`, input: "x", expected: "x;" }]]));

test("非回环监听无 token 直接拒绝启动；带 token 时鉴权强制、问责主体不信任请求体自报", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "api-auth-"));
  const os = createAgentOS({ root: ROOT, autoApprove: true, plugins: [], config: { storage: { dir: tmp }, permission: { workspace: tmp, allowedPaths: [tmp] } } as never });
  t.after(async () => { await os.shutdown(); rmSync(tmp, { recursive: true, force: true }); });
  await assert.rejects(() => startServer(os, { host: "0.0.0.0", port: 0 }), /必须配置 API token/);
  const server = await startServer(os, { host: "127.0.0.1", port: 0, authToken: "secret-42", dataDir: tmp });
  t.after(() => server.close());
  const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${addr.port}`;
  const GET = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
  assert.equal((await GET("/api/maf")).status, 401, "无 token 被拒");
  assert.equal((await GET("/api/maf", { authorization: "Bearer wrong" })).status, 401, "错 token 被拒");
  assert.equal((await GET("/api/maf?token=secret-42")).status, 200, "SSE 可用的 query token 被接受");
  assert.equal((await GET("/api/maf", { authorization: "Bearer secret-42" })).status, 200, "Bearer 被接受");
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret-42" }, body: JSON.stringify(body) });
  const s = await (await post("/api/maf/scenarios", { name: "鉴权", domain: "programming", cases: cases() })).json();
  const root = await (await post("/api/maf/candidates", { scenarioId: s.scenario.id, blocks: ["identity"], reason: "基线" })).json();
  const cand = await (await post("/api/maf/candidates", { scenarioId: s.scenario.id, agentId: root.agent.agentId, parentVersion: root.agent.version, blocks: ["semicolon"], reason: "候选" })).json();
  await post("/api/maf/evaluate", { agentId: cand.agent.agentId, version: cand.agent.version });
  await post("/api/maf/publish", { agentId: cand.agent.agentId, version: cand.agent.version, actor: "自报管理员", allowLimitedEvidence: true });
  const audit = await (await GET("/api/maf/audit", { authorization: "Bearer secret-42" })).json();
  const pub = audit.audit.find((a: { action: string }) => a.action === "agent.publish");
  assert.equal(pub.actor, "token-owner", "请求体自报 actor 不生效，问责主体来自鉴权上下文");
});

test("白盒跨实例运行态：另一个实例的心跳经 HTTP 合并进运行中列表", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "api-runs-"));
  const os = createAgentOS({ root: ROOT, autoApprove: true, plugins: [], config: { storage: { dir: tmp }, permission: { workspace: tmp, allowedPaths: [tmp] } } as never });
  t.after(async () => { await os.shutdown(); rmSync(tmp, { recursive: true, force: true }); });
  const server = await startServer(os, { host: "127.0.0.1", port: 0, dataDir: tmp });
  t.after(() => server.close());
  const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("no port");
  mkdirSync(join(tmp, "runtime"), { recursive: true });
  writeFileSync(join(tmp, "runtime", "active-other-instance.json"), JSON.stringify({ instanceId: "other-instance", runs: ["peer-session-1", "peer-session-2"], ts: Date.now() }));
  const body = await (await fetch(`http://127.0.0.1:${addr.port}/api/sessions`)).json();
  assert.equal(body.runningCount, 2, "连本实例也能看到其他实例的运行中任务");
  assert.deepEqual(body.instances["other-instance"], 2);
  const ctrl = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${addr.port}/api/events/stream`, { signal: ctrl.signal });
  const reader = stream.body!.getReader(); const chunks: string[] = [];
  while (chunks.join("").indexOf("\n\n") < 0) chunks.push(new TextDecoder().decode((await reader.read()).value ?? new Uint8Array()));
  ctrl.abort();
  assert.match(chunks.join(""), /peer-session-1/, "SSE 首帧快照也包含跨实例运行态");
});
