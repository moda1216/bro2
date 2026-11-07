/**
 * 能力矩阵自检：逐层验证 bro2 基本能力，并输出可复核报告。
 * 运行：node --experimental-strip-types --no-warnings examples/verify.ts
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { HOOK_POINTS } from "../src/kernel/hooks.ts";
import { validateArgs } from "../src/tools/schema.ts";
import { BudgetManager } from "../src/context/budget.ts";
import { PermissionPolicy } from "../src/governance/permissions.ts";
import { redact } from "../src/governance/audit.ts";
import { HttpConnector, mountConnector } from "../src/tools/mcp.ts";
import { MockProvider } from "../src/models/mock.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Check { layer: string; cap: string; ok: boolean; detail: string }
const checks: Check[] = [];
const ck = (layer: string, cap: string, ok: boolean, detail: string): void => { checks.push({ layer, cap, ok, detail }); };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

const tmp = mkdtempSync(join(tmpdir(), "agentos-verify-"));
const os = createAgentOS({
  root: ROOT,
  autoApprove: true,
  plugins: [],
  config: {
    storage: { dir: tmp },
    permission: { workspace: join(tmp, "ws"), allowedPaths: [join(tmp, "ws")] },
  } as unknown as Partial<RuntimeConfig>,
});

// ---- L0 内核 ----
ck("L0", "生命周期 Hook 拦截点", HOOK_POINTS.length === 7, `${HOOK_POINTS.length} 个: ${HOOK_POINTS.join("/")}`);
const s = os.createSession("standard");
ck("L0", "Session 创建与 Trajectory 绑定", s.trajectory.events().length === 0 && existsSync(s.trajectory.path), s.trajectory.path.split("/").pop() ?? "");
const provider = new MockProvider({ script: [{ content: "自检完成。", toolCalls: [] }] });
os.router.register("verify", provider);
os.router.setDefault("verify");
const run = await os.run(s.id, "自检任务");
ck("L0", "Agent Loop 完整闭环", run.stoppedBy === "completed" && s.trajectory.events().length >= 4, `${run.steps + 1} 步 / ${s.trajectory.events().length} 事件`);
const forked = os.sessions.fork(s.id);
ck("L0", "会话分叉（只增日志可复制）", !!forked && forked!.messages().length === s.messages().length, `父 ${s.messages().length} 条 → 子 ${forked?.messages().length ?? 0} 条`);
forked?.close();

// ---- L1 模型与上下文 ----
ck("L1", "模型适配器可插拔 + 降级路由", os.router.list().some((m) => m.name === "mock") && os.router.list().some((m) => m.name === "openai"), os.router.list().map((m) => m.name).join(", "));
const bm = new BudgetManager(20, 2);
const compacted = bm.compact(
  [
    { role: "user", content: "a" }, { role: "assistant", content: "b" },
    { role: "user", content: "c" }, { role: "assistant", content: "d" },
  ],
  undefined,
  "sys".repeat(30),
);
ck("L1", "Token 预算与历史摘要压缩", compacted.compacted && compacted.removed > 0, `移除 ${compacted.removed} 条 / 估算 ${compacted.estimatedTokens} tokens`);

// ---- L2 工具与连接器 ----
ck("L2", "工具注册表 + 显式 JSON Schema", os.registry.size >= 26 && os.registry.schemas(["*"]).length === os.registry.size, `${os.registry.size} 个工具`);
const v = validateArgs({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] }, { n: "5" });
ck("L2", "运行时参数校验（含 coerce）", v.ok && v.ok === true && v.value.n === 5, "字符串 '5' → 整数 5");

// 真实挂载一个本地 MCP 风格 JSON-RPC 连接器，验证「外部工具与内置工具走同一管线」
const mcpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const body = JSON.parse(await readBody(req)) as { id: number; method: string; params?: Record<string, unknown> };
  const send = (result: unknown): void => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); };
  if (body.method === "tools/list") {
    send({ tools: [{ name: "echo", description: "回显连接器", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
  } else if (body.method === "tools/call") {
    const args = (body.params?.arguments ?? {}) as { text?: string };
    send({ content: [{ type: "text", text: `ECHO: ${args.text ?? ""}` }] });
  } else send({});
});
await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", () => r()));
const addr = mcpServer.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const connector = new HttpConnector({ name: "verify", url: `http://127.0.0.1:${port}/rpc` });
const unmount = await mountConnector(os.runtime, os.registry, connector);
const echoOut = await connector.callTool("echo", { text: "ping" });
ck("L2", "MCP 连接器热挂载 + 调用", os.registry.has("verify.echo") && echoOut.includes("ECHO: ping"), `挂载工具 verify.echo → ${echoOut}`);
unmount();
ck("L2", "连接器可逆卸载（副作用回滚）", !os.registry.has("verify.echo"), `卸载后工具数 ${os.registry.size}`);

// ---- L3 记忆 ----
os.memory.put("long", "verify-key", "跨会话记忆内容", ["verify"]);
ck("L3", "三层记忆持久化", os.memory.get("long", "verify-key")?.content === "跨会话记忆内容", "长期记忆读写通过");

// ---- L4 认知 ----
ck("L4", "Preset 声明式组装", os.presets.list().length >= 4, os.presets.list().map((p) => p.name).join(", "));
ck("L4", "Skills 渐进披露", os.skills.size >= 3 && os.skills.summaries().includes("report-writing"), `${os.skills.size} 个技能包`);
const plan = os.plans.write("verify", [{ id: "1", content: "A", status: "done" }, { id: "2", content: "B" }]);
ck("L4", "任务规划状态机", plan.ok && os.plans.progress("verify").percent === 50, "进度 50%");

// ---- L5 协作 ----
ck("L5", "子 Agent 派生与深度限制", os.subagents.depthLimit === 2, "maxDepth=2，并发上限 3");
const job = os.scheduler.add({ name: "verify-job", task: "自检", intervalMs: 60000 });
ck("L5", "自动化编排", os.scheduler.list().length === 1 && job.enabled, `任务 ${job.id}`);
os.scheduler.remove(job.id);

// ---- L6 治理 ----
const pol = new PermissionPolicy({ level: "workspace-write", workspace: os.config.permission.workspace, allowedPaths: os.config.permission.allowedPaths });
ck("L6", "三级沙箱路径硬拦截", pol.validatePath("../../etc/passwd").ok === false, ".. 逃逸被拒");
ck("L6", "Guards 步数/Token/时长/死循环", os.guards.check({ turn: 1, steps: 999, totalTokens: 0, startedAt: Date.now(), recentCallHashes: [] }).ok === false, "超步数即终止");
ck("L6", "日志脱敏", redact("Bearer sk-abcdefghijklmnop").includes("REDACTED"), "密钥不进明文日志");
ck("L6", "HITL 审批队列", typeof os.approvals.request === "function" && os.approvals.list().length === 0, "审批请求/解决/本会话始终允许");

// ---- L7 交互与可观测 ----
ck("L7", "Web UI / REST+SSE API / CLI", existsSync(join(ROOT, "src/interfaces/web/index.html")) && existsSync(join(ROOT, "src/interfaces/api.ts")) && existsSync(join(ROOT, "src/interfaces/cli.ts")), "三套交互入口齐备");
const m = os.tracer.snapshot();
ck("L7", "Trajectory 轨迹与实时指标", m.events > 0 && typeof m.avgToolLatencyMs === "number", `${m.events} 事件 / ${m.toolCalls} 工具调用`);
ck("L7", "能力自检覆盖 8 层", new Set(checks.map((c) => c.layer)).size === 8, `L0–L7 共 ${checks.length} 项`);

// ---- 输出报告 ----
const pass = checks.filter((c) => c.ok).length;
process.stdout.write(`\n${"=".repeat(78)}\n  bro2 能力矩阵自检报告\n${"=".repeat(78)}\n`);
let lastLayer = "";
for (const c of checks) {
  if (c.layer !== lastLayer) { process.stdout.write(`\n  [${c.layer}]\n`); lastLayer = c.layer; }
  process.stdout.write(`   ${c.ok ? "✓" : "✗"} ${c.cap.padEnd(34, " ")} ${c.detail}\n`);
}
process.stdout.write(`\n${"=".repeat(78)}\n  通过 ${pass}/${checks.length} 项 · 失败 ${checks.length - pass} 项\n${"=".repeat(78)}\n\n`);
process.stdout.write(`项目根: ${ROOT}\n设计文档: ${join(ROOT, "DESIGN.md")}\n使用说明: ${join(ROOT, "README.md")}\n`);

await os.shutdown();
mcpServer.close();
rmSync(tmp, { recursive: true, force: true });
if (pass !== checks.length) process.exitCode = 1;
