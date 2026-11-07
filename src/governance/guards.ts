/**
 * L6 治理层 · Guards（步数 / token / 墙钟 / 死循环 / 可传播取消）
 */
import { createHash } from "node:crypto";
import type { ToolCall } from "../kernel/events.ts";
import type { LoopDetectionMode } from "../runtime/policy.ts";

export interface BudgetConfig {
  maxSteps: number;
  maxTokens: number;
  maxSeconds: number;
  loopDetectionThreshold: number;
  /** 策略变体：exact 硬终止 / advisory 先软警告。默认 exact 保持既有语义。 */
  loopMode?: LoopDetectionMode;
}

export interface GuardState {
  turn: number;
  steps: number;
  totalTokens: number;
  startedAt: number;
  recentCallHashes: string[];
  /** advisory 模式下已发出的软警告次数，连续两次即升级为硬终止。 */
  loopAdvisories: number;
}

export interface GuardVerdict {
  ok: boolean;
  reason: string;
  kind: "steps" | "tokens" | "time" | "loop" | "cancelled";
  /** true 表示「不终止，但需要向模型注入纠错提示」。 */
  advisory?: boolean;
}

export function newGuardState(turn: number): GuardState {
  return { turn, steps: 0, totalTokens: 0, startedAt: Date.now(), recentCallHashes: [], loopAdvisories: 0 };
}

export class Guards {
  private readonly config: BudgetConfig;

  constructor(config: BudgetConfig) {
    this.config = config;
  }

  /** 每步开始前的硬检查。 */
  check(state: GuardState, signal?: AbortSignal): GuardVerdict {
    if (signal?.aborted) return { ok: false, kind: "cancelled", reason: "任务被取消" };
    if (state.steps >= this.config.maxSteps) {
      return { ok: false, kind: "steps", reason: `超过最大步数 ${this.config.maxSteps}` };
    }
    if (state.totalTokens >= this.config.maxTokens) {
      return { ok: false, kind: "tokens", reason: `超过 token 预算 ${this.config.maxTokens}` };
    }
    const elapsed = (Date.now() - state.startedAt) / 1000;
    if (elapsed >= this.config.maxSeconds) {
      return { ok: false, kind: "time", reason: `超过墙钟上限 ${this.config.maxSeconds}s` };
    }
    return { ok: true, reason: "正常", kind: "steps" };
  }

  /** 记录一步中的工具调用，检测连续重复（死循环）。 */
  recordToolCalls(state: GuardState, calls: readonly ToolCall[]): GuardVerdict {
    for (const c of calls) {
      const hash = createHash("sha1")
        .update(`${c.name}:${JSON.stringify(c.arguments)}`)
        .digest("hex");
      state.recentCallHashes.push(hash);
      if (state.recentCallHashes.length > this.config.loopDetectionThreshold) state.recentCallHashes.shift();
    }
    const h = state.recentCallHashes;
    const allSame = h.length >= this.config.loopDetectionThreshold && h.every((x) => x === h[0]);
    if (!allSame) {
      state.loopAdvisories = 0;
      return { ok: true, reason: "正常", kind: "loop" };
    }
    if (this.config.loopMode === "advisory") {
      state.loopAdvisories += 1;
      if (state.loopAdvisories >= 2) {
        return {
          ok: false,
          kind: "loop",
          reason: `软警告后仍连续 ${h.length} 次相同工具调用，升级为硬终止`,
        };
      }
      return {
        ok: true,
        advisory: true,
        kind: "loop",
        reason: `检测到连续 ${h.length} 次相同工具调用：已向模型注入纠错提示，未直接终止`,
      };
    }
    return {
      ok: false,
      kind: "loop",
      reason: `检测到连续 ${h.length} 次相同工具调用，判定为死循环`,
    };
  }

  addTokens(state: GuardState, n: number): void {
    state.totalTokens += n;
  }

  /** 创建一个受总时长约束的 AbortController，并可被外部信号级联取消。 */
  controller(external?: AbortSignal): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("超过墙钟上限")), this.config.maxSeconds * 1000);
    const onAbort = () => controller.abort(external?.reason);
    if (external) external.addEventListener("abort", onAbort, { once: true });
    return {
      controller,
      cleanup: () => {
        clearTimeout(timer);
        if (external) external.removeEventListener("abort", onAbort);
      },
    };
  }
}
