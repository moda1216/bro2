/**
 * bro2 · 对比式改进接入 live RSI（P1 · Propose–Probe–Compose 的可运行闭环）
 *
 * 为什么需要它：`src/rsi/contrast.ts` 已把 HARNESS² 的「行为对比」做成纯函数
 * 原语（无需真值 verifier），但一直没接进主循环——ROADMAP P1 的缺口就在这里。
 * 本模块补上两件把它变成「可运行闭环」的东西：
 *
 *   1) 轨迹 → 行为摘要的适配器 `toRunSummary`：把 `runEval` 产出的真实运行指标
 *      （EvalRunMetrics）归一化成 contrast.ts 的 `RunSummary`。开放世界下不提供
 *      真值标签，`answerMatches` 缺省 false——判定只看可观测行为差异，不看分数。
 *
 *   2) `LiveContrastVerifier`：按配对条件（基线轮 vs 探测轮）累积多轮提案，
 *      用 `proposeProbeCompose` 决定是否晋升。关键防 reward hacking 保证：
 *      候选自带的 `scoreGain`（自报分数提升）**绝不参与** 接受判定，只作为审计
 *      证据记录——只抬高分数却没修复任何具体失败模式的改动一律拒绝。
 *
 * 诚实边界：本闭环验证的是「某改动是否可观测地修复了某失败模式」，不是能力分数，
 * 也不产出 `leadership.verdict` 的任何结论；真实强模型上的对比仍需 P0 的 eval:live。
 * 全部纯函数 / 无网络，可离线单测（`tests/contrast-live.test.ts`）。
 */
import {
  proposeProbeCompose, failureSignals, behavioralContrast,
} from "./contrast.ts";
import type { RunSummary, ContrastResult, ProbeCandidate } from "./contrast.ts";
import type { FailureKind } from "./types.ts";
import type { EvalRunMetrics } from "../observability/eval.ts";

/** 把评测运行指标归一化为行为摘要（开放世界：默认无真值标签）。 */
export function toRunSummary(m: EvalRunMetrics, answerMatches = false): RunSummary {
  return {
    steps: m.steps,
    toolCalls: m.toolCalls,
    toolErrors: m.toolErrors,
    loopAdvisories: m.loopAdvisories,
    groundingRejects: m.groundingRejects,
    protocolViolations: m.protocolViolations,
    missingTool: m.toolCalls === 0,
    answerMatches,
  };
}

/** 一个 live 提案：在配对探测轮实跑改动后得到的行为摘要 + 可选「自报分数提升」。 */
export interface LiveCandidate extends ProbeCandidate {
  /**
   * 候选自报的分数提升（0..1）。仅用于审计记录，**不参与** 接受判定——
   * 这是防 reward hacking 的核心：分数高不等于修复了失败模式。
   */
  scoreGain?: number;
}

export interface LiveDecision {
  id: string;
  focus: FailureKind;
  accepted: boolean;
  /** 行为对比判定的人类可读证据链。 */
  evidence: string;
  /** 若候选自报了分数提升，这里记录「因无行为对比而被拒」的 reward-hacking 拦截。 */
  rewardHackingBlocked: boolean;
  scoreGain: number;
}

export interface LiveContrastReport {
  /** 累积轮数。 */
  rounds: number;
  /** 是否使用了真值 verifier（恒 false——本闭环刻意不依赖真值）。 */
  usedGroundTruthVerifier: false;
  decisions: LiveDecision[];
  accepted: string[];
  rejected: string[];
  /** 因「仅分数提升、无行为对比」被拦截的候选数（防 reward hacking 计数）。 */
  rewardHackingBlocked: number;
  evidence: string[];
  /** 收敛判据：所有被接受候选都带真实行为对比证据，且无协议违规候选被接受。 */
  integrity: { ok: boolean; reasons: string[] };
}

/**
 * 一轮 Propose–Probe–Compose：给定配对基线，判定一批候选是否可晋升。
 * 纯函数：行为对比来自 contrast.ts；scoreGain 只进审计、不进判定。
 */
