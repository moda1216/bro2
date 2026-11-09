/**
 * L1 模型层 · 无 Key 远程端点统一聚合器（KeylessAggregator）
 *
 * 设计目标（对标 KeylessAI / Zerogateway 的统一路由器思路）：
 *   把所有「远程、无 API Key」的 LLM 端点聚合为 **一个** OpenAI 兼容接口交给 bro2，
 *   上层（Agent Loop / eval / preflight）只感知一个 provider，无需关心背后是
 *   Pollinations、Kilo Gateway、OpenCode Zen、KeylessAI 网关还是某个 harness 插件模型。
 *
 * 智能管理（区别于「简单随机选一个」）：
 *   1) 健康跟踪（health tracking）：每个上游维护失败计数、冷却截止、限流截止、最近延迟。
 *   2) 限流感知（rate-limit aware）：识别 429 / FreeUsageLimit / Too Many Requests / 5xx，
 *      把该上游标记为「限流冷却」，把请求转发到其它可用上游，而不是反复重试打满额度。
 *   3) 故障转移（failover）：单上游失败时按健康评分自动切到下一个最优上游；
 *      切完仍全失败才抛错（绝不静默返回空响应）。
 *   4) 能力感知（capability aware）：标记「不支持 tool_calls」的上游在带 tools 的请求中
 *      被跳过，避免在真实工具调用任务上踩坑（与 OpenAICompatProvider.probe 的 toolCalling 结论联动）。
 *   5) 评分路由（smart-fallback）：综合优先级、失败惩罚、限流惩罚、延迟偏好打分选最优上游。
 *
 * 该聚合器与 HybridProvider（本地+远程协同降调用）正交：
 *   - Hybrid 解决「远程贵/限流严 × 本地弱」的调用分配问题；
 *   - KeylessAggregator 解决「远程无 Key 端点很多但各自不稳定」的统一与韧性问题。
 *   二者可嵌套：例如 hybrid.remote = keyless（用整个免 Key 网状作为远程强模型来源）。
 */
import type { LLMProvider, LLMRequest, LLMResponse } from "./base.ts";
import { EMPTY_STATS, type InferenceStats, type StatsProvider, type CompositeProvider } from "./cache.ts";

/** 限流 / 临时不可用的错误特征（与 HybridProvider 同源，集中在此定义）。 */
const RATE_LIMIT_RE =
  /429|FreeUsageLimit|FREE_LIMIT|RateLimit|Too Many Requests|Queue full|5\d\d|ETIMEDOUT|timeout|bandwidth|quota|limit exceeded/i;

/** 一个上游端点的描述（含能力元数据，由装配层从配置读取注入）。 */
export interface KeylessBackend {
  /** 已构建好的底层 provider（通常是 OpenAICompatProvider 实例）。 */
  provider: LLMProvider;
  /** 是否原生支持 function calling。false 表示带 tools 的请求应跳过该上游。 */
  supportsTools?: boolean;
  /** 优先级（越高越优先被选中）；默认 0。 */
  priority?: number;
  /** 可选标签（如 "unified-gateway" / "harness-plugin"），仅用于展示。 */
  tags?: string[];
}

export interface KeylessOptions {
  name: string;
  /** 参与聚合的上游列表（已在装配层解析为真实 provider）。 */
  backends: KeylessBackend[];
  /** 路由策略。默认 smart-fallback（评分选优 + 故障转移）。 */
  strategy?: "smart-fallback" | "round-robin" | "priority";
  /** 上游被判定「限流」后的冷却时长（ms）。默认 60_000。 */
  rateLimitCooldownMs?: number;
  /** 上游连续硬失败后的冷却时长（ms）。默认 30_000。 */
  failureCooldownMs?: number;
  /** 整体最大尝试次数（跨上游）。默认 = 上游数量 + 1。 */
  maxAttempts?: number;
  /** 全部上游失败时，作为最后兜底调用的 provider（如本地小模型）。默认无。 */
  emergencyProvider?: LLMProvider;
  /**
   * 跨会话端点先验分（v2.12.0，由 ExperienceBank 折叠注入）。
   * **只叠加到 score() 的排序**，绝不绕过冷却/限流/能力感知的硬过滤；
   * 缺省为空 → 与 v2.11.0 行为完全一致。历史失败端点因此在新进程里也从低分起步。
   */
  endpointPrior?: Record<string, number>;
  /** 每次上游调用后的成败回写钩子（由装配层接到 ExperienceBank，用于跨会话累积）。 */
  onEndpointOutcome?: (name: string, ok: boolean) => void;
}

interface BackendHealth {
  name: string;
  failures: number;
  cooldownUntil: number;
  rateLimitedUntil: number;
  lastLatencyMs: number;
  total: number;
  ok: number;
  rateLimitHits: number;
  lastError?: string;
}

