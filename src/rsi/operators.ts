/**
 * bro2 · 改进算子（单原子编辑 · 编辑预算 · 拒绝缓冲 · 证据驱动的先验更新）
 *
 * 对应 SkillOpt 的 textual learning rate / bounded edit：
 * 每个候选恰好改 1 处，来源必须是 train 失败信号，且不允许出现模型自评。
 * 元层（L4）不通过"影子评测晋升"，而是由账本实证成败更新搜索先验——
 * 因为先验回答的是"值得评估什么"，不属于验证层级的结论，见 RSI.md §2。
 */
import type { EvolvableState, EvolutionStrategy, FailureSignal, Patch, PatchChange } from "./types.ts";
import { shortHash, setByPath, clamp, OPERATOR_NAMES } from "./types.ts";
import { POLICY_UPGRADES, DEFAULT_POLICY } from "../runtime/policy.ts";
import type { BehaviorPolicy } from "../runtime/policy.ts";
import type { OperatorStats } from "./ledger.ts";

interface Operator {
  name: string;
  match: (signal: FailureSignal) => boolean;
  propose: (signal: FailureSignal, state: EvolvableState) => PatchChange | null;
  describe: (change: PatchChange) => string;
}

/**
 * 操作级、可迁移的指导（TRACE de-hardcoding）。
 * 不含任何答案、任务 id、评分逻辑；确定性脚本化模型不会加载技能，
 * 因此该候选在 holdout 上不会带来可验证提升——会被门禁如实拒绝。
 */
const RELIABILITY_GUIDANCE =
  "若同一工具需要连续多次核对结果，先比较每次调用的参数是否有实质差异；" +
  "无差异时应合并为一次调用并复用已得结果，不要重复发起无变化的请求。";

/**
 * 策略切换候选：把 train 失败信号里点名的策略维度切到增强变体。
 * 这改的是**真实代码分支**（见 src/runtime/policy.ts 与各层实现），不是数字参数。
 * 是否真的更优由 train + holdout 双门禁决定；holdout 含安全不变量守卫，
 * 因此「放宽治理换分数」的候选会被如实拒绝。
 */
function policyChange(state: EvolvableState, key: keyof BehaviorPolicy): PatchChange | null {
  const policy = state.policy ?? DEFAULT_POLICY;
  const from = policy[key];
  const to = POLICY_UPGRADES[key];
  return from === to ? null : { path: `policy.${key}`, from, to };
}

const hasEvidence = (s: FailureSignal, re: RegExp): boolean => s.evidence.some((e) => re.test(e));

export const OPERATORS: readonly Operator[] = [
  {
    name: "relax-loop-threshold",
    match: (s) => s.kind === "loop",
    propose: (_s, state) => {
      const from = state.budget.loopDetectionThreshold;
      const to = Math.min(8, from + 2);
      return to === from ? null : { path: "budget.loopDetectionThreshold", from, to };
    },
    describe: (c) => `放宽死循环检测阈值 ${c.from} → ${c.to}，避免重复核对被误判`,
  },
  {
    name: "raise-step-ceiling",
    match: (s) => s.kind === "steps",
    propose: (_s, state) => {
      const from = state.budget.maxSteps;
      const to = Math.min(60, from + 10);
      return to === from ? null : { path: "budget.maxSteps", from, to };
    },
    describe: (c) => `提高步数上限 ${c.from} → ${c.to}`,
  },
  {
    name: "tune-compaction",
    match: (s) => s.kind === "tokens",
    propose: (_s, state) => {
      const from = state.budget.compactTokens;
      const to = Math.max(500, Math.floor(from * 0.75));
      return to === from ? null : { path: "budget.compactTokens", from, to };
    },
    describe: (c) => `提前触发上下文压缩 ${c.from} → ${c.to}`,
  },
  {
    name: "extend-tool-timeout",
    match: (s) => s.kind === "tool-error",
    propose: (_s, state) => {
      const from = state.budget.toolTimeoutMs;
      const to = Math.min(120000, from + 15000);
      return to === from ? null : { path: "budget.toolTimeoutMs", from, to };
    },
    describe: (c) => `延长工具超时 ${c.from} → ${c.to} ms`,
  },
  {
    name: "add-reliability-guidance",
    match: (s) => s.kind === "loop" || s.kind === "missing-tool" || s.kind === "answer" || s.kind === "guard",
    propose: (_s, state) => {
      const path = "skillOverlays.reliability";
      const from = state.skillOverlays.reliability;
      if (from === RELIABILITY_GUIDANCE) return null;
      return { path, from, to: RELIABILITY_GUIDANCE };
    },
    describe: () => "追加一条操作级技能指导（去重/复用工具结果）",
  },
  {
    name: "enable-args-repair",
    match: (s) => s.kind === "policy" && hasEvidence(s, /repair|修复|malformedArgs/i),
    propose: (_s, state) => policyChange(state, "malformedArgs"),
    describe: (c) => `切换代码分支：畸形参数 ${c.from} → ${c.to}（受控修复，不放松必填校验）`,
  },
  {
    name: "enable-grounding",
    match: (s) => s.kind === "policy" && hasEvidence(s, /grounding|接地/i),
    propose: (_s, state) => policyChange(state, "grounding"),
    describe: (c) => `切换代码分支：终答接地 ${c.from} → ${c.to}（防臆造）`,
  },
  {
    name: "enable-salience-compaction",
    match: (s) => s.kind === "policy" && hasEvidence(s, /salience|compaction/i),
    propose: (_s, state) => policyChange(state, "compaction"),
    describe: (c) => `切换代码分支：上下文压缩 ${c.from} → ${c.to}（证据优先）`,
  },
  {
    name: "enable-advisory-loop",
    match: (s) => s.kind === "policy" && hasEvidence(s, /advisory|软警告|loopDetection/i),
    propose: (_s, state) => policyChange(state, "loopDetection"),
    describe: (c) => `切换代码分支：死循环判定 ${c.from} → ${c.to}（软警告）`,
  },
  {
    name: "enable-risk-first-parallel",
    match: (s) => s.kind === "policy" && hasEvidence(s, /risk-first|parallel|调度/i),
    propose: (_s, state) => policyChange(state, "parallel"),
    describe: (c) => `切换代码分支：并行调度 ${c.from} → ${c.to}（高危优先）`,
  },
];

