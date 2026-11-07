/**
 * L1 模型层 · OpenAI 兼容 Provider（内置 fetch，零依赖）
 *
 * 支持流式 SSE、tool_calls delta 合并、超时与可传播取消、指数退避重试，
 * 以及对畸形响应的严格拒绝（触发上层熔断）。
 *
 * 兼容面：OpenAI / DeepSeek / vLLM / LM Studio / Ollama(/v1) 等任意
 * OpenAI Chat Completions 端点。本地端点（localhost / 127.0.0.1 / ::1）
 * 允许无 API Key；probe() 可在接入前探测模型是否真的支持工具调用。
 */
import { newId } from "../kernel/events.ts";
import { estimateMessagesTokens, emptyResponse } from "./base.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "./base.ts";
import type { Message, ToolCall, Usage } from "../kernel/events.ts";

export interface OpenAICompatOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  /** 无 API Key 也视为已配置。本地端点自动开启，也可显式指定。 */
  apiKeyOptional?: boolean;
  /** 请求 stream_options.include_usage，让端点回传真实 token 统计。默认开启。 */
  includeUsage?: boolean;
  /** 注入到每个请求（含 probe）的额外请求头。用于 OpenCode Zen 等需要 x-session-id 的无 Key 端点。 */
  extraHeaders?: Record<string, string>;
  /** 自动生成一个随机 UUID 并作为该请求头名发送（如 "x-session-id"），无 Key 端点据此区分匿名会话。 */
  genSessionHeader?: string;
  /**
   * 是否原生支持 function calling。由 `probe()` 的结论或配置显式声明。
   * 不设置（undefined）视为「未知→假定支持」，避免误跳可用上游；
   * 显式 false 时，聚合器在带 tools 的请求中跳过该上游。
   */
  supportsTools?: boolean;
}

export type ToolCallingSupport = "native" | "text-json" | "unsupported" | "unknown";

export interface ModelProbeResult {
  provider: string;
  endpoint: string;
  model: string;
  reachable: boolean;
  /** 端点 /v1/models 返回的本机可用模型 */
  models: string[];
  /** 该模型能否正常应答 */
  modelResponded: boolean;
  /** 是否返回 OpenAI 风格 SSE 流 */
  streaming: boolean;
  /** 是否原生返回 tool_calls（Agent 能正常用工具的硬前提） */
  toolCalling: ToolCallingSupport;
  latencyMs: number;
  /** 网络/端口层是否可达：拿到任意 HTTP 响应（含 401/403）即为 true。 */
  networkReachable: boolean;
  /** 端点可达但认证被拒（HTTP 401/403 或明确的 invalid api key 响应）。 */
  authRejected: boolean;
  /** /models 请求拿到的 HTTP 状态码；网络失败为 null。 */
  httpStatus: number | null;
  warnings: string[];
  suggestions: string[];
  rawError?: string;
}

interface PendingCall {
  id: string;
  name: string;
  arguments: string;
}

const LOCAL_HOST = /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:\d+)?(\/|$)/i;

function isLocalEndpoint(url: string): boolean {
  return LOCAL_HOST.test(url);
}

function toApiMessages(messages: readonly Message[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || "",
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function combineSignals(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("模型请求超时")), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  let signal: AbortSignal;
  if (external && typeof AbortSignal.any === "function") {
    signal = AbortSignal.any([external, controller.signal]);
  } else {
    signal = controller.signal;
  }
  return {
    signal,
    cleanup: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onAbort);
    },
  };
}

