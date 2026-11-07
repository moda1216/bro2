/**
 * Ollama 接入链路实证（离线可跑，无需 GPU / 真实模型）
 *
 * 验证四件事：
 *  1) 本地端点免 API Key 即可完成 /v1/models + /v1/chat/completions 对接
 *  2) probe() 能正确判定「原生 tool_calls」与「模型不支持工具」
 *  3) 完整闭环：SSE 流式 → tool_calls delta 合并 → 真实工具执行 → 结果回喂 → 终答
 *  4) live 评测的 strict 模式：端点不可达时明确失败，绝不静默降级到 Mock 伪造成功
 *
 * 运行：node --experimental-strip-types --no-warnings examples/ollama-check.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { EventType } from "../src/kernel/events.ts";
import type { Event, ToolCall } from "../src/kernel/events.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import type { ModelProbeResult } from "../src/models/openai-compat.ts";
import { startOllamaBridge } from "./ollama-bridge.ts";
import type { Bridge } from "./ollama-bridge.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const line = (s = ""): void => process.stdout.write(s + "\n");
const hr = (t: string): void => line("\n" + "=".repeat(84) + "\n  " + t + "\n" + "=".repeat(84));

function printProbe(r: ModelProbeResult): void {
  line(`  endpoint     : ${r.endpoint}   model=${r.model}`);
  line(`  reachable    : ${r.reachable ? "✓" : "✗"}   models=[${r.models.join(", ")}]   ${r.latencyMs}ms`);
  line(`  streaming    : ${r.streaming ? "✓ SSE" : "✗"}     modelResponded=${r.modelResponded ? "✓" : "✗"}`);
  line(`  toolCalling  : ${r.toolCalling}   ← Agent 能否使用工具的硬前提`);
  for (const w of r.warnings) line(`  ! ${w}`);
  for (const s of r.suggestions) line(`  → ${s}`);
}

function countProtocol(events: readonly Event[]): { calls: number; results: number; violations: number } {
  const ids = new Set<string>();
  let calls = 0;
  let results = 0;
  for (const e of events) {
    if (e.type === EventType.ToolCall) {
      const arr = (e.payload.calls as ToolCall[] | undefined) ?? [];
      calls += arr.length;
      for (const c of arr) ids.add(c.id);
    }
    if (e.type === EventType.ToolResult) {
      const r = e.payload.result as { callId?: string } | undefined;
      if (r?.callId) { results += 1; ids.delete(r.callId); }
    }
  }
  return { calls, results, violations: ids.size };
}

const tmp = mkdtempSync(join(tmpdir(), "agentos-ollama-"));
const ws = join(tmp, "ws");
let failed = false;

// ---------------------------------------------------------------- 1) 原生 tool calling 端点
hr("1 / 4  接入 Ollama 兼容端点（native 工具调用）");
const bridge: Bridge = await startOllamaBridge("native");
process.env.OLLAMA_BASE_URL = bridge.url;
process.env.OLLAMA_MODEL = bridge.model;
delete process.env.OLLAMA_API_KEY; // 关键：本地端点不提供任何密钥

const os = createAgentOS({
  root: ROOT,
  autoApprove: true,
  plugins: [],
  config: {
    storage: { dir: tmp },
    permission: { workspace: ws, allowedPaths: [ws] },
  },
});
const provider = os.providers.get("ollama");
if (!(provider instanceof OpenAICompatProvider)) throw new Error("ollama provider 未注册");
line(`  provider configured = ${provider.configured} （未设置 API Key 仍为 true → 本地端点免认证生效）`);
const probe = await provider.probe();
printProbe(probe);
if (!probe.reachable || probe.toolCalling !== "native" || !probe.streaming) failed = true;

// ---------------------------------------------------------------- 2) 完整 Agent 闭环
hr("2 / 4  真实 HTTP 链路：模型 → 工具 → 回喂 → 终答");
os.router.setDefault("ollama");
os.router.setStrict(true); // 与 live 评测一致：禁止降级到 Mock
const s = os.createSession("standard");
const run = await os.run(s.id, "请计算 sum([7,8,15]) 并说明结果");
const events = s.trajectory.events();
const proto = countProtocol(events);
line(`  stoppedBy    : ${run.stoppedBy}   步数 ${run.steps + 1}   工具调用 ${run.toolCallCount}`);
line(`  终答         : ${run.answer.replace(/\n/g, " ")}`);
line(`  Trajectory   : ${events.length} 条事件 / tool_call ${proto.calls} / tool_result ${proto.results} / 未配对 ${proto.violations}`);
const assistantEvents = events.filter((e) => e.type === EventType.AssistantMessage);
const actualProvider = String(assistantEvents.at(-1)?.payload.provider ?? "");
line(`  实际 provider: ${actualProvider}  （应为 ollama，而非 mock）`);
const noAuth = bridge.records.length > 0 && bridge.records.every((r) => !r.hasAuth);
const sawToolFeedback = bridge.records.some((r) => r.messageRoles.includes("tool"));
const sawStream = bridge.records.some((r) => r.stream);
line(`  请求校验     : 免 Authorization=${noAuth ? "✓" : "✗"}  流式=${sawStream ? "✓" : "✗"}  工具结果已回喂=${sawToolFeedback ? "✓" : "✗"}`);
if (run.stoppedBy !== "completed" || proto.calls === 0 || proto.violations > 0 || !noAuth || !sawToolFeedback || !actualProvider.includes("ollama")) failed = true;

// ---------------------------------------------------------------- 3) 不支持工具的模型
hr("3 / 4  能力探针诊断：换一个不支持 function calling 的本地小模型");
const badBridge = await startOllamaBridge("unsupported");
process.env.OLLAMA_BASE_URL = badBridge.url;
const os2 = createAgentOS({
  root: ROOT, autoApprove: true, plugins: [],
  config: { storage: { dir: join(tmp, "b") }, permission: { workspace: ws, allowedPaths: [ws] } },
});
const badProvider = os2.providers.get("ollama");
if (!(badProvider instanceof OpenAICompatProvider)) throw new Error("ollama provider 未注册");
const badProbe = await badProvider.probe();
printProbe(badProbe);
if (badProbe.toolCalling === "native") failed = true;
await os2.shutdown();
await badBridge.close();

// ---------------------------------------------------------------- 4) strict 不静默降级
hr("4 / 4  端点不可达时：strict 模式必须明确失败，不得用 Mock 伪造成功");
await bridge.close();
const s2 = os.createSession("standard");
const run2 = await os.run(s2.id, "再算一次 sum([1,2])");
line(`  stoppedBy    : ${run2.stoppedBy}`);
line(`  answer       : ${run2.answer.replace(/\n/g, " ").slice(0, 160)}`);
const honest = run2.stoppedBy === "provider_error" || run2.stoppedBy === "error";
line(`  未伪造成功   : ${honest ? "✓" : "✗ 仍返回了 completed，说明发生了静默降级"}`);
if (!honest) failed = true;

// ---------------------------------------------------------------- 汇总
hr("结论");
line(`  协议对接、能力探针、完整闭环、严格模式：${failed ? "存在失败项 ✗" : "全部通过 ✓"}`);
line("  注：本沙箱无 Ollama 二进制与 GPU，以上为 OpenAI 兼容协议的仿真验证；");
line("      真实本地模型只需把 OLLAMA_BASE_URL 指向 http://127.0.0.1:11434/v1。");

await os.shutdown();
rmSync(tmp, { recursive: true, force: true });
if (failed) process.exitCode = 1;
