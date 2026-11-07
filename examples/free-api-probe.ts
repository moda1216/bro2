/**
 * 免费 LLM API 接入链路探针（离线可跑，无需 GPU / 真实模型）
 *
 * 目的：确认 bro2 的 OpenAI 兼容适配器能对接主流「免费 / 免费额度」服务，
 * 并在接入前就暴露「端点可达 / 需 API Key / 模型不支持工具」等关键信息。
 *
 * 这些服务本身体积小、免本地算力，正好补齐「本地只能跑 0.5B 小模型」的短板：
 * 拿到一个免费 Key 后，一条 `npm run eval:live` 即可用真实强模型测 bro2 的 harness。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/free-api-probe.ts
 *
 * 说明：未设置 API Key 时，脚本仍会探测「网络可达性 + 是否需要鉴权」，
 *       这正是接入前最有价值的信息；真正的 tool_calls 能力需填入 Key 后复测。
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import type { ModelProbeResult } from "../src/models/openai-compat.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const line = (s = ""): void => process.stdout.write(s + "\n");
const hr = (t: string): void => line("\n" + "=".repeat(84) + "\n  " + t + "\n" + "=".repeat(84));

/** 各免费服务的默认模型（仅用于让探针发出合法请求；真实使用时用 *_{NAME}_MODEL 覆盖）。 */
const FALLBACK: Record<string, { model: string; env: string }> = {
  openrouter: { model: "deepseek/deepseek-chat-v3.1:free", env: "OPENROUTER_MODEL" },
  "nvidia-nim": { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", env: "NVIDIA_NIM_MODEL" },
  siliconflow: { model: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B", env: "SILICONFLOW_MODEL" },
  deepseek: { model: "deepseek-chat", env: "DEEPSEEK_MODEL" },
  groq: { model: "openai/gpt-oss-120b", env: "GROQ_MODEL" },
};

// 给未设置的模型环境变量一个兜底值，使探针能发出合法请求（不依赖真实 Key）。
for (const [name, fb] of Object.entries(FALLBACK)) {
  if (!process.env[fb.env]) process.env[fb.env] = fb.model;
}

const os = createAgentOS({
  root: ROOT,
  autoApprove: true,
  plugins: [],
  config: { storage: { dir: "./data" }, permission: { workspace: "./data/workspace", allowedPaths: ["./data/workspace"] } },
});

const providers = Object.keys(FALLBACK);
let allReachable = true;

hr("免费 LLM API 接入探针 · bro2 OpenAI 兼容适配器");
line("  说明：本探针只验证「传输层可达 + 鉴权状态」，不消耗真实额度（除非填入 Key）。");
line("");

for (const name of providers) {
  const p = os.providers.get(name);
  if (!(p instanceof OpenAICompatProvider)) {
    line(`  ✗ ${name}: 未注册为 OpenAI 兼容 provider`);
    allReachable = false;
    continue;
  }
  const r: ModelProbeResult = await p.probe();
  const cred = p.configured ? "已具备" : "未具备（缺 API Key）";
  line(`  ── ${name} ──`);
  line(`     endpoint      : ${r.endpoint}`);
  line(`     凭据状态     : ${cred}   networkReachable=${r.networkReachable ? "✓" : "✗"}   authRejected=${r.authRejected ? "✓ 需鉴权" : "✗"}`);
  line(`     httpStatus    : ${r.httpStatus ?? "无响应"}`);
  if (r.reachable) {
    line(`     toolCalling  : ${r.toolCalling}   streaming=${r.streaming ? "✓" : "✗"}`);
  } else if (!r.networkReachable) {
    line(`     结论          : 网络不可达（沙箱/防火墙限制；换环境或配代理后重试）`);
    allReachable = false;
  } else if (r.authRejected) {
    line(`     结论          : 端点可达，填入对应 API Key 即可接入`);
  }
  for (const w of r.warnings) line(`     ! ${w}`);
}

hr("接入结论");
line(`  全部端点网络可达：${allReachable ? "✓" : "部分受限（见上）"}`);
line("");
line("  下一步（拿到任意一家免费 Key 后，一条命令用真实强模型评测 bro2）：");
line("    export OPENROUTER_API_KEY=sk-or-...     # 以 OpenRouter 为例");
line("    export OPENROUTER_MODEL=openai/gpt-oss-120b");
line("    AGENTOS_LIVE_PROVIDER=openrouter npm run preflight   # 先过门禁");
line("    AGENTOS_LIVE_PROVIDER=openrouter npm run eval:live   # 拿第一份真实强模型分数");
line("");
line("  详见 docs/FREE-LLM-APIS.md（含各平台免费模型、速率限制与国内直连情况）。");

await os.shutdown();
