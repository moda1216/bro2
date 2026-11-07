/**
 * bro2 · 对比式 harness 改进（Propose–Probe–Compose，HARNESS² 适配）
 *
 * 背景：bro2 的确定性 `evolve` 用冻结评分面（train/holdout 门禁）作为"真值"，
 * 但**开放世界 live 任务往往没有真值 verifier**。HARNESS²（arXiv 2610.14224，
 * Google Cloud AI Research + Northwestern，2025）提出 Propose–Probe–Compose：
 *   1) Propose：针对当前任务提出 harness 编辑（通用改进 + 任务特定改进）；
 *   2) Probe：在**配对条件**下实跑改动后的 harness；
 *   3) Compose：只保留"产生行为对比（behavioral contrast）"的改动——
 *      即该改动确实修复了基线中的某个具体失败模式，而不是仅仅把分数抬高一点。
 *
 * 本模块把这一思想做成 bro2 的可复用原语：**不需要真值标签**，
 * 只依赖"基线 vs 探测"两轮运行的可观测行为差异。
 * 它天然防止 reward hacking：单纯让分数变好但没修好任何具体失败模式的改动会被拒绝。
 *
 * 计算纯函数化、不触网，便于在 `evolve --live`（开放世界 RSI）中复用与单测。
 */
import type { FailureKind } from "./types.ts";

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
  // 通用守卫：探测轮不得新增基线没有的失败种类（焦点本身除外）
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
      // 通用：失败种类集合严格变小且终答/工具行为有正向变化
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
 * 这对应 HARNESS² "不强加真值、只看行为差异" 的核心主张，
 * 也是 bro2 防 reward hacking 的又一道关卡（与 holdout 严格提升互补）。
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
