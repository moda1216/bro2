import { cheapToLocalPolicy } from "./hybrid.ts";
import type { RoutePolicy, RouteDecision } from "./hybrid.ts";
import type { LLMRequest } from "./base.ts";
import {
  ExperienceBank, requestSignature, endpointSignature,
} from "../rsi/experience.ts";
import type { ExperienceEntry } from "../rsi/experience.ts";

export interface LearnedRouteOptions {
  /** 采信「本地足够」所需的最低历史成功率，默认 0.7。 */
  minLocalSuccessRate?: number;
  /** 采信经验所需的最少实证次数，默认 3（冷启动保护）。 */
  minSamples?: number;
}

export interface RouteStats {
  decisions: number;
  localFromExperience: number;
  localFromHeuristic: number;
  remote: number;
  fallbacks: number;
  /** 经验直接本地 + 兜底避免的远程重试。 */
  remoteAvoided: number;
  endpointRecords: number;
}

export interface EndpointQuality {
  name: string;
  successes: number;
  failures: number;
  rate: number;
  samples: number;
  invalidated: boolean;
}

export class LearnedRoutePolicy implements RoutePolicy {
  readonly name = "learned-experience";
  private readonly bank: ExperienceBank;
  private readonly minRate: number;
  private readonly minSamples: number;
  private decisions = 0;
  private localFromExperience = 0;
  private localFromHeuristic = 0;
  private remote = 0;
  private fallbacks = 0;
  private endpointRecords = 0;

  constructor(bank: ExperienceBank, opts: LearnedRouteOptions = {}) {
    this.bank = bank;
    this.minRate = opts.minLocalSuccessRate ?? 0.7;
    this.minSamples = opts.minSamples ?? 3;
  }

  decide(req: LLMRequest, ctx: { turn: number }): RouteDecision {
    this.decisions += 1;
    const sig = requestSignature(req);
    const localExp = this.bank.retrieve("routing", sig)
      .find((e) => e.prescription === "local");
    if (localExp) {
      const n = localExp.successes + localExp.failures;
      const rate = n > 0 ? localExp.successes / n : 0;
      if (n >= this.minSamples && rate >= this.minRate) {
        this.localFromExperience += 1;
        return "local";
      }
    }
    const decision = cheapToLocalPolicy.decide(req, ctx);
    if (decision === "local") this.localFromHeuristic += 1;
    else this.remote += 1;
    return decision;
  }

  observe(req: LLMRequest, decision: RouteDecision, ok: boolean, fallbackUsed = false): void {
    const sig = requestSignature(req);
    const meta = {
      applicableTo: [`结构指纹 ${sig}`, `决策 ${decision}`],
      source: "LearnedRoutePolicy.observe",
    };

    if (fallbackUsed) {
      this.fallbacks += 1;
      if (decision === "remote") {
        // 远程不可靠但本地兜底成功 → 两条经验同时留痕，下次可直接本地
        this.bank.observeOutcome("routing", sig, "remote", "failure", meta);
        this.bank.observeOutcome("routing", sig, "local", ok ? "success" : "failure", meta);
        return;
      }
    }

    const outcome = ok && !fallbackUsed ? "success" : "failure";
    const prescription = decision === "local" ? "local" : "remote";
    this.bank.observeOutcome("routing", sig, prescription, outcome, meta);
  }

  /** 回写上游成败，使端点质量经验跨会话累积（KeylessAggregator 内存态的补充）。 */
  endpointOutcome(name: string, ok: boolean, latencyMs?: number): void {
    const bucket = latencyMs === undefined
      ? "latency:unknown"
      : latencyMs < 1000 ? "latency:fast" : latencyMs < 5000 ? "latency:mid" : "latency:slow";
    this.bank.observeOutcome(
      "endpoint", endpointSignature(name), name,
      ok ? "success" : "failure",
      { applicableTo: [`上游 ${name}`, bucket], source: "LearnedRoutePolicy.endpointOutcome" },
    );
    this.endpointRecords += 1;
  }

  /** 查询某上游的跨会话历史质量（供聚合器优先级参考，不绕过其健康评分）。 */
  endpointQuality(name: string): EndpointQuality {
    const e = this.bank.fold()
      .find((x) => x.domain === "endpoint" && x.prescription === name);
    const successes = e?.successes ?? 0;
    const failures = e?.failures ?? 0;
    const samples = successes + failures;
    return {
      name,
      successes,
      failures,
      samples,
      rate: samples > 0 ? successes / samples : 0,
      invalidated: (e?.invalidations.length ?? 0) > 0,
    };
  }

  stats(): RouteStats {
    return {
      decisions: this.decisions,
      localFromExperience: this.localFromExperience,
      localFromHeuristic: this.localFromHeuristic,
      remote: this.remote,
      fallbacks: this.fallbacks,
      remoteAvoided: this.localFromExperience + this.fallbacks,
      endpointRecords: this.endpointRecords,
    };
  }
}

// ---------------------------------------------------------------- 跨会话端点先验（v2.12.0）

export interface EndpointPriorOptions {
  /** 采信经验所需的最少样本（冷启动保护），默认 3。 */
  minSamples?: number;
  /** 单个端点先验分的绝对值上限，默认 2——不足以压过冷却/限流的硬过滤。 */
  maxBoost?: number;
}

export function endpointPriorFromExperience(
  entries: readonly ExperienceEntry[],
  opts: EndpointPriorOptions = {},
): Record<string, number> {
  const minSamples = opts.minSamples ?? 3;
  const maxBoost = opts.maxBoost ?? 2;
  const out: Record<string, number> = {};
  for (const e of entries) {
    if (e.domain !== "endpoint") continue;
    const n = e.successes + e.failures;
    // 失效经验（OOD 退化/适用条件变化）→ 0 分，回退完整探测
    if (e.invalidations.length > 0) { out[e.prescription] = 0; continue; }
    // 样本不足（冷启动保护）或缺格 → 0 分
    if (n < minSamples) { out[e.prescription] = 0; continue; }
    const rate = e.successes / n;
    // 成功率映射到 [-maxBoost, +maxBoost]：rate=1→+maxBoost，rate=0→-maxBoost，rate=0.5→0
    out[e.prescription] = Math.round((rate * 2 - 1) * maxBoost * 100) / 100;
  }
  return out;
}
