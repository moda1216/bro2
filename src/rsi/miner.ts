/**
 * bro2 · 失败轨迹挖掘
 *
 * 输入只有 train 评测报告（含每条轨迹的 reasons / stoppedBy / 工具错误），
 * holdout 的内容与结果绝不进入本模块。输出是可被算子消费的**失败信号簇**。
 */
import type { EvalReport, EvalRunMetrics } from "../observability/eval.ts";
import type { FailureSignal, FailureKind } from "./types.ts";

function classify(r: EvalRunMetrics, policyRule = true): FailureKind {
  const text = `${r.reasons.join(" ")} ${r.stoppedBy} ${r.answer}`.toLowerCase();
  // 策略未生效优先于其它分类：这些失败明确点名了代码分支，可直接被策略算子消费
  if (policyRule && /策略|repair|grounding|advisory|salience|risk-first|接地|软警告/.test(text)) return "policy";
  if (/死循环|连续.*相同工具|loop/.test(text)) return "loop";
  if (/步数|maxstep|超过.*步/.test(text)) return "steps";
  if (/token|压缩|预算|compaction/.test(text)) return "tokens";
  if (/未配对|工具.*(错误|失败)|toolerror/.test(text) || r.toolErrors > 0) return "tool-error";
  if (/未调用工具/.test(text)) return "missing-tool";
  if (/终答|答案/.test(text)) return "answer";
  return "guard";
}

export interface MinerOptions {
  /** 每类失败信号保留的证据条数上限。由 MetaState 接管，是元改进的可测维度。 */
  evidenceLimit?: number;
  /** 分类规则开关：元层可关闭"策略优先"规则，验证错误归因对改进效率的影响。 */
  policyRule?: boolean;
}

export function mineFailures(report: EvalReport, options: MinerOptions = {}): FailureSignal[] {
  const limit = options.evidenceLimit ?? 12;
  const policyRule = options.policyRule !== false;
  const clusters = new Map<FailureKind, FailureSignal>();
  for (const r of report.runs) {
    if (r.ok) continue;
    const kind = classify(r, policyRule);
    const s = clusters.get(kind) ?? { kind, count: 0, taskIds: [], evidence: [] };
    s.count += 1;
    if (!s.taskIds.includes(r.taskId)) s.taskIds.push(r.taskId);
    // 证据窗口过窄会让后半部分策略永远不被提议；过宽则引入噪声候选、浪费 eval 预算。
    for (const reason of r.reasons.slice(0, 2)) {
      if (s.evidence.length < limit && !s.evidence.includes(reason)) s.evidence.push(reason);
    }
    clusters.set(kind, s);
  }
  return [...clusters.values()].sort((a, b) => b.count - a.count);
}
