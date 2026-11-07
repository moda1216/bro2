/**
 * L1 模型层 · 本地 + 远程混合推理 provider
 *
 * 解决「远程强模型很贵/限流很严，但本地小模型又太弱」的矛盾：把每一轮 LLM
 * 调用按可插拔策略路由——便宜的调用（纯生成、工具结果整理、守卫判断）走本地
 * 小模型，需要推理/工具选择的走远程强模型。再叠加两层「降远程调用」机制：
 *
 *  1) 缓存优先（cache-first）：任何请求先查缓存，命中则零调用（无论本应走哪路）。
 *  2) 限流降级（rate-limit-fallback）：远程返回 429 / FreeUsageLimit / 5xx 时，
 *     自动降级到本地模型，而不是让整条 agent 链路失败——既保韧性，又避免对
 *     远程端点反复重试打满限额。
 *
 * 所有路由决策与调用都被计入 InferenceStats，可被 eval 报告量化呈现：
 * 「本次评测远程调用减少 N 次（缓存 X + 降级 Y）」。
 *
 * 这与 RSI / 元 RSI 形成闭环：对比式改进（src/rsi/contrast.ts）可以把
 * 「remoteAvoided 提升而分数不降」作为一条真实的改进目标，反过来优化 bro2。
 */
import type { LLMProvider, LLMRequest, LLMResponse } from "./base.ts";
import { EMPTY_STATS, type InferenceStats, type StatsProvider, type CompositeProvider } from "./cache.ts";

export type RouteDecision = "local" | "remote";

export interface RoutePolicy {
  readonly name: string;
  decide(req: LLMRequest, ctx: { turn: number }): RouteDecision;
}

/**
 * 默认策略：启发式地把「明显便宜」的调用留给本地小模型。
 *  - 无工具（纯生成/摘要）：本地足够；
 *  - 最后一条是工具结果且较短（通常只需整理或决定下一步）：本地可接；
 *  - 其余（含工具选择、需推理）：远程强模型。
 * 策略可插拔——后续可换成「本地小模型当分类器」或「按 token 预算」的版本。
 */
export const cheapToLocalPolicy: RoutePolicy = {
  name: "cheap-to-local",
  decide(req: LLMRequest): RouteDecision {
    if (!req.tools || req.tools.length === 0) return "local";
    const last = req.messages[req.messages.length - 1];
    if (last && last.role === "tool" && (last.content?.length ?? 0) < 600) return "local";
    return "remote";
  },
};

/** 全部走远程（基线，用于对照「纯远程」的远程调用数）。 */
export const remoteOnlyPolicy: RoutePolicy = {
  name: "remote-only",
  decide(): RouteDecision {
    return "remote";
  },
};

export interface HybridOptions {
  remote: LLMProvider;
  local: LLMProvider;
  policy?: RoutePolicy;
  /** 缓存优先：命中缓存的请求不产生任何远程/本地调用。默认开。 */
  cache?: boolean;
  /** 远程限流/5xx 时降级到本地。默认开。 */
  fallbackOnRateLimit?: boolean;
}

const RATE_LIMIT_RE = /429|FreeUsageLimit|RateLimit|Too Many Requests|Queue full|5\d\d|ETIMEDOUT|timeout/i;

export class HybridProvider implements LLMProvider, StatsProvider, CompositeProvider {
  readonly name: string;
  private readonly remote: LLMProvider;
  private readonly local: LLMProvider;
  private readonly policy: RoutePolicy;
  private readonly cacheEnabled: boolean;
  private readonly fallback: boolean;
  private readonly cacheStore = new Map<string, LLMResponse>();

  private localCalls = 0;
  private remoteCalls = 0;
  private cacheHits = 0;
  private fallbackCalls = 0;

  constructor(name: string, opts: HybridOptions) {
    this.name = name;
    this.remote = opts.remote;
    this.local = opts.local;
    this.policy = opts.policy ?? cheapToLocalPolicy;
    this.cacheEnabled = opts.cache !== false;
    this.fallback = opts.fallbackOnRateLimit !== false;
  }

  private cacheKey(req: LLMRequest): string {
    return JSON.stringify({ t: req.temperature ?? 0, m: req.messages, tools: req.tools ?? [] });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // 1) 缓存优先：命中则零调用（避免一次远程）
    if (this.cacheEnabled) {
      const k = this.cacheKey(req);
      const hit = this.cacheStore.get(k);
      if (hit) {
        this.cacheHits += 1;
        return { ...hit, provider: `${this.remote.name}/hybrid-cache` };
      }
    }

    // 2) 策略路由
    const decision = this.policy.decide(req, { turn: this.localCalls + this.remoteCalls });
    if (decision === "local") {
      this.localCalls += 1;
      return this.local.complete(req);
    }

    // 3) 远程；失败时按配置降级
    this.remoteCalls += 1;
    try {
      const res = await this.remote.complete(req);
      if (this.cacheEnabled) this.cacheStore.set(this.cacheKey(req), res);
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.fallback && RATE_LIMIT_RE.test(msg)) {
        this.fallbackCalls += 1;
        const res = await this.local.complete(req);
        return { ...res, provider: `${this.local.name}/hybrid-fallback` };
      }
      throw err;
    }
  }

  inferenceStats(): InferenceStats {
    const remote = this.remoteCalls;
    const local = this.localCalls + this.fallbackCalls;
    const avoided = this.cacheHits + this.fallbackCalls;
    const total = remote + local + this.cacheHits;
    return {
      remoteCalls: remote,
      localCalls: local,
      cacheHits: this.cacheHits,
      remoteAvoided: avoided,
      remoteCallRatio: total > 0 ? remote / total : 0,
    };
  }

  underlying(): LLMProvider[] {
    return [this.remote, this.local];
  }
}
