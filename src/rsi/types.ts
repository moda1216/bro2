/**
 * bro2 · 有界可验证自我改进（Bounded Verifiable Self-Improvement）· 共享类型与常量
 *
 * 设计依据见 RSI.md。三条不可协商的原则：
 *  1) 晋升只认外部可执行断言，不认模型自评；
 *  2) 能力面可改、治理/评测面写保护；
 *  3) 只增账本保留全部候选（含被拒），改进策略由账本实证成败更新（L4 自指）。
 */
import { createHash } from "node:crypto";
import { DEFAULT_POLICY, POLICY_KEYS, POLICY_VALUES } from "../runtime/policy.ts";
import type { BehaviorPolicy } from "../runtime/policy.ts";

export interface EvolvableState {
  version: 1;
  budget: {
    compactTokens: number;
    loopDetectionThreshold: number;
    maxSteps: number;
    maxConcurrentTools: number;
    toolTimeoutMs: number;
  };
  /**
   * 行为策略面：RSI 从这里切换**真实代码分支**，而非只调数字。
   * 每个值必须是 POLICY_VALUES 白名单内的枚举，由 guardrails 校验。
   */
  policy: BehaviorPolicy;
  /** 技能补充指导：影子评测时追加到 SKILL.md，必须通过 de-hardcoding 校验。 */
  skillOverlays: Record<string, string>;
}

export { POLICY_KEYS, POLICY_VALUES };

export interface EvolutionStrategy {
  version: 1;
  /** 改进先验（搜索"值得评估什么"），由账本成败统计更新，不作为能力声明。 */
  operatorWeights: Record<string, number>;
  /** 每代最多评估的候选数（textual learning rate）。 */
  editBudget: number;
  maxGenerations: number;
  plateauPatience: number;
  maxEvalRuns: number;
  /** 相对初始状态允许的最大累计改动数，超出触发漂移 tripwire。 */
  maxDrift: number;
  /** 被拒 patch 的 id，防编辑振荡（SkillOpt rejected-edit buffer）。 */
  rejectedEdits: string[];
}

export interface PatchChange {
  path: string;
  from: unknown;
  to: unknown;
}

export interface Patch {
  id: string;
  operator: string;
  target: "capability" | "meta";
  description: string;
  changes: PatchChange[];
  /** 触发该候选的失败证据（来自 train 轨迹，绝不含 holdout 内容）。 */
  evidence: string[];
}

export type FailureKind =
  | "loop" | "steps" | "tokens" | "tool-error" | "missing-tool" | "answer" | "guard" | "policy" | "other";

export interface FailureSignal {
  kind: FailureKind;
  count: number;
  taskIds: string[];
  evidence: string[];
}

export interface LedgerEntry {
  seq: number;
  ts: string;
  generation: number;
  parent: string | null;
  patch: Patch;
  decision: "promoted" | "rejected" | "blocked" | "meta" | "genesis";
  reason: string;
  trainBefore: number;
  trainAfter: number;
  holdoutBefore: number;
  holdoutAfter: number;
  gatePass: boolean;
  protocolViolations: number;
  stateHash: string;
  integrityOk: boolean;
}

export interface Incident {
  ts: string;
  generation: number;
  severity: "critical" | "warning";
  kind: string;
  detail: string;
  patchId?: string;
}

export interface GenerationRecord {
  generation: number;
  signals: Array<{ kind: FailureKind; count: number; taskIds: string[] }>;
  candidates: number;
  promoted: number;
  rejected: number;
  blocked: number;
  trainBefore: number;
  trainAfter: number;
  holdoutBefore: number;
  holdoutAfter: number;
  decision: string;
}

export interface IntegritySnapshot {
  ok: boolean;
  files: number;
  changed: string[];
}

export interface EvolveReport {
  version: 1;
  agent: "bro2";
  timestamp: string;
  dryRun: boolean;
  level: string;
  taskSetHash: string;
  integrity: IntegritySnapshot;
  generations: GenerationRecord[];
  promoted: number;
  rejected: number;
  blocked: number;
  incidents: number;
  evalRuns: number;
  trainCurve: number[];
  holdoutCurve: number[];
  finalState: EvolvableState;
  finalStrategy: EvolutionStrategy;
  /** 本轮生效的改进机制状态（meta RSI 可复现性证据） */
  meta: MetaState;
  ledgerPath: string;
  stoppedBy: string;
}