const PROBE_TOOL = {
  type: "function",
  function: {
    name: "probe_ping",
    description: "Connectivity probe. Call this function exactly once with the given value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string", description: "Echo this exact value" } },
      required: ["value"],
    },
  },
};

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly temperature: number;
  private readonly apiKeyOptional: boolean;
  private readonly includeUsage: boolean;
  private readonly extraHeaders: Record<string, string>;
  private readonly supportsTools: boolean | undefined;

  constructor(options: OpenAICompatOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.maxRetries = options.maxRetries ?? 2;
    this.temperature = options.temperature ?? 0.2;
    // 本地端点（Ollama / vLLM / LM Studio）默认不认证，无需伪造 API Key
    this.apiKeyOptional = options.apiKeyOptional ?? isLocalEndpoint(this.baseUrl);
    this.includeUsage = options.includeUsage ?? true;
    this.supportsTools = options.supportsTools;
    // 注入额外请求头（如 OpenCode Zen 的 x-session-id）；genSessionHeader 自动生成随机会话 ID
    const eh = { ...(options.extraHeaders ?? {}) };
    if (options.genSessionHeader) eh[options.genSessionHeader] = globalThis.crypto.randomUUID();
    this.extraHeaders = eh;
  }

  get configured(): boolean {
    const hasKey = this.apiKey.length > 0 || this.apiKeyOptional;
    return this.baseUrl.length > 0 && this.model.length > 0 && hasKey;
  }

  /** 供预检门禁输出（不含任何凭据）。 */
  get endpoint(): string {
    return this.baseUrl;
  }

  get targetModel(): string {
    return this.model;
  }

  /** 能力声明：是否原生支持 function calling（undefined = 未声明/未知）。供聚合器做能力感知路由。 */
  get capabilityTools(): boolean | undefined {
    return this.supportsTools;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey.length > 0) h.authorization = `Bearer ${this.apiKey}`;
    return { ...this.extraHeaders, ...h };
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!this.configured) {
      throw new Error(
        `模型 ${this.name} 未配置：请设置 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL 环境变量` +
          `（本地 Ollama 可只设 OLLAMA_BASE_URL + OLLAMA_MODEL；当前默认使用离线 Mock）`,
      );
    }
    const body = {
      model: this.model,
      messages: toApiMessages(req.messages),
      stream: true,
      ...(this.includeUsage ? { stream_options: { include_usage: true } } : {}),
      temperature: req.temperature ?? this.temperature,
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: "auto",
          }
        : {}),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 4000)));
      const { signal, cleanup } = combineSignals(req.signal, this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 400);
          const err = new Error(`HTTP ${res.status}: ${detail}`);
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
          throw err;
        }
        if (!res.body) throw new Error("模型响应缺少 body");
        const parsed = await this.parseStream(res.body, req);
        return {
          ...parsed,
          usage: this.normalizeUsage(parsed.usage, req),
          model: this.model,
          provider: this.name,
        };
      } catch (err) {
        lastError = err;
        if (req.signal?.aborted) throw err;
        if ((err as { fatal?: boolean }).fatal === true) throw err;
      } finally {
        cleanup();
      }
    }
    throw new Error(`模型 ${this.name} 请求失败（已重试 ${this.maxRetries} 次）: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  /**
   * 接入前能力探针：确认端点可达、模型存在、SSE 流式可用，
   * 以及最关键的——该模型是否原生返回 tool_calls。
   *
   * 本地小模型最常见的失败模式是「把工具描述当普通文本」，此时
   * Agent Loop 会因为零 tool_calls 直接给出终答，任务静默失败。
   * probe 把这个问题在接入阶段就暴露出来。
   */
  async probe(): Promise<ModelProbeResult> {
    const started = Date.now();
    const result: ModelProbeResult = {
      provider: this.name,
      endpoint: this.baseUrl,
      model: this.model,
      reachable: false,
      models: [],
      modelResponded: false,
      streaming: false,
      toolCalling: "unknown",
      latencyMs: 0,
      networkReachable: false,
      authRejected: false,
      httpStatus: null,
      warnings: [],
      suggestions: [],
    };

    // 1) /v1/models —— 确认端点与模型清单
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      // 拿到任意 HTTP 响应即表明网络与端口是通的；401/403 是认证问题而非网络问题。
      result.networkReachable = true;
      result.httpStatus = res.status;
      if (res.status === 401 || res.status === 403) result.authRejected = true;
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        result.models = (data.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
        result.reachable = true;
      } else {
        result.warnings.push(`/models 返回 HTTP ${res.status}${result.authRejected ? "（端点可达，认证被拒）" : ""}`);
      }
    } catch (err) {
      result.warnings.push(`/models 探测失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2) 非流式带 tools 的最小请求 —— 判断原生 function calling
    const baseMessages = [
      { role: "system", content: "You must call the provided tool to answer. Never reply with plain text." },
      { role: "user", content: "Call probe_ping with value=\"hello-agent-os\"." },
    ];
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          messages: baseMessages,
          stream: false,
          temperature: 0,
          tools: [PROBE_TOOL],
          tool_choice: "auto",
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        result.networkReachable = true;
        result.httpStatus = res.status;
        if (res.status === 401 || res.status === 403 || /invalid api key|authentication/i.test(detail)) {
          result.authRejected = true;
        }
        result.warnings.push(`探针请求 HTTP ${res.status}: ${detail}`);
      } else {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>;
        };
        const msg = data.choices?.[0]?.message;
        const content = String(msg?.content ?? "");
        result.reachable = true;
        result.modelResponded = true;
        if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
          result.toolCalling = "native";
        } else if (/probe_ping|hello-agent-os/.test(content)) {
          result.toolCalling = "text-json";
          result.warnings.push("模型把工具调用写进了正文，而不是返回 tool_calls；Agent 无法据此执行工具。");
        } else {
          result.toolCalling = "unsupported";
          result.warnings.push("模型对强制工具调用请求返回了普通文本，疑似不支持 function calling。");
        }
      }
    } catch (err) {
      result.rawError = err instanceof Error ? err.message : String(err);
      result.warnings.push(`探针请求失败: ${result.rawError}`);
    }

    // 3) 流式 —— 确认 SSE 与 tool_calls delta
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
          stream: true,
          ...(this.includeUsage ? { stream_options: { include_usage: true } } : {}),
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const first = await reader.read();
        const head = new TextDecoder().decode(first.value ?? new Uint8Array()).slice(0, 400);
        result.streaming = /^data:/m.test(head) || head.includes("choices");
        void reader.cancel().catch(() => undefined);
        result.reachable = true;
      } else if (!res.ok) {
        result.warnings.push(`流式探测 HTTP ${res.status}`);
      }
    } catch (err) {
      result.warnings.push(`流式探测失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4) 结论与可操作建议
    if (!result.reachable && !result.networkReachable) {
      result.suggestions.push("确认端点已启动：Ollama 用 `ollama serve`，默认 http://127.0.0.1:11434/v1");
      result.suggestions.push("检查 OLLAMA_BASE_URL / OLLAMA_MODEL 与防火墙设置。");
    } else if (result.authRejected) {
      result.suggestions.push(`端点可达但认证被拒（HTTP ${result.httpStatus ?? "?"}）：检查 API Key 是否正确、是否过期、是否具备该模型权限。`);
      result.suggestions.push("若是本地端点误配了认证，确认 apiKeyOptional=true 且清掉多余的 *_API_KEY 环境变量。");
    }
    if (result.models.length > 0 && !result.models.includes(this.model)) {
      result.warnings.push(`配置的模型 "${this.model}" 不在端点模型列表中。`);
      result.suggestions.push(`可用模型：${result.models.slice(0, 8).join(", ")}；用 OLLAMA_MODEL 指定其中一个。`);
    }
    // 端点不可达 / 认证未过时不能对模型能力下结论，避免给出误导性的"换模型"建议
    if (!result.reachable) {
      result.suggestions.push(result.authRejected
        ? "认证未通过，上述能力结论均不成立；先修正凭据再复测。"
        : "端点未就绪，上述能力结论均不成立；先恢复服务再复测。");
    } else if (result.toolCalling !== "native") {
      result.suggestions.push("换用带 tool-use 训练的模型（qwen3 / qwen2.5 / llama3.1:8b / mistral-nemo / gpt-oss 等）。");
      result.suggestions.push("小参数量或无工具微调的模型常不支持 function calling，Agent 会退化为纯聊天。");
      result.suggestions.push("也可先用 `AGENTOS_MODEL=mock` 验证框架链路，排除模型侧问题。");
    }
    result.latencyMs = Date.now() - started;
    return result;
  }

  private normalizeUsage(usage: Usage, req: LLMRequest): Usage {
    if (usage.inputTokens > 0) return { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
    return {
      inputTokens: estimateMessagesTokens(req.messages, req.tools),
      outputTokens: usage.outputTokens,
      totalTokens: estimateMessagesTokens(req.messages, req.tools) + usage.outputTokens,
    };
  }

  private async parseStream(body: ReadableStream<Uint8Array>, req: LLMRequest): Promise<Omit<LLMResponse, "model" | "provider">> {
    parseStreamStarted.set(body, Date.now());
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const calls = new Map<number, PendingCall>();

    const handleData = (data: string): void => {
      if (data === "[DONE]") return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return; // 忽略畸形分片，不因单个分片中断整轮
      }
      const choices = obj.choices as Array<Record<string, unknown>> | undefined;
      const delta = (choices?.[0]?.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === "string") {
        content += delta.content;
        req.onChunk?.({ kind: "text", text: delta.content });
      }
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
        req.onChunk?.({ kind: "reasoning", text: delta.reasoning_content });
      }
      const dcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(dcs)) {
        for (const dc of dcs) {
          const idx = typeof dc.index === "number" ? dc.index : 0;
          const pending = calls.get(idx) ?? { id: "", name: "", arguments: "" };
          if (typeof dc.id === "string" && dc.id) pending.id = dc.id;
          const fn = (dc.function ?? {}) as Record<string, unknown>;
          // 部分本地端点会在每个分片重复下发完整 name；跳过完全重复，避免拼成 "calc calc"
          if (typeof fn.name === "string" && fn.name && pending.name !== fn.name) pending.name += fn.name;
          if (typeof fn.arguments === "string") pending.arguments += fn.arguments;
          calls.set(idx, pending);
        }
      }
      const u = obj.usage as Record<string, unknown> | undefined;
      if (u) {
        usage = {
          inputTokens: Number(u.prompt_tokens ?? 0),
          outputTokens: Number(u.completion_tokens ?? 0),
          totalTokens: Number(u.total_tokens ?? 0),
        };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        handleData(line.slice(5).trim());
      }
    }
    // 兼容末尾无换行的分片
    const tail = buffer.trim();
    if (tail.startsWith("data:")) handleData(tail.slice(5).trim());

    // 按 index 还原并行工具调用的顺序（Map 迭代顺序不可作为语义保证）
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const toolCalls: ToolCall[] = [];
    for (const c of ordered) {
      let args: Record<string, unknown> = {};
      if (c.arguments) {
        try {
          const parsed = JSON.parse(c.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          args = {}; // 畸形参数交给工具层校验并回报模型
        }
      }
      toolCalls.push({ id: c.id || newId("call"), name: c.name, arguments: args });
      req.onChunk?.({ kind: "tool_call", text: c.name });
    }
    req.onChunk?.({ kind: "done" });

    const started = (parseStreamStarted.get(body) as number | undefined) ?? Date.now();
    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      toolCalls,
      usage: { ...usage, outputTokens: usage.outputTokens || Math.ceil(content.length / 3.2) },
      durationMs: Date.now() - started,
    };
  }
}

// 记录每次流开始时间（WeakMap 避免污染响应对象）
const parseStreamStarted = new WeakMap<object, number>();

export { emptyResponse, isLocalEndpoint };