export interface MeshStats {
  name: string;
  backendCount: number;
  /** 聚合器替 bro2 实际发出的上游调用次数（含失败重试）。 */
  meshAttempts: number;
  successes: number;
  failures: number;
  rateLimitFailovers: number;
  /** 每个上游的明细健康度。 */
  backends: Array<{
    name: string;
    supportsTools: boolean;
    priority: number;
    /** 跨会话经验先验分（v2.12.0）；0 = 无经验 / 已失效 / 样本不足。 */
    endpointPrior: number;
    tags: string[];
    failures: number;
    cooledDown: boolean;
    rateLimited: boolean;
    lastLatencyMs: number;
    total: number;
    ok: number;
    rateLimitHits: number;
    lastError?: string;
  }>;
}

export class KeylessAggregator implements LLMProvider, StatsProvider, CompositeProvider {
  readonly name: string;
  private readonly backends: Array<{ be: KeylessBackend; health: BackendHealth }>;
  private readonly strategy: NonNullable<KeylessOptions["strategy"]>;
  private readonly rateLimitCooldownMs: number;
  private readonly failureCooldownMs: number;
  private readonly maxAttempts: number;
  private readonly emergency?: LLMProvider;
  private readonly endpointPrior: Record<string, number>;
  private readonly onEndpointOutcome?: (name: string, ok: boolean) => void;

  // 聚合层统计（供 eval.inference 与 meshStats 使用）
  private meshAttempts = 0;
  private successes = 0;
  private failures = 0;
  private rateLimitFailovers = 0;
  private rrCursor = 0;

  constructor(opts: KeylessOptions) {
    this.name = opts.name;
    this.strategy = opts.strategy ?? "smart-fallback";
    this.rateLimitCooldownMs = opts.rateLimitCooldownMs ?? 60_000;
    this.failureCooldownMs = opts.failureCooldownMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? Math.max(1, opts.backends.length + 1);
    this.emergency = opts.emergencyProvider;
    this.endpointPrior = opts.endpointPrior ?? {};
    this.onEndpointOutcome = opts.onEndpointOutcome;
    this.backends = opts.backends.map((be) => ({
      be,
      health: {
        name: be.provider.name,
        failures: 0,
        cooldownUntil: 0,
        rateLimitedUntil: 0,
        lastLatencyMs: 0,
        total: 0,
        ok: 0,
        rateLimitHits: 0,
      },
    }));
  }

  private hasTools(req: LLMRequest): boolean {
    return Array.isArray(req.tools) && req.tools.length > 0;
  }

  /** 打分：优先级 + 跨会话先验 - 失败惩罚 - 冷却/限流惩罚 - 延迟惩罚 + 成功率奖励。 */
  private score(b: { be: KeylessBackend; health: BackendHealth }, now: number): number {
    const h = b.health;
    let s = b.be.priority ?? 0;
    // v2.12.0：跨会话经验先验只影响排序；幅度上限 ±2，远小于冷却(-4)/限流(-8)的硬过滤，
    // 且 selectBackend 先按 cooldown/rateLimited 过滤，被硬过滤的端点根本进不了打分集。
    s += this.endpointPrior[h.name] ?? 0;
    s -= h.failures * 1.5;
    if (h.cooldownUntil > now) s -= 4;
    if (h.rateLimitedUntil > now) s -= 8;
    // 延迟惩罚（上限 3），避免曾经慢的上游持续被惩罚
    s -= Math.min(3, h.lastLatencyMs / 2000);
    if (h.total > 0) s += (h.ok / h.total) * 1.0;
    return s;
  }

