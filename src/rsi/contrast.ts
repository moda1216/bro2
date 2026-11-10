/**
 * bro2 · 对比式 harness 改进（Propose–Probe–Compose，HARNESS² 适配）
 *
 * 把 HARNESS²（arXiv 2610.14224）的「行为对比」做成纯函数原语：不需要真值标签，
 * 只依赖「基线 vs 探测」两轮运行的可观测行为差异，天然防 reward hacking。
 * v2.20.0 合并原 contrast / live-contrast / compound 三件套于一处（导出集合不变）。
 * 关键不变量：候选自报分数提升 `scoreGain` 绝不参与接受判定；本模块不产生能力分数。
 */
import type { FailureKind } from "./types.ts";
import type { EvalRunMetrics } from "../observability/eval.ts";
import { ExperienceBank, failureSignature } from "./experience.ts";
import { VelocityLedger } from "./velocity.ts";

// ============================================================= 核心类型

/** 一次任务运行的可观测行为摘要。可由真实轨迹或评测报告归一化得到。 */
export interface RunSummary {
  steps: number;
  toolCalls: number;
  toolErrors: number;
  loopAdvisories: number;
  groundingRejects: number;
  protocolViolations: number;
  /** 基线/探测轮是否根本没调用任何工具（典型失败：模型把工具当文本） */
  missingTool: boolean;
  /** 终答是否命中期望内容（开放世界可缺省，无真值时置 false 而非真值） */
  answerMatches: boolean;
}

/** 从行为摘要推导失败信号（与 miner 的 FailureKind 对齐，便于复用治理不变量）。 */
export function failureSignals(s: RunSummary): FailureKind[] {
  const out: FailureKind[] = [];
  if (s.missingTool || s.toolCalls === 0) out.push("missing-tool");
  if (s.loopAdvisories > 0) out.push("loop");
  if (s.toolErrors > 0) out.push("tool-error");
  if (s.groundingRejects > 0) out.push("guard");
  if (!s.answerMatches) out.push("answer");
  if (s.protocolViolations > 0) out.push("policy");
  return out;
}

export interface ContrastResult {
  contrast: boolean;
  /** 人类可读的证据链：改动到底修复了什么、或为什么不成立。 */
  evidence: string;
}

/**
 * 给定基线 `a` 与探测轮 `b`，以及要聚焦的失败模式 `focus`，
 * 判断本次 harness 编辑是否产生了**行为对比**。
 *
 * 接受条件（全部满足）：
 *   1) 焦点失败在 b 中消失或显著下降；
 *   2) b 不得引入新的、更糟的失败种类（尤其协议违规必须保持 0）；
 *   3) 必须出现对应的正向行为变化（可观测），而非仅分数上升。
 */
export function behavioralContrast(
  a: RunSummary,
  b: RunSummary,
  focus: FailureKind,
): ContrastResult {
  if (b.protocolViolations > 0) {
    return { contrast: false, evidence: "探测轮出现协议违规，违反治理不变量，直接拒绝" };
  }
  const aKinds = new Set(failureSignals(a));
  const bKinds = new Set(failureSignals(b));
  const newKinds = [...bKinds].filter((k) => k !== focus && !aKinds.has(k));
  if (newKinds.length > 0) {
    return { contrast: false, evidence: `探测轮引入了新的失败模式 [${newKinds.join(", ")}]，拒绝` };
  }

  switch (focus) {
    case "missing-tool": {
      if (!a.missingTool && a.toolCalls > 0) {
        return { contrast: false, evidence: "基线已调用工具，焦点不适用" };
      }
      if (b.toolCalls > 0 && !b.missingTool) {
        return { contrast: true, evidence: `探测轮调用了 ${b.toolCalls} 次工具而基线为 0，行为对比成立` };
      }
      return { contrast: false, evidence: "探测轮仍未调用工具，未修复 missing-tool" };
    }
    case "loop": {
      if (b.loopAdvisories < a.loopAdvisories) {
        return { contrast: true, evidence: `循环告警 ${a.loopAdvisories} → ${b.loopAdvisories}，行为对比成立` };
      }
      return { contrast: false, evidence: "循环告警未下降，未修复 loop" };
    }
    case "tool-error": {
      if (b.toolErrors < a.toolErrors) {
        return { contrast: true, evidence: `工具错误 ${a.toolErrors} → ${b.toolErrors}，行为对比成立` };
      }
      return { contrast: false, evidence: "工具错误未下降，未修复 tool-error" };
    }
    case "guard": {
      if (b.groundingRejects < a.groundingRejects) {
        return { contrast: true, evidence: `grounding 拒绝 ${a.groundingRejects} → ${b.groundingRejects}，行为对比成立` };
      }
      return { contrast: false, evidence: "grounding 拒绝未下降，未修复" };
    }
    case "answer": {
      if (!a.answerMatches && b.answerMatches) {
        return { contrast: true, evidence: "终答从未命中变为命中，行为对比成立" };
      }
      return { contrast: false, evidence: "终答仍未命中，未修复 answer" };
    }
    default: {
      const shrunk = bKinds.size < aKinds.size;
      const positive = b.toolCalls >= a.toolCalls && b.steps <= a.steps + 1;
      if (shrunk && positive) {
        return { contrast: true, evidence: `失败信号 ${aKinds.size} → ${bKinds.size} 且行为未退化，行为对比成立` };
      }
      return { contrast: false, evidence: "失败信号未收窄或无正向行为变化" };
    }
  }
}

