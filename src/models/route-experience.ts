/**
 * bro2 · 学习型路由（P0.5-a / P0.5-c 的最小闭环，设计目标 2 的落点）
 *
 * 现状缺口：`cheapToLocalPolicy` 是硬编码启发式（只看 tools / 末条长度），
 * `KeylessAggregator` 的健康态是进程内内存态、重启清零，`InferenceStats`
 * 只是仪表盘——「远程调用省了多少」被观测，但从不回控路由。于是
 * 「越用越省、越用越稳」无法发生。
 *
 * 本模块把这两处静态机制接到共享经验库上：
 *   - `LearnedRoutePolicy` 实现 `RoutePolicy` 接口，**注入** HybridProvider 即可，
 *     对 hybrid.ts 零侵入；请求结构指纹命中「本地足够」的实证经验时直接走本地。
 *   - `observe()` / `endpointOutcome()` 把每次实际结果与上游成败回写为只增
 *     经验，跨会话累积（新建 ExperienceBank 实例即可读到历史）。
 *
 * 冷启动保护：证据不足（样本 < minSamples 或本地成功率 < minLocalSuccessRate）
 * 时回退 `cheapToLocalPolicy`，绝不因"有经验"就贸然压本地。
 *
 * 关键闭环：远程 429/5xx → 本地兜底成功时，同时记「remote: failure」与
 * 「local: success」，下次同等结构的请求可直接本地 —— 容错经验转化为成本优势。
 *
 * 治理：路由经验只影响**先验决策**，不改变任何能力评测判定；端点经验只用于
 * 排序参考，不绕过 KeylessAggregator 的健康评分与故障转移。
 */
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

  /**
   * 回写一次实际调用结果。由调用链在 complete() 返回后显式调用
   * （保持 hybrid.ts 零侵入；接入 runtime 时挂在调用后钩子即可）。
   *
   * @param decision  策略原本的决策
   * @param ok        这次请求最终是否成功（含兜底后的结果）
   * @param fallbackUsed 是否触发了远程失败 → 本地降级
   */
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

/**
 * 把只增经验账本折叠成「跨会话端点先验分」，注入 KeylessAggregator.score()。
 *
 * 解决「健康态只在进程内、重启清零」：历史失败多的端点在新进程里也从低分起步，
 * 冷启动第一发不再优先打到已知死端点。治理红线：
 *  - 先验**只影响排序**，不绕过冷却/限流/能力感知的硬过滤（见 keyless.ts:selectBackend）；
 *  - 被 invalidate 的经验一律给 0 分（回退完整探测，绝不硬信经验）；
 *  - 样本不足 / 失效 / 全失败但已失效 → 0 分；缺格不冒充结论。
 *  - 幅度封顶 maxBoost，历史再好也不能凌驾于实时健康信号。
 * 纯函数：输入是经验事件快照，不含 IO，CI 可用构造快照自给自足。
 */
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