  /**
   * 选出本次请求的最优上游。
   * @param tried 本轮已尝试过的上游名（故障转移时不再重复选）。
   * @returns null 表示没有任何可用上游（含已冷却/已限流且全部试过）。
   */
  private selectBackend(req: LLMRequest, tried: Set<string>): { be: KeylessBackend; health: BackendHealth } | null {
    const now = Date.now();
    const needsTools = this.hasTools(req);

    const available = this.backends.filter((b) => {
      if (tried.has(b.health.name)) return false;
      // 能力感知：需要工具但该上游不支持 → 跳过
      if (needsTools && b.be.supportsTools === false) return false;
      // 主过滤器：未冷却且未限流
      return b.health.cooldownUntil <= now && b.health.rateLimitedUntil <= now;
    });

    if (available.length > 0) {
      if (this.strategy === "round-robin") {
        const next = available[this.rrCursor % available.length]!;
        this.rrCursor += 1;
        return next;
      }
      if (this.strategy === "priority") {
        return available.reduce((best, b) => ((b.be.priority ?? 0) > (best.be.priority ?? 0) ? b : best));
      }
      // smart-fallback：评分最高；并列时延迟更低者优先
      return available.reduce((best, b) => {
        const sb = this.score(b, now);
        const sBest = this.score(best, now);
        if (sb !== sBest) return sb > sBest ? b : best;
        return b.health.lastLatencyMs < best.health.lastLatencyMs ? b : best;
      });
    }

    // 主过滤器全空（都在冷却/限流）：退一步，允许尝试「仅限流」的上游作为最后一搏。
    const relaxed = this.backends.filter(
      (b) => !tried.has(b.health.name) && b.health.cooldownUntil <= now && !(needsTools && b.be.supportsTools === false),
    );
    return relaxed.length > 0 ? relaxed[0]! : null;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (this.backends.length === 0 && !this.emergency) {
      throw new Error(`KeylessAggregator "${this.name}" 没有任何可用上游端点`);
    }

    const tried = new Set<string>();
    let attempts = 0;
    let lastErr = "无可用上游";

    while (attempts < this.maxAttempts) {
      if (req.signal?.aborted) throw new Error("请求已被取消");
      const pick = this.selectBackend(req, tried);
      if (!pick) break;
      tried.add(pick.health.name);
      attempts += 1;
      this.meshAttempts += 1;

      const start = Date.now();
      try {
        const res = await pick.be.provider.complete(req);
        pick.health.total += 1;
        pick.health.ok += 1;
        pick.health.lastLatencyMs = Date.now() - start;
        this.successes += 1;
        this.onEndpointOutcome?.(pick.health.name, true);
        return { ...res, provider: `${this.name}/${res.provider}` };
      } catch (err) {
        if (req.signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        this.failures += 1;
        this.meshAttempts; // 已在循环顶部计数
        pick.health.total += 1;
        pick.health.failures += 1;
        pick.health.lastLatencyMs = Date.now() - start;
        pick.health.lastError = msg;
        this.onEndpointOutcome?.(pick.health.name, false);
        if (RATE_LIMIT_RE.test(msg)) {
          pick.health.rateLimitedUntil = Date.now() + this.rateLimitCooldownMs;
          pick.health.rateLimitHits += 1;
          this.rateLimitFailovers += 1;
        } else {
          pick.health.cooldownUntil = Date.now() + this.failureCooldownMs;
        }
        lastErr = `${pick.health.name}: ${msg}`;
        // 继续故障转移到下一个最优上游
      }
    }

    // 全部上游失败：尝试应急兜底（如本地小模型），否则抛出聚合错误
    if (this.emergency) {
      try {
        const res = await this.emergency.complete(req);
        this.successes += 1;
        return { ...res, provider: `${this.name}/${res.provider}` };
      } catch {
        // 应急也失败，落到下方抛错
      }
    }
    throw new Error(`KeylessAggregator "${this.name}" 全部上游不可用 → ${lastErr}`);
  }

  /** 聚合层推理效率统计（网状视角：每次上游调用均为远程调用）。 */
  inferenceStats(): InferenceStats {
    const total = this.meshAttempts;
    return {
      remoteCalls: this.meshAttempts,
      localCalls: 0,
      cacheHits: 0,
      remoteAvoided: 0,
      remoteCallRatio: total > 0 ? 1 : 0,
    };
  }

  /** 露出每个上游的明细健康度，供 doctor / 演示 / 评测复盘。 */
  meshStats(): MeshStats {
    return {
      name: this.name,
      backendCount: this.backends.length,
      meshAttempts: this.meshAttempts,
      successes: this.successes,
      failures: this.failures,
      rateLimitFailovers: this.rateLimitFailovers,
      backends: this.backends.map(({ be, health }) => ({
        name: health.name,
        supportsTools: be.supportsTools !== false,
        priority: be.priority ?? 0,
        endpointPrior: this.endpointPrior[health.name] ?? 0,
        tags: be.tags ?? [],
        failures: health.failures,
        cooledDown: health.cooldownUntil > Date.now(),
        rateLimited: health.rateLimitedUntil > Date.now(),
        lastLatencyMs: health.lastLatencyMs,
        total: health.total,
        ok: health.ok,
        rateLimitHits: health.rateLimitHits,
        ...(health.lastError ? { lastError: health.lastError } : {}),
      })),
    };
  }

  underlying(): LLMProvider[] {
    return this.backends.map((b) => b.be.provider);
  }
}

/** 鸭子类型判定：某 provider 是否暴露 meshStats（即 KeylessAggregator 类实例）。 */
export function isMeshProvider(p: unknown): p is KeylessAggregator {
  return !!p && typeof (p as KeylessAggregator).meshStats === "function";
}

export { EMPTY_STATS };
