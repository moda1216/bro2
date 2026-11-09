/**
 * L1 模型层 · 接入预检门禁（Preflight）
 *
 * `doctor` 面向人：把探测结果打印出来，永远退出 0，适合排查。
 * `preflight` 面向机器：把「能不能开跑 live 评测」压缩成一个布尔门禁，
 * 未就绪时退出非 0，可直接放进 CI / 脚本的 `&&` 链。
 *
 * 关键区分（真实接入时最常见的两类误判）：
 *  - 网络不可达（端点没起、/v1 前缀漏了、防火墙）→ 别去换模型；
 *  - 端点可达但 401/403（Key 错/过期/无权限）→ 别去查网络。
 * 两者在旧诊断里都被笼统报成「不可达」，会把用户引向错误方向。
 *
 * 硬前提：模型必须原生返回 tool_calls。否则 Agent Loop 因零工具调用
 * 直接给出终答，任务静默失败，评测分数会被误读成「框架能力差」。
 */
import type { OpenAICompatProvider, ModelProbeResult } from "./openai-compat.ts";

export type PreflightCheckId =
  | "configured" | "network" | "auth" | "model" | "streaming" | "toolCalling";

export interface PreflightCheck {
  id: PreflightCheckId;
  label: string;
  ok: boolean;
  detail: string;
  severity: "blocker" | "info";
}

export interface PreflightResult {
  provider: string;
  /** 端点 baseUrl（不含任何凭据）。 */
  endpoint: string;
  model: string;
  /** 是否可以开跑 live 评测。唯一门禁结论。 */
  ready: boolean;
  checks: PreflightCheck[];
  blockers: string[];
  nextSteps: string[];
  probe: ModelProbeResult | null;
  timestamp: string;
}

const LABELS: Record<PreflightCheckId, string> = {
  configured: "配置完整",
  network: "端点可达",
  auth: "认证通过",
  model: "模型可用",
  streaming: "SSE 流式",
  toolCalling: "原生 tool_calls",
};

function check(id: PreflightCheckId, ok: boolean, detail: string, severity: "blocker" | "info" = "blocker"): PreflightCheck {
  return { id, label: LABELS[id], ok, detail, severity };
}

/**
 * 对单个 OpenAI 兼容 provider 做接入预检。
 * 未配置时不发任何网络请求（避免拿空 baseUrl 去 fetch），直接给出配置指引。
 */