export interface ProbeCandidate {
  id: string;
  description: string;
  /** 该候选意在修复的失败模式（来自 miner 的失败信号）。 */
  focus: FailureKind;
  /** 在配对条件下实跑改动后 harness 得到的运行摘要。 */
  probed: RunSummary;
}

export interface ComposeResult {
  /** 仅保留行为对比成立的候选（可晋升）。 */
  accepted: ProbeCandidate[];
  /** 行为对比不成立的候选（丢弃）。 */
  rejected: Array<{ candidate: ProbeCandidate; reason: string }>;
  evidence: string[];
}

/**
 * Compose 步骤：对一批候选，只保留被行为对比支撑的编辑。
 * 对应 HARNESS² "不强加真值、只看行为差异" 的核心主张，也是 bro2 防 reward hacking
 * 的又一道关卡（与 holdout 严格提升互补）。
 */
export function proposeProbeCompose(baseline: RunSummary, candidates: ProbeCandidate[]): ComposeResult {
  const accepted: ProbeCandidate[] = [];
  const rejected: Array<{ candidate: ProbeCandidate; reason: string }> = [];
  const evidence: string[] = [];
  for (const c of candidates) {
    const r = behavioralContrast(baseline, c.probed, c.focus);
    if (r.contrast) {
      accepted.push(c);
      evidence.push(`✓ ${c.id} (${c.focus}): ${r.evidence}`);
    } else {
      rejected.push({ candidate: c, reason: r.evidence });
      evidence.push(`✗ ${c.id} (${c.focus}): ${r.evidence}`);
    }
  }
  return { accepted, rejected, evidence };
}

// ============================================================= live 适配器

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
 * 纯函数：行为对比来自 behavioralContrast；scoreGain 只进审计、不进判定。
 */