export const OPERATOR_NAMES = [
  "relax-loop-threshold",
  "raise-step-ceiling",
  "tune-compaction",
  "extend-tool-timeout",
  "add-reliability-guidance",
  "enable-args-repair",
  "enable-grounding",
  "enable-salience-compaction",
  "enable-advisory-loop",
  "enable-risk-first-parallel",
] as const;

/**
 * 初始状态故意保留一个**真实次优配置**：loopDetectionThreshold=2。
 * Guards 会在连续 2 次相同工具调用时误判死循环，导致需要重复核对的任务失败。
 * 这不是硬编码的"待修复答案"，而是可被评测真实暴露、需多代搜索才能收敛的参数。
 */
export const DEFAULT_STATE: EvolvableState = {
  version: 1,
  budget: {
    compactTokens: 36000,
    loopDetectionThreshold: 2,
    maxSteps: 30,
    maxConcurrentTools: 4,
    toolTimeoutMs: 30000,
  },
  // 保守基线：等价于策略层引入前的行为。策略改进必须自己通过双门禁来争取。
  policy: { ...DEFAULT_POLICY },
  skillOverlays: {},
};

export const DEFAULT_STRATEGY: EvolutionStrategy = {
  version: 1,
  operatorWeights: {
    "relax-loop-threshold": 1,
    "raise-step-ceiling": 1,
    "tune-compaction": 1,
    "extend-tool-timeout": 1,
    // 初始先验认为「补一条技能指导」值得一试；它会被实证否决并降权，
    // 这正是 L4 自指的可观测证据（见 evolve 报告的算子权重漂移）。
    "add-reliability-guidance": 1.4,
    "enable-args-repair": 1,
    "enable-grounding": 1,
    "enable-salience-compaction": 1,
    "enable-advisory-loop": 1,
    "enable-risk-first-parallel": 1,
  },
  // 能力面从 5 个数字扩展到 5 个策略分支后，搜索空间变大；
  // 预算相应放宽，具体"多少才够"交由 meta RSI 用外部 fitness 测量（见 META-RSI.md）。
  editBudget: 5,
  maxGenerations: 10,
  plateauPatience: 2,
  maxEvalRuns: 90,
  maxDrift: 14,
  rejectedEdits: [],
};

/** patch 允许落点：白名单精确路径 + 白名单前缀。任何其它路径一律拒绝。 */
export const ALLOWED_EXACT_PATHS: readonly string[] = [
  "budget.compactTokens",
  "budget.loopDetectionThreshold",
  "budget.maxSteps",
  "budget.maxConcurrentTools",
  "budget.toolTimeoutMs",
  "policy.loopDetection",
  "policy.malformedArgs",
  "policy.grounding",
  "policy.compaction",
  "policy.parallel",
  "strategy.editBudget",
  "strategy.plateauPatience",
];

export const ALLOWED_PREFIXES: readonly string[] = [
  "skillOverlays.",
  "strategy.operatorWeights.",
];

/** 治理面 / 验证器 / 任务集：路径命中即 critical 拦截。 */
export const FORBIDDEN_PREFIXES: readonly string[] = [
  "permission", "storage", "server", "model", "config",
  "gate", "threshold", "task", "holdout", "train", "ledger",
  "incident", "eval", "security", "audit", "integrity",
  "kernel", "governance", "src", "skills.",
];

export const NUMERIC_RANGES: Record<string, [number, number]> = {
  "budget.compactTokens": [500, 60000],
  "budget.loopDetectionThreshold": [2, 8],
  "budget.maxSteps": [5, 60],
  "budget.maxConcurrentTools": [1, 8],
  "budget.toolTimeoutMs": [1000, 120000],
  "strategy.editBudget": [1, 5],
  "strategy.plateauPatience": [1, 5],
  "strategy.operatorWeights.": [0, 2],
};

/** de-hardcoding：禁止把留出集答案、任务 id、评分逻辑写进技能/提示增量。 */
export const DEHARDCODE_BANNED: readonly string[] = [
  "eval", "gate", "threshold", "pass", "score", "skip", "ignore",
  "override", "bypass", "sandbox", "permission", "mock", "script",
  "expectedanswer", "holdout", "train", "baseline",
];

/** 必须是可迁移的操作级指导，而不是答案或环境特定值。 */
export const DEHARDCODE_REQUIRED = /先|再|若|不要|应当|必须|之后|然后|确保/;

