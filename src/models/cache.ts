/**
 * L1 模型层 · 透明响应缓存
 *
 * 包裹任意 LLMProvider，对相同请求（model + messages + tools + temperature）
 * 返回缓存结果，避免重复打到远程端点。这是「本地 + 远程协同降调用」的
 * 第一根支柱：在 agent 循环中，重复/近似的提示（如守卫检查、循环中的相同
 * 系统提示）命中缓存后，远程调用数直接归零。
 *
 * 设计约束：
 *  - 仅缓存「确定性」响应。tool_calls 的响应也缓存——因为给定相同上下文，
 *    对工具选择的「正确」答案在评测域内是稳定的，缓存不会引入非确定性。
 *  - 命中时原样返回缓存对象，只改写 provider 字段以便溯源。
 *  - 进程内 Map 缓存；跨进程/跨会话复用请由上层持久化（不在本层做）。
 */
import type { LLMProvider, LLMRequest, LLMResponse } from "./base.ts";

export interface InferenceStats {
  /** 真正打到远程端点的调用次数 */
  remoteCalls: number;
  /** 打到本地端点的调用次数（含降级兜底） */
  localCalls: number;
  /** 缓存命中次数（均视为避免了一次远程调用） */
  cacheHits: number;
  /** 因缓存/降级而避免的远程调用总数 */
  remoteAvoided: number;
  /** 远程调用占比 = remoteCalls / (remoteCalls + localCalls + cacheHits) */
  remoteCallRatio: number;
  /**
   * 远端若是聚合器（如 KeylessAggregator），其网状明细（上游健康/故障转移次数）。
   * 供 doctor / 评测复盘展示「双层叠加」的真实执行路径；非聚合器时为 undefined。
   */
  remoteDetail?: unknown;
}

export const EMPTY_STATS: InferenceStats = {
  remoteCalls: 0,
  localCalls: 0,
  cacheHits: 0,
  remoteAvoided: 0,
  remoteCallRatio: 0,
};

/** 实现后可被 ProviderRouter / eval 报告统一收集效率指标。 */
export interface StatsProvider {
  inferenceStats(): InferenceStats;
}

/** 组合型 provider（Cached / Hybrid）暴露底层真实 provider，供门禁对真实端点做探针。 */
export interface CompositeProvider {
  underlying(): LLMProvider[];
}

export function isStatsProvider(p: unknown): p is StatsProvider {
  return !!p && typeof (p as StatsProvider).inferenceStats === "function";
}

export function isCompositeProvider(p: unknown): p is CompositeProvider {
  return !!p && typeof (p as CompositeProvider).underlying === "function";
}

export class CachedProvider implements LLMProvider, StatsProvider {
  readonly name: string;
  private readonly inner: LLMProvider;
  private readonly store = new Map<string, LLMResponse>();
  private hits = 0;
  private misses = 0;

  constructor(name: string, inner: LLMProvider) {
    this.name = name;
    this.inner = inner;
  }

  private key(req: LLMRequest): string {
    // inner.name 作为命名空间，避免不同底层 provider 的提示冲突命中
    const tag = (this.inner as { name?: string }).name ?? "inner";
    return JSON.stringify({
      tag,
      t: req.temperature ?? 0,
      m: req.messages,
      tools: req.tools ?? [],
    });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const k = this.key(req);
    const hit = this.store.get(k);
    if (hit) {
      this.hits += 1;
      return { ...hit, provider: `${this.inner.name}/cache` };
    }
    const res = await this.inner.complete(req);
    this.misses += 1;
    this.store.set(k, res);
    return res;
  }

  inferenceStats(): InferenceStats {
    const total = this.hits + this.misses;
    return {
      remoteCalls: this.misses,
      localCalls: 0,
      cacheHits: this.hits,
      remoteAvoided: this.hits,
      remoteCallRatio: total > 0 ? this.misses / total : 0,
    };
  }

  underlying(): LLMProvider[] {
    return [this.inner];
  }
}