export function evaluateLiveCandidates(baseline: RunSummary, candidates: LiveCandidate[]): {
  decisions: LiveDecision[];
  evidence: string[];
  rewardHackingBlocked: number;
} {
  const composed = proposeProbeCompose(baseline, candidates);
  const acceptedIds = new Set(composed.accepted.map((c) => c.id));

  const decisions: LiveDecision[] = candidates.map((c) => {
    const r: ContrastResult = behavioralContrast(baseline, c.probed, c.focus);
    const scoreGain = c.scoreGain ?? 0;
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

// ============================================================= 复利闭环

/** 经验命中时仍保留的探索候选数，避免经验库过早收敛。 */
export const EXPLORE_SLOTS = 1;

/**
 * 惰性候选项：只有 `probed` 尚未实跑的提案描述。
 * `probed` 必须由 `CompoundOptions.probe()` 在候选真正进入探测集时生成，
 * 绝不预先填好假摘要——否则「裁剪探测集」只是纸面省成本，属于变相 reward hacking。
 */
export type PendingCandidate = Omit<LiveCandidate, "probed">;

export interface CompoundOptions {
  /** 显式指定指纹；缺省由基线行为摘要计算。 */
  signature?: string;
  /** 显式指定本轮最多探测数；缺省按经验命中数自动裁剪。 */
  topK?: number;
  /** 经验来源标记，写入只增账本便于审计。 */
  source?: string;
  /**
   * 惰性探测钩子：仅当候选**真正被探测**时调用，返回带真实 `probed`
   * 行为摘要的候选。调用方在此实跑评测；被经验裁剪掉的候选不会触发回调，
   * 因而 `attempts` 等于真实计算成本，而不是纸面数字。
   */
  probe?: (candidate: PendingCandidate) => LiveCandidate;
}

export interface CompoundResult {
  decisions: LiveDecision[];
  /** 本轮实际探测的候选数（复利的成本口径）。 */
  attempts: number;
  experienceHits: number;
  /** 因经验裁剪而未探测的候选数。 */
  probesAvoided: number;
  /** 经验不灵、回退探测了 deferred 候选。 */
  usedFallback: boolean;
  /** 首批探测即命中有效编辑。 */
  firstTryHit: boolean;
  /** 行为对比成立的接受数（非自报分数）。 */
  improvement: number;
  protocolViolations: number;
  rewardHackingBlocked: number;
  /** 本轮是否由经验自动裁剪了探测集（审计用）。 */
  autoPruned: boolean;
  effectiveTopK: number;
  signature: string;
}

/**
 * 一轮「有经验的」Probe。纯编排、无网络；候选的 `probed` 由调用方在配对
 * 条件下实跑得到，本函数不伪造行为摘要。
 *
 * 三条硬保证（见 ROADMAP P2）：
 *   1) 经验只影响**探测哪些候选**，接受仍走 behavioralContrast 全量行为对比；
 *   2) 经验不灵（首批无接受项）必须**回退探测 deferred**，绝不因"有经验"就跳过验证；
 *   3) 经验回写只由「行为对比成立且非 reward hacking」的接受项驱动，失败项同样留痕。
 */
export function compoundProbe(
  baseline: RunSummary,
  candidates: Array<LiveCandidate | PendingCandidate>,
  bank: ExperienceBank,
  ledger: VelocityLedger,
  opts: CompoundOptions = {},
): CompoundResult {
  const signature = opts.signature ?? failureSignature(baseline);
  const source = opts.source ?? "compoundProbe";

  const resolved = new Map<string, LiveCandidate>();
  const materialize = (batch: Array<LiveCandidate | PendingCandidate>): LiveCandidate[] =>
    batch.map((c) => {
      if ("probed" in c) {
        const full = c as LiveCandidate;
        resolved.set(full.id, full);
        return full;
      }
      if (!opts.probe) {
        throw new Error(`候选 ${c.id} 未提供 probed 且未配置惰性 probe()：拒绝伪造行为摘要`);
      }
      const full = opts.probe(c as PendingCandidate);
      resolved.set(full.id, full);
      return full;
    });

  const { prioritized, deferred, hits } = bank.prioritize(
    "harness-edit", signature, candidates, (c) => c.id,
  );

  const autoPruned = opts.topK === undefined && hits > 0;
  const effectiveTopK = opts.topK !== undefined
    ? Math.max(1, Math.min(opts.topK, candidates.length))
    : hits > 0
      ? Math.max(1, Math.min(hits + EXPLORE_SLOTS, candidates.length))
      : candidates.length;

  const firstBatch = prioritized.slice(0, effectiveTopK);
  const rest = [...prioritized.slice(effectiveTopK), ...deferred];

  const first = evaluateLiveCandidates(baseline, materialize(firstBatch));
  let decisions = [...first.decisions];
  const firstAccepted = first.decisions.filter((d) => d.accepted).length;
  let usedFallback = false;

  if (firstAccepted === 0 && rest.length > 0) {
    usedFallback = true;
    const second = evaluateLiveCandidates(baseline, materialize(rest));
    decisions = [...decisions, ...second.decisions];
  }

  for (const d of decisions) {
    const good = d.accepted && !d.rewardHackingBlocked;
    bank.observeOutcome(
      "harness-edit", signature, d.id,
      good ? "success" : "failure",
      {
        applicableTo: [`失败模式 ${d.focus}`, `指纹 ${signature}`],
        source: `${source}#${good ? "accepted" : "rejected"}`,
      },
    );
  }

  const attempts = resolved.size;
  const improvement = decisions.filter((d) => d.accepted).length;
  const protocolViolations = decisions.reduce((sum, d) => {
    const c = resolved.get(d.id);
    return sum + (c?.probed.protocolViolations ?? 0);
  }, 0);
  const rewardHackingBlocked = decisions.filter((d) => d.rewardHackingBlocked).length;

  const record = {
    attempts,
    experienceHits: hits,
    firstTryHit: firstAccepted > 0,
    improvement,
    probesAvoided: candidates.length - attempts,
    usedFallback,
    protocolViolations,
  };
  ledger.append(record);

  return {
    decisions,
    attempts,
    experienceHits: hits,
    probesAvoided: record.probesAvoided,
    usedFallback,
    firstTryHit: record.firstTryHit,
    improvement,
    protocolViolations,
    rewardHackingBlocked,
    autoPruned,
    effectiveTopK,
    signature,
  };
}