export function hash(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

export function shortHash(value: unknown): string {
  return hash(value).slice(0, 12);
}

export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** 不可变 set：深拷贝后按点路径写入，天然支持 diff / 回滚。 */
export function setByPath<T>(obj: T, path: string, value: unknown): T {
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  const parts = path.split(".");
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    if (cur[key] === null || cur[key] === undefined || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
  return clone as T;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------- meta RSI（改进机制自身）

/**
 * MetaState = 改进机制自身的可调参数。它作用在「如何搜索改进」上，
 * 而不是作用在「agent 能力」上（那是 EvolvableState 的职责）。
 *
 * 这是 D2I L4 → L5 之间的受限自指：Imp_t 的成败改变 Imp_{t+1} 的搜索方式，
 * 但**不改变验证层级**——尺子始终固定在 PROTECTED_FILES 的冻结评分面里。
 */
export interface MetaState {
  version: 1;
  /** 失败挖掘保留的证据条数上限（4–24） */
  evidenceLimit: number;
  /** 是否启用"策略失败优先"分类规则 */
  policyRule: boolean;
  /** 候选排序策略 */
  candidateOrder: "weight" | "round-robin" | "evidence-first";
  /** 算子集合：all 全部 / lean 只保留被实证命中的算子 */
  operatorSet: "all" | "lean";
  /** 平台期耐心（覆盖 strategy.plateauPatience，1–4） */
  plateauPatience: number;
  /** 晋升判据；lenient 是被明确禁止的危险值（会放松 holdout 严格提升） */
  promotionStrictness: "strict" | "efficiency-tiebreak";
  /** 平台期是否扩大编辑预算 */
  editBudgetAdaptation: "fixed" | "plateau-expand";
}

export const DEFAULT_META: MetaState = {
  version: 1,
  evidenceLimit: 12,
  policyRule: true,
  candidateOrder: "weight",
  operatorSet: "all",
  plateauPatience: 2,
  promotionStrictness: "strict",
  editBudgetAdaptation: "fixed",
};

export const META_KEYS: readonly (keyof MetaState)[] = [
  "evidenceLimit", "policyRule", "candidateOrder", "operatorSet",
  "plateauPatience", "promotionStrictness", "editBudgetAdaptation",
];

export const META_ENUMS: Partial<Record<keyof MetaState, readonly string[]>> = {
  candidateOrder: ["weight", "round-robin", "evidence-first"],
  operatorSet: ["all", "lean"],
  promotionStrictness: ["strict", "efficiency-tiebreak"],
  editBudgetAdaptation: ["fixed", "plateau-expand"],
};

export const META_RANGES: Partial<Record<keyof MetaState, [number, number]>> = {
  evidenceLimit: [4, 24],
  plateauPatience: [1, 4],
};

export const META_DESCRIPTIONS: Record<keyof MetaState, string> = {
  evidenceLimit: "失败挖掘证据窗口",
  policyRule: "策略失败优先分类规则",
  candidateOrder: "候选排序策略",
  operatorSet: "参与搜索的算子集合",
  plateauPatience: "平台期耐心",
  promotionStrictness: "晋升判据严格度",
  editBudgetAdaptation: "平台期编辑预算自适应",
};

/** lean 集合：只保留本评测域内被实证命中的算子，避免无效候选消耗 eval 预算。 */
export const LEAN_OPERATOR_SET: readonly string[] = [
  "relax-loop-threshold",
  "enable-args-repair",
  "enable-grounding",
  "enable-salience-compaction",
  "enable-advisory-loop",
  "enable-risk-first-parallel",
];

/** 严格白名单解析，非法值回退 DEFAULT_META。 */
export function parseMeta(raw: unknown): MetaState {
  const out: MetaState = { ...DEFAULT_META };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const k of META_KEYS) {
    const v = o[k];
    const enums = META_ENUMS[k];
    const range = META_RANGES[k];
    if (enums) {
      if (typeof v === "string" && enums.includes(v)) (out as unknown as Record<string, unknown>)[k] = v;
    } else if (range) {
      if (typeof v === "number" && v >= range[0] && v <= range[1]) (out as unknown as Record<string, unknown>)[k] = v;
    } else if (k === "policyRule" && typeof v === "boolean") {
      out.policyRule = v;
    }
  }
  return out;
}
