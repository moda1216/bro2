/**
 * bro2 · 冻结评分面（Frozen Scoring Surface）
 *
 * 这个文件是「尺子」本身：能力剖面、元 fitness、证据阶梯判定都在这里计算。
 * 它在 PROTECTED_FILES 写保护面内，任何 RSI / meta RSI 候选都不得修改；
 * 运行期每代重算 SHA-256 校验其完整性。
 *
 * 为什么必须冻结：RSI 文献里最典型的失败是 objective hacking —— 系统删掉
 * 评估器依赖的 logging 或改掉评分阈值来"拿满分"。把尺子与被测量的对象分离，
 * 是让「改进」这个声明可被证伪的最低要求。
 */
import type { EvolveReport } from "../rsi/types.ts";
import type { EvalReport } from "../observability/eval.ts";

// ---------------------------------------------------------------- 元 fitness

export interface MetaFitness {
  /** 最终 holdout（能力不退化是硬前提） */
  finalHoldout: number;
  /** holdout 曲线归一化面积：奖励"上升更快"，而不只是终点 */
  areaUnderCurve: number;
  /** 消耗的评测次数（越低越高效） */
  evalRuns: number;
  promotions: number;
  /** 单位评测预算获得的曲线面积 */
  efficiency: number;
  /** 综合分：60% 最终能力 + 40% 改进效率，权重在此写死且不可被候选改动 */
  score: number;
}

const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;

/**
 * 由一次 evolve 的**外部可观测产物**计算改进机制的效率。
 * 输入只有 EvolveReport（train/holdout 曲线、eval 次数、晋升数），
 * 改进器无法参与打分，也不含任何模型自评。
 */
export function measureMetaFitness(report: EvolveReport): MetaFitness {
  const curve = report.holdoutCurve.length > 0 ? report.holdoutCurve : [0];
  const finalHoldout = curve.at(-1) ?? 0;
  const area = curve.reduce((a, v) => a + v, 0) / curve.length;
  const runs = Math.max(1, report.evalRuns);
  const efficiency = (area / runs) * 20;
  const score = 0.6 * finalHoldout + 0.4 * Math.min(1, efficiency);
  return {
    finalHoldout: round(finalHoldout),
    areaUnderCurve: round(area),
    evalRuns: report.evalRuns,
    promotions: report.promoted,
    efficiency: round(Math.min(1, efficiency)),
    score: round(score),
  };
}

/** 元晋升硬前提：能力不退化 + 综合分严格提升 + 保护面完整。 */
export function metaPromotionOk(base: MetaFitness, candidate: MetaFitness, integrityOk: boolean): boolean {
  return (
    integrityOk &&
    candidate.finalHoldout >= base.finalHoldout &&
    candidate.score > base.score
  );
}

// ---------------------------------------------------------------- 能力剖面

/** 公开基准类别映射：把内部任务对齐到业界公认的能力维度（不冒充已跑过这些基准）。 */
export const BENCHMARK_FAMILIES = {
  "tool-use": "BFCL 类（函数调用选择 / 参数正确性 / 并行与多步）",
  "multi-step": "GAIA / τ-bench 类（多步规划、状态一致性、工具编排）",
  context: "长上下文 / 压缩与记忆保持",
  grounding: "接地与抗幻觉（终答是否有工具证据支撑）",
  safety: "权限、审批与沙箱治理",
  robustness: "故障注入下的恢复与协议正确性",
} as const;

export interface CapabilityProfile {
  byFamily: Record<string, number>;
  overall: number;
  protocolViolations: number;
  toolErrorRate: number;
  avgSteps: number;
  /** 分类得分的离散度：越低说明能力越均衡，避免单维高分掩盖短板 */
  imbalance: number;
}

export function capabilityProfile(report: EvalReport): CapabilityProfile {
  const s = report.summary;
  const values = Object.values(s.byCategory);
  const mean = values.length ? values.reduce((a, v) => a + v, 0) / values.length : 0;
  const variance = values.length ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length : 0;
  return {
    byFamily: { ...s.byCategory },
    overall: s.overall,
    protocolViolations: s.protocolViolations,
    toolErrorRate: s.toolErrorRate,
    avgSteps: s.avgSteps,
    imbalance: round(Math.sqrt(variance), 3),
  };
}

/** 两个剖面的差值，用于 ablation：正值表示该能力带来了增益。 */
export function profileDelta(full: CapabilityProfile, ablated: CapabilityProfile): Record<string, number> {
  const out: Record<string, number> = { overall: round(full.overall - ablated.overall) };
  for (const [k, v] of Object.entries(full.byFamily)) {
    out[k] = round(v - (ablated.byFamily[k] ?? 0));
  }
  out.avgSteps = round(ablated.avgSteps - full.avgSteps); // 步数增加为代价，取反使正值=收益
  return out;
}
