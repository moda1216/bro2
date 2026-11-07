/**
 * bro2 · Harness 贡献分离（Ablation）
 *
 * 「证明领先」能拿到的最强内部证据：在同一任务集、同一模型、同一预算下，
 * 逐个关闭 bro2 的能力，量化每个组件对最终得分的真实贡献。
 *
 * 关键的防循环论证处理：ablation 任务集**剥离 expectedPolicy 配置断言**，
 * 只保留行为断言（工具是否真实执行、终答是否正确、事件是否发生）。
 * 因此变体之间的分数差异来自「行为」，不是「配置值是否被检查到」。
 */
import { resolve } from "node:path";
import { runEval, loadTasks } from "../observability/eval.ts";
import type { EvalTask, EvalReport } from "../observability/eval.ts";
import type { RuntimeConfig } from "../kernel/runtime.ts";
import { capabilityProfile, profileDelta } from "./scoring.ts";
import type { CapabilityProfile } from "./scoring.ts";

export interface AblationVariant {
  id: string;
  label: string;
  description: string;
  useEvolvedState: boolean;
  configOverride?: Partial<RuntimeConfig>;
}

export interface AblationResult {
  id: string;
  label: string;
  description: string;
  profile: CapabilityProfile;
  overall: number;
  passed: number;
  total: number;
  gatePass: boolean;
  /** full − variant：正值表示该被消融的能力带来了增益 */
  deltaFromFull: Record<string, number>;
}

export interface AblationReport {
  version: 1;
  timestamp: string;
  taskSet: string;
  taskCount: number;
  /** 全部任务已剥离配置断言，只保留行为断言 */
  behaviorOnly: boolean;
  variants: AblationVariant[];
  results: AblationResult[];
  /** 每个被消融组件相对完整 bro2 的总体得分损失 */
  contribution: Array<{ id: string; label: string; loss: number }>;
  fullOverall: number;
  note: string;
}

/** 只保留行为断言，去掉「检查配置值」的断言，避免 ablation 变成自我指认。 */
export function stripConfigAssertions(tasks: readonly EvalTask[]): EvalTask[] {
  return tasks.map((t) => {
    const { expectedPolicy: _ignored, ...rest } = t;
    return { ...rest } as EvalTask;
  });
}

const policyOverride = (p: Record<string, string>): Partial<RuntimeConfig> =>
  ({ policy: p } as unknown as Partial<RuntimeConfig>);

export const DEFAULT_VARIANTS: AblationVariant[] = [
  {
    id: "full", label: "完整 bro2（已落地演进策略）",
    description: "加载 data/evolve/state.json 中通过双门禁的策略改进",
    useEvolvedState: true,
  },
  {
    id: "conservative", label: "保守基线（策略层全关）",
    description: "等价于策略分派层引入之前的行为",
    useEvolvedState: false,
    configOverride: policyOverride({
      loopDetection: "exact", malformedArgs: "fail", grounding: "off",
      compaction: "truncate", parallel: "fifo",
    }),
  },
  {
    id: "naive-single-step", label: "朴素单轮（无多步工具循环）",
    description: "maxSteps=1：模拟只有一次模型请求、没有 tool-result 回喂循环的朴素 agent",
    useEvolvedState: true,
    configOverride: { budget: { maxSteps: 1 } as RuntimeConfig["budget"] },
  },
  {
    id: "no-repair", label: "消融：受控参数修复",
    description: "malformedArgs=fail",
    useEvolvedState: true,
    configOverride: policyOverride({ malformedArgs: "fail" }),
  },
  {
    id: "no-grounding", label: "消融：终答接地校验",
    description: "grounding=off",
    useEvolvedState: true,
    configOverride: policyOverride({ grounding: "off" }),
  },
  {
    id: "no-salience", label: "消融：证据优先压缩",
    description: "compaction=truncate",
    useEvolvedState: true,
    configOverride: policyOverride({ compaction: "truncate" }),
  },
  {
    id: "no-parallel-scheduling", label: "消融：高危优先并行调度",
    description: "parallel=fifo",
    useEvolvedState: true,
    configOverride: policyOverride({ parallel: "fifo" }),
  },
];