export async function runPreflight(provider: OpenAICompatProvider): Promise<PreflightResult> {
  const endpoint = provider.endpoint;
  const model = provider.targetModel;
  const base = { provider: provider.name, endpoint, model, timestamp: new Date().toISOString() };

  if (!provider.configured) {
    const checks: PreflightCheck[] = [
      check("configured", false, "缺少 baseUrl / model / 认证凭据"),
      check("network", false, "因未配置跳过探测", "info"),
      check("auth", false, "因未配置跳过探测", "info"),
      check("model", false, "因未配置跳过探测", "info"),
      check("streaming", false, "因未配置跳过探测", "info"),
      check("toolCalling", false, "因未配置跳过探测", "info"),
    ];
    return {
      ...base,
      ready: false,
      checks,
      blockers: ["配置完整: 缺少 baseUrl / model / 认证凭据"],
      nextSteps: [
        "本地 Ollama：export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 && export OLLAMA_MODEL=qwen3:8b",
        "云端端点：export OPENAI_BASE_URL=https://api.deepseek.com/v1 && export OPENAI_API_KEY=sk-... && export OPENAI_MODEL=deepseek-chat",
        "指定 provider：AGENTOS_LIVE_PROVIDER=ollama npm run preflight",
      ],
      probe: null,
    };
  }

  const probe = await provider.probe();
  const modelListed = probe.models.length === 0 || probe.models.includes(model);
  const checks: PreflightCheck[] = [
    check("configured", true, `endpoint=${endpoint}  model=${model}`),
    check(
      "network",
      probe.networkReachable,
      probe.networkReachable
        ? `HTTP ${probe.httpStatus ?? "?"} · ${probe.latencyMs} ms`
        : "连接失败（端点未启动 / 地址或 /v1 前缀错误 / 防火墙）",
    ),
    check(
      "auth",
      probe.networkReachable && !probe.authRejected,
      probe.authRejected
        ? `HTTP ${probe.httpStatus ?? "?"} 认证被拒：Key 错误、过期或缺少模型权限`
        : probe.networkReachable ? "认证通过（或本地端点免认证）" : "端点不可达，跳过认证判定",
      probe.networkReachable ? "blocker" : "info",
    ),
    check(
      "model",
      probe.modelResponded && modelListed,
      !probe.modelResponded
        ? "模型未返回有效应答"
        : modelListed ? "模型应答正常" : `配置的模型不在端点清单中：${probe.models.slice(0, 8).join(", ")}`,
    ),
    check(
      "streaming",
      probe.streamMode === "nonstream" ? true : probe.streaming,
      probe.streamMode === "nonstream"
        ? "已显式配置非流式（stream=false）：原生 tool_calls 由非流式探针验证，不要求 SSE"
        : probe.streaming
          ? `返回 OpenAI 风格 SSE 流；流式带 tools 的 tool_calls delta：${probe.streamToolCalls ? "有" : "无（建议该端点设 stream=false）"}`
          : "未检测到 SSE 流（live 评测使用 stream:true）",
      probe.streamMode === "nonstream" ? "info" : "blocker",
    ),
    check(
      "toolCalling",
      probe.toolCalling === "native",
      probe.toolCalling === "native"
        ? "原生返回 tool_calls"
        : `toolCalling=${probe.toolCalling}：模型不会返回可执行的工具调用，Agent 会退化为纯聊天`,
    ),
  ];

  const blockers = checks.filter((c) => !c.ok && c.severity === "blocker").map((c) => `${c.label}: ${c.detail}`);
  const nextSteps: string[] = [];
  if (!probe.networkReachable) {
    nextSteps.push("先恢复服务：Ollama 用 `ollama serve`；核对 baseUrl 的 /v1 前缀与端口。");
  } else if (probe.authRejected) {
    nextSteps.push("修正 API Key：核对值、有效期、模型权限；本地端点误配认证时清掉多余的 *_API_KEY。");
  }
  for (const s of probe.suggestions) if (!nextSteps.includes(s)) nextSteps.push(s);
  if (blockers.length === 0) {
    nextSteps.push("门禁通过，可执行：npm run eval:live");
  } else {
    nextSteps.push("门禁未通过：不要运行 eval:live，此时的低分是端点故障而非模型能力。");
  }

  return {
    ...base,
    ready: blockers.length === 0,
    checks,
    blockers,
    nextSteps,
    probe,
  };
}

export function formatPreflight(r: PreflightResult): string {
  const lines: string[] = [];
  lines.push("=".repeat(84));
  lines.push(`  bro2 · 接入预检   provider=${r.provider}   ready=${r.ready ? "✓ PASS" : "✗ BLOCKED"}`);
  lines.push("=".repeat(84));
  lines.push(`  endpoint : ${r.endpoint || "(未配置)"}`);
  lines.push(`  model    : ${r.model || "(未配置)"}`);
  lines.push("");
  for (const c of r.checks) {
    const mark = c.ok ? "✓" : c.severity === "info" ? "-" : "✗";
    lines.push(`  ${mark} ${c.label.padEnd(16)} ${c.detail}`);
  }
  if (r.blockers.length > 0) {
    lines.push("");
    lines.push("  【阻断项】");
    for (const b of r.blockers) lines.push(`    ! ${b}`);
  }
  lines.push("");
  lines.push("  【下一步】");
  for (const s of r.nextSteps) lines.push(`    → ${s}`);
  lines.push("=".repeat(84));
  return lines.join("\n");
}