export function evaluateLiveCandidates(baseline: RunSummary, candidates: LiveCandidate[]): {
  decisions: LiveDecision[];
  evidence: string[];
  rewardHackingBlocked: number;
} {
  const composed = proposeProbeCompose(baseline, candidates);
  const acceptedIds = new Set(composed.accepted.map((c) => c.id));
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const decisions: LiveDecision[] = candidates.map((c) => {
    const r: ContrastResult = behavioralContrast(baseline, c.probed, c.focus);
    const scoreGain = c.scoreGain ?? 0;
    // reward hacking：自报正增益，但行为对比不成立 → 明确记为拦截（分数不参与判定）
    const rewardHackingBlocked = scoreGain > 0 && !r.contrast;
    return {
      id: c.id,
      focus: c.focus,
      accepted: acceptedIds.has(c.id),
      evidence: r.evidence,
      rewardHackingBlocked,
      scoreGain,
    };
  });

  const rewardHackingBlocked = decisions.filter((d) => d.rewardHackingBlocked).length;
  const evidence = [...composed.evidence];
  for (const d of decisions) {
    if (d.rewardHackingBlocked) {
      evidence.push(`⛔ ${d.id}: 自报分数提升 ${d.scoreGain.toFixed(3)} 但无行为对比 → 判定为 reward hacking，拒绝`);
    }
  }
  return { decisions, evidence, rewardHackingBlocked };
}

/**
 * 多轮累积验证器：模拟 evolve 主循环反复 Propose→Probe，只累积「行为对比成立」
 * 的晋升，并给出收敛与完整性结论。可离线验证「不靠真值标签也能收敛」。
 */
export class LiveContrastVerifier {
  private round = 0;
  private readonly allDecisions: LiveDecision[] = [];
  private readonly allEvidence: string[] = [];
  private rewardHackingBlocked = 0;

  /** 跑一轮：baseline 为本轮配对基线，candidates 为探测轮实跑结果。 */
  probe(baseline: RunSummary, candidates: LiveCandidate[]): LiveDecision[] {
    this.round += 1;
    const r = evaluateLiveCandidates(baseline, candidates);
    this.allDecisions.push(...r.decisions);
    this.allEvidence.push(`[round ${this.round}] ` + r.evidence.join(" | "));
    this.rewardHackingBlocked += r.rewardHackingBlocked;
    return r.decisions;
  }

  report(): LiveContrastReport {
    const accepted = this.allDecisions.filter((d) => d.accepted);
    const rejected = this.allDecisions.filter((d) => !d.accepted);
    const reasons: string[] = [];
    // 完整性：被接受项必须有行为对比证据（accepted 与 behavioralContrast 一致）
    for (const d of accepted) {
      if (!d.evidence || /拒绝|未修复|不成立|未命中|未收窄/.test(d.evidence)) {
        reasons.push(`候选 ${d.id} 被接受但缺少有效行为对比证据`);
      }
      if (d.rewardHackingBlocked) reasons.push(`候选 ${d.id} 是 reward hacking 却被接受`);
    }
    return {
      rounds: this.round,
      usedGroundTruthVerifier: false,
      decisions: this.allDecisions,
      accepted: accepted.map((d) => d.id),
      rejected: rejected.map((d) => d.id),
      rewardHackingBlocked: this.rewardHackingBlocked,
      evidence: this.allEvidence,
      integrity: { ok: reasons.length === 0, reasons },
    };
  }
}

/** 供上层从一批运行指标快速构造基线摘要（取失败信号并集，便于聚焦共性失败模式）。 */
export function baselineFromRuns(runs: EvalRunMetrics[], answerMatches = false): RunSummary {
  const empty: RunSummary = {
    steps: 0, toolCalls: 0, toolErrors: 0, loopAdvisories: 0, groundingRejects: 0,
    protocolViolations: 0, missingTool: true, answerMatches,
  };
  if (runs.length === 0) return empty;
  // 求和式聚合：把一批任务的可观测失败累计成一个「域级」基线摘要
  return runs.reduce<RunSummary>((acc, r) => {
    const s = toRunSummary(r, answerMatches);
    return {
      steps: acc.steps + s.steps,
      toolCalls: acc.toolCalls + s.toolCalls,
      toolErrors: acc.toolErrors + s.toolErrors,
      loopAdvisories: acc.loopAdvisories + s.loopAdvisories,
      groundingRejects: acc.groundingRejects + s.groundingRejects,
      protocolViolations: acc.protocolViolations + s.protocolViolations,
      missingTool: acc.missingTool && s.missingTool,
      answerMatches: acc.answerMatches || s.answerMatches,
    };
  }, empty);
}

export { failureSignals };