export interface AblationOptions {
  root: string;
  /** 默认用 evolve train（含策略行为断言）+ 4 个主评测代表任务 */
  tasksPath?: string;
  extraTasksPaths?: string[];
  /**
   * 排除的任务 id。默认排除 e9：它对应的 advisory 策略是被 holdout 治理不变量
   * **主动拒绝**的改进方向，属于治理决策而非能力目标，不应计入能力基准。
   */
  excludeTaskIds?: string[];
  variants?: AblationVariant[];
  onProgress?: (line: string) => void;
}

export async function runAblation(options: AblationOptions): Promise<AblationReport> {
  const root = options.root;
  const tasksPath = options.tasksPath ?? resolve(root, "data/evolve/train.jsonl");
  const primary = stripConfigAssertions(loadTasks(tasksPath));
  const extra: EvalTask[] = [];
  for (const p of options.extraTasksPaths ?? []) {
    const all = loadTasks(p);
    const picked = all.filter((t) => ["t01", "t08", "t13", "t18"].includes(t.id));
    extra.push(...stripConfigAssertions(picked));
  }
  const excluded = new Set(options.excludeTaskIds ?? ["e9"]);
  const tasks = [...primary, ...extra].filter((t) => !excluded.has(t.id));
  const variants = options.variants ?? DEFAULT_VARIANTS;
  const results: AblationResult[] = [];

  for (const v of variants) {
    const report: EvalReport = await runEval({
      tasks,
      mode: "deterministic",
      k: 1,
      root,
      baseline: null,
      thresholds: {
        // ablation 只比较相对差异，绝对门禁放宽，避免变体被门禁提前判死
        minOverall: 0, minToolUse: 0, minSafety: 0, minRobustness: 0,
        maxToolErrorRate: 1, maxProtocolViolations: 999, maxAvgSteps: 999, maxRegression: 1,
      },
      useEvolvedState: v.useEvolvedState,
      ...(v.configOverride ? { configOverride: v.configOverride } : {}),
    });
    results.push({
      id: v.id,
      label: v.label,
      description: v.description,
      profile: capabilityProfile(report),
      overall: report.summary.overall,
      passed: report.summary.passed,
      total: report.summary.total,
      gatePass: report.gate.pass,
      deltaFromFull: {},
    });
    options.onProgress?.(`  ${v.id.padEnd(24)} overall=${report.summary.overall}  ${report.summary.passed}/${report.summary.total}`);
  }

  const full = results.find((r) => r.id === "full");
  const fullProfile = full?.profile ?? {
    byFamily: {}, overall: 0, protocolViolations: 0, toolErrorRate: 0, avgSteps: 0, imbalance: 0,
  };
  for (const r of results) r.deltaFromFull = profileDelta(fullProfile, r.profile);

  const contribution = results
    .filter((r) => r.id !== "full")
    .map((r) => ({ id: r.id, label: r.label, loss: Math.round((fullProfile.overall - r.overall) * 1000) / 1000 }));

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    taskSet: tasksPath,
    taskCount: tasks.length,
    behaviorOnly: true,
    variants,
    results,
    contribution,
    fullOverall: fullProfile.overall,
    note:
      "这是内部可控对照，不是外部基准。它证明 Harness 各组件在本任务域内有可量化贡献，" +
      "不能据此宣称行业领先；外部基准与真实模型对比见 evidence ladder L4。",
  };
}

export function formatAblationReport(r: AblationReport): string {
  const L: string[] = [];
  const bar = "=".repeat(84);
  L.push(bar);
  L.push(`  bro2 · Harness 贡献分离（ablation）   行为断言任务 ${r.taskCount} 个   完整得分 ${r.fullOverall}`);
  L.push(bar);
  L.push("");
  L.push("  【变体得分】");
  for (const x of r.results) {
    const d = r.fullOverall - x.overall;
    const bar2 = "█".repeat(Math.round(x.overall * 20)).padEnd(20, "·");
    L.push(`   ${x.id.padEnd(24)} ${bar2} ${(x.overall * 100).toFixed(1)}%  ${x.passed}/${x.total}  ${d > 0 ? `−${d.toFixed(3)}` : "基线"}`);
  }
  L.push("");
  L.push("  【各组件贡献（相对完整 bro2 的得分损失）】");
  for (const c of r.contribution) {
    L.push(`   ${c.id.padEnd(24)} ${c.loss > 0 ? `+${c.loss.toFixed(3)}（消融后下降）` : "0.000（本域无区分度）"}`);
  }
  L.push("");
  L.push(`   ${r.note}`);
  L.push(bar);
  return L.join("\n");
}