export interface ProposalOptions {
  /** 候选排序策略：由 MetaState 接管，是可测的元改进维度。 */
  candidateOrder?: "weight" | "round-robin" | "evidence-first";
  /** 允许参与的算子集合（元层可裁剪无效算子以节省 eval 预算）。 */
  operatorSet?: readonly string[];
}

export function proposePatches(
  signals: readonly FailureSignal[],
  state: EvolvableState,
  strategy: EvolutionStrategy,
  options: ProposalOptions = {},
): Patch[] {
  const pool = options.operatorSet
    ? OPERATORS.filter((o) => options.operatorSet!.includes(o.name))
    : OPERATORS;
  const order = options.candidateOrder ?? "weight";
  const evidenceScore = (o: Operator): number =>
    signals.filter((s) => o.match(s)).reduce((n, s) => n + s.count, 0);
  const sorted = order === "round-robin"
    ? [...pool]
    : order === "evidence-first"
      ? [...pool].sort((a, b) => evidenceScore(b) - evidenceScore(a))
      : [...pool].sort((a, b) => (strategy.operatorWeights[b.name] ?? 1) - (strategy.operatorWeights[a.name] ?? 1));
  const out: Patch[] = [];
  for (const signal of signals) {
    for (const op of sorted) {
      if (!op.match(signal)) continue;
      const change = op.propose(signal, state);
      if (!change) continue;
      const patch: Patch = {
        id: shortHash(`${op.name}|${change.path}|${JSON.stringify(change.to)}`),
        operator: op.name,
        target: "capability",
        description: op.describe(change),
        changes: [change],
        evidence: [`${signal.kind} × ${signal.count}`, ...signal.evidence.slice(0, 2)],
      };
      if (!out.some((p) => p.id === patch.id)) out.push(patch);
    }
  }
  return out.slice(0, strategy.editBudget);
}

export function applyPatch(state: EvolvableState, patch: Patch): EvolvableState {
  let next = state;
  for (const c of patch.changes) {
    if (!c.path.startsWith("budget.") && !c.path.startsWith("policy.") && !c.path.startsWith("skillOverlays.")) {
      throw new Error(`applyPatch 拒绝非能力面路径: ${c.path}`);
    }
    next = setByPath(next, c.path, c.to);
  }
  return next;
}

export function noteRejected(strategy: EvolutionStrategy, patchId: string): EvolutionStrategy {
  return {
    ...strategy,
    rejectedEdits: [...new Set([...strategy.rejectedEdits, patchId])].slice(-50),
  };
}

/**
 * L4 自指：改进机制自身由账本证据更新。
 * 成功晋升的算子升权，被拒/被拦的降权；这只是搜索先验，不作为能力声明。
 */
export function updateStrategyWeights(
  strategy: EvolutionStrategy,
  stats: Record<string, OperatorStats>,
): EvolutionStrategy {
  const weights: Record<string, number> = { ...strategy.operatorWeights };
  for (const name of OPERATOR_NAMES) {
    const s = stats[name] ?? { promoted: 0, rejected: 0, blocked: 0 };
    const delta = s.promoted * 0.2 - s.rejected * 0.1 - s.blocked * 0.15;
    const next = (weights[name] ?? 1) + delta;
    weights[name] = Math.round(clamp(next, 0, 2) * 100) / 100;
  }
  return { ...strategy, operatorWeights: weights };
}
