/**
 * bro2 · 行为策略分派层（Behavior Policy）
 *
 * 为什么需要它：RSI 若只能改数字参数，就永远停留在「调参」，碰不到代码行为。
 * 本模块把内核里若干真实算法变体抽象成有限枚举；每个枚举值都对应
 * guards / tool runtime / loop / budget 里的**实际代码分支**，而不是一个开关注释。
 * RSI 通过切换策略标识来迭代代码行为，评测驱动验证哪种变体更优。
 *
 * 关键约束：
 *  1) 默认值全部是保守变体，保证既有回归语义不变；
 *  2) 所有值经白名单解析，非法值静默回退默认（边界不可被污染）；
 *  3) 策略有取舍，不存在全局最优——由 train/holdout 上的外部断言决定，
 *     安全不变量写进 holdout，破坏它们的策略会被门禁拒绝。
 */
export type LoopDetectionMode = "exact" | "advisory";
export type MalformedArgsMode = "fail" | "repair";
export type GroundingMode = "off" | "require-evidence";
export type CompactionMode = "truncate" | "salience";
export type ParallelMode = "fifo" | "risk-first";

export interface BehaviorPolicy {
  /** 连续相同工具调用：exact 直接终止；advisory 先软警告并注入纠错提示，累计 2× 阈值才硬终止。 */
  loopDetection: LoopDetectionMode;
  /** 畸形参数：fail 直接回报错误；repair 做受控、可审计的规范化（不放松必填校验）。 */
  malformedArgs: MalformedArgsMode;
  /** 终答接地：off 直接接受；require-evidence 在「有工具调用且全部失败」时打回一次，防臆造。 */
  grounding: GroundingMode;
  /** 上下文压缩：truncate 等权截断；salience 优先完整保留成功工具结果（证据）。 */
  compaction: CompactionMode;
  /** 同一步多工具调度：fifo 按到达顺序；risk-first 高危工具优先执行。 */
  parallel: ParallelMode;
}

export const POLICY_KEYS: readonly (keyof BehaviorPolicy)[] = [
  "loopDetection", "malformedArgs", "grounding", "compaction", "parallel",
];

/** 每个维度的合法取值（guardrails 用它做枚举校验，防止 patch 注入任意值）。 */
export const POLICY_VALUES: Record<keyof BehaviorPolicy, readonly string[]> = {
  loopDetection: ["exact", "advisory"],
  malformedArgs: ["fail", "repair"],
  grounding: ["off", "require-evidence"],
  compaction: ["truncate", "salience"],
  parallel: ["fifo", "risk-first"],
};

/** 保守基线：等价于本层引入前的既有行为。 */
export const DEFAULT_POLICY: BehaviorPolicy = {
  loopDetection: "exact",
  malformedArgs: "fail",
  grounding: "off",
  compaction: "truncate",
  parallel: "fifo",
};

/** 每个维度的「增强变体」：RSI 算子从这里产生候选，但不预设它一定更优。 */
export const POLICY_UPGRADES: Record<keyof BehaviorPolicy, string> = {
  loopDetection: "advisory",
  malformedArgs: "repair",
  grounding: "require-evidence",
  compaction: "salience",
  parallel: "risk-first",
};

/** 人类可读说明，用于账本、报告与 Web 状态。 */
export const POLICY_DESCRIPTIONS: Record<keyof BehaviorPolicy, string> = {
  loopDetection: "死循环判定：硬终止 / 软警告纠错",
  malformedArgs: "畸形参数：直接失败 / 受控修复",
  grounding: "终答接地：直接接受 / 要求证据",
  compaction: "上下文压缩：等权截断 / 证据优先",
  parallel: "并行调度：到达顺序 / 高危优先",
};

/** 严格白名单解析：任何非法/缺失值都回退到保守默认，绝不把边界污染带进内核。 */
export function parsePolicy(raw: unknown): BehaviorPolicy {
  const out: BehaviorPolicy = { ...DEFAULT_POLICY };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const key of POLICY_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && POLICY_VALUES[key].includes(v)) {
      // 枚举已收窄，赋值安全
      (out as unknown as Record<string, string>)[key] = v;
    }
  }
  return out;
}

/** 供 api/status 与 runtime_status 输出，避免把内部对象直接暴露。 */
export function policySnapshot(p: BehaviorPolicy): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of POLICY_KEYS) out[k] = p[k];
  return out;
}
