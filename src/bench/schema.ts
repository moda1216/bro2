/**
 * W1 · v2 任务 schema
 *
 * 设计约束（少而精）：
 *  1. **不重写评测器**。v2 任务最终被 `toEvalTask()` 压平成既有 `EvalTask`，
 *     执行、判分、指标抽取仍由 observability/eval.ts 唯一实现，杜绝第二套口径。
 *  2. **向后兼容而非另起一套**。旧任务集（无 `schema` 字段）经 `upgradeLegacy()`
 *     幂等升格即可跑，不需要复制一份改写过的任务文件——避免两份事实源漂移。
 *  3. **只新增真实需要的字段**：`layer`（分层）、`repo`/`commit`（fixture 绑定）、
 *     `hiddenTests`（隐藏验收）、`budget`（成本上限）。其余沿用旧 schema。
 */
import type { EvalCategory, EvalTask } from "../observability/eval.ts";

export const TASK_SCHEMA = "bro2.task/2" as const;

export type TaskLayer = "l1" | "l2" | "l3";

export const CATEGORIES: readonly EvalCategory[] = [
  "tool-use", "multi-step", "context", "safety", "robustness", "grounding",
];

export const LAYERS: readonly TaskLayer[] = ["l1", "l2", "l3"];

/** 参考解：只用于校准任务「可解且非白送」，**绝不下发给被测 agent**。 */
export interface TaskReference {
  file: string;
  /** 精确替换（与 file_edit 同语义） */
  find?: string;
  replace?: string;
  /** 追加到文件末尾（新增导出时使用） */
  append?: string;
}

/** v2 任务：在既有 EvalTask 之上只加必要字段。 */
export interface TaskV2 extends EvalTask {
  schema: typeof TASK_SCHEMA;
  layer: TaskLayer;
  /** fixture 仓库名（相对 data/fixtures/repos/）；缺省表示无外部仓库 */
  repo?: string;
  /** 期望的工作起点 commit（fixture 为真实仓库快照时使用） */
  commit?: string;
  /** 隐藏验收命令/断言：不暴露给被测 agent，只在判分阶段运行 */
  hiddenTests?: string[];
  /** 成本上限。旧字段 maxSteps/maxTokens 由 budget 派生，二者保持一致 */
  budget?: { maxSteps?: number; maxTokens?: number };
  /** 格式样例任务：能跑通，但不计入真实工程通过率 */
  sample?: boolean;
  /** 真实能力任务：deterministic 模式无脚本可依，跳过而不是伪造通过 */
  liveOnly?: boolean;
  /** 参考解（仅校准用） */
  reference?: TaskReference[];
}

/** 旧任务升格：幂等，已有 v2 字段则原样保留。 */
export function upgradeLegacy(raw: Record<string, unknown>, layer: TaskLayer): TaskV2 {
  const budget = (raw.budget as TaskV2["budget"]) ?? {
    maxSteps: raw.maxSteps as number | undefined,
    maxTokens: raw.maxTokens as number | undefined,
  };
  return {
    ...(raw as unknown as EvalTask),
    schema: TASK_SCHEMA,
    layer: (raw.layer as TaskLayer) ?? layer,
    budget,
  };
}

/** 运行时校验：返回**全部**问题而不是抛首个异常，便于一次修完。 */
export function validateTaskV2(t: TaskV2): string[] {
  const p: string[] = [];
  const label = typeof t.id === "string" && t.id ? `id=${t.id}` : "id=<缺失>";

  if (typeof t.id !== "string" || !t.id.trim()) p.push("id 必须是非空字符串");
  if (typeof t.input !== "string" || !t.input.trim()) p.push(`${label}: input 必须是非空字符串`);
  if (!CATEGORIES.includes(t.category)) p.push(`${label}: category 非法 "${String(t.category)}"`);
  if (t.schema !== TASK_SCHEMA) p.push(`${label}: schema 必须是 "${TASK_SCHEMA}"`);
  if (!LAYERS.includes(t.layer)) p.push(`${label}: layer 非法 "${String(t.layer)}"`);

  const b = t.budget;
  if (b) {
    for (const k of ["maxSteps", "maxTokens"] as const) {
      const v = b[k];
      if (v !== undefined && (!Number.isInteger(v) || v <= 0)) p.push(`${label}: budget.${k} 必须是正整数`);
    }
  }
  if (t.hiddenTests && (!Array.isArray(t.hiddenTests) || t.hiddenTests.some((x) => typeof x !== "string"))) {
    p.push(`${label}: hiddenTests 必须是字符串数组`);
  }
  const f = t.faults?.provider;
  if (t.faults?.provider !== undefined) {
    const kinds = ["rate-limit", "server-error", "malformed-args"];
    if (!f || !kinds.includes(f.kind) || !Number.isInteger(f.times) || f.times < 1 || f.times > 5) {
      p.push(`${label}: faults.provider 需为 kind∈{rate-limit,server-error,malformed-args} 且 1≤times≤5（超过 5 次只是烧钱，不测恢复力）`);
    }
    if (t.liveOnly !== true) p.push(`${label}: 带 provider 故障的任务必须 liveOnly（deterministic 模式下注入无意义）`);
  }
  if (t.repo !== undefined && (typeof t.repo !== "string" || !t.repo.trim())) {
    p.push(`${label}: repo 必须是非空字符串`);
  }
  if (t.liveOnly !== undefined && typeof t.liveOnly !== "boolean") {
    p.push(`${label}: liveOnly 必须是布尔值`);
  }
  if (t.liveOnly === true && (t.script?.length ?? 0) > 0) {
    p.push(`${label}: liveOnly 任务不得内置脚本（否则测的是脚本不是模型）`);
  }
  for (const [i, r] of (t.reference ?? []).entries()) {
    if (!r.file?.trim()) p.push(`${label}: reference[${i}].file 不能为空`);
    const replaceMode = typeof r.find === "string" && typeof r.replace === "string";
    const appendMode = typeof r.append === "string";
    if (!replaceMode && !appendMode) p.push(`${label}: reference[${i}] 需提供 find+replace 或 append`);
    if (replaceMode && appendMode) p.push(`${label}: reference[${i}] 不能同时替换与追加`);
  }
  return p;
}

/**
 * 压平为评测器可消费的 EvalTask：剥离 v2 专有字段，把 budget 回填到旧字段。
 * 这是 v2 → 执行的**唯一**转换点。
 */
export function toEvalTask(t: TaskV2): EvalTask {
  const { schema, layer, repo, commit, hiddenTests, budget, sample, reference, ...rest } = t;
  void schema; void layer; void repo; void commit; void hiddenTests; void sample; void reference;
  return {
    ...rest,
    maxSteps: rest.maxSteps ?? budget?.maxSteps,
    maxTokens: rest.maxTokens ?? budget?.maxTokens,
  };
}
