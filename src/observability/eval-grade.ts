/**
 * L7 可观测性 · 评测判分与故障配置
 * ----------------------------------------------------------
 * 从 eval.ts 拆出的原因只有一个：**单文件不得超过 700 行**（预算门禁）。
 * 职责边界不变：这里只做「从轨迹抽指标 + 按任务判分 + 构造故障配置 + 对照判定 +
 * 晋升判定」，执行编排与报告聚合仍由 eval.ts / bench-v2.ts 负责，避免第二套口径。
 * v2.9.0：故障恢复的确定性对照判定（judgeContrast）并入本模块——它属于「判分」，
 * 与 grade 同口径；独立成文件会把源文件数顶破预算（少而精：合并优先于新增）。
 * v2.11.0：三段晋升判据（judgePromotion）同样并入——判定的是「编辑能否晋升」，
 * 与判分同属纯判定层；零新增源文件（源文件数 90/90 已满）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventType } from "../kernel/events.ts";
import type { Event, ToolCall, ToolResult } from "../kernel/events.ts";
import type { RunResult } from "../kernel/loop.ts";
import type { RuntimeConfig } from "../kernel/runtime.ts";
import { ApprovalDecision } from "../governance/approval.ts";
import type { EvalRunMetrics, EvalTask } from "./eval.ts";


export interface Extracted {
  toolCalls: number;
  toolNames: Set<string>;
  toolUsage: Record<string, number>;
  toolErrors: number;
  guards: number;
  compactions: number;
  approvalsDenied: number;
  protocolViolations: number;
  errors: number;
  providers: string[];
  repairs: number;
  groundingRejects: number;
  loopAdvisories: number;
  compactionEvidence: number;
}

export function extract(events: readonly Event[]): Extracted {
  const out: Extracted = {
    toolCalls: 0,
    toolNames: new Set<string>(),
    toolUsage: {},
    toolErrors: 0,
    guards: 0,
    compactions: 0,
    approvalsDenied: 0,
    protocolViolations: 0,
    errors: 0,
    providers: [],
    repairs: 0,
    groundingRejects: 0,
    loopAdvisories: 0,
    compactionEvidence: 0,
  };
  const requested = new Set<string>();
  const answered = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case EventType.ToolCall: {
        const calls = (e.payload.calls as ToolCall[] | undefined) ?? [];
        out.toolCalls += calls.length;
        for (const c of calls) {
          out.toolNames.add(c.name);
          out.toolUsage[c.name] = (out.toolUsage[c.name] ?? 0) + 1;
          requested.add(c.id);
        }
        break;
      }
      case EventType.ToolResult: {
        const r = e.payload.result as ToolResult | undefined;
        if (r) {
          answered.add(r.callId);
          out.toolNames.add(r.name);
          if (!r.ok) out.toolErrors += 1;
        }
        break;
      }
      case EventType.Guard:
        out.guards += 1;
        break;
      case EventType.Compaction:
        out.compactions += 1;
        out.compactionEvidence += Number(e.payload.evidenceKept ?? 0);
        break;
      case EventType.ToolRepair:
        out.repairs += 1;
        break;
      case EventType.GroundingReject:
        out.groundingRejects += 1;
        break;
      case EventType.LoopAdvisory:
        out.loopAdvisories += 1;
        break;
      case EventType.ApprovalResolved:
        if (e.payload.decision === ApprovalDecision.Deny) out.approvalsDenied += 1;
        break;
      case EventType.Error:
        out.errors += 1;
        break;
      case EventType.AssistantMessage:
        if (typeof e.payload.provider === "string") out.providers.push(String(e.payload.provider));
        break;
      default:
        break;
    }
  }
  for (const id of requested) if (!answered.has(id)) out.protocolViolations += 1;
  return out;
}


export interface OracleContext {
  answer: string;
  workspace: string;
  reference?: string;
  expect?: string;
  task: EvalTask;
}

export type Oracle = (ctx: OracleContext) => string | null;

const ORACLES: Record<string, Oracle> = {
  "answer-matches-reference": ({ answer, reference }) =>
    !reference ? "oracle 缺少 reference" : answer.toLowerCase().includes(reference.toLowerCase()) ? null : `终答未包含真值参考 "${reference}"`,
  "answer-equals-reference": ({ answer, reference }) =>
    !reference ? "oracle 缺少 reference" : answer.trim() === reference.trim() ? null : "终答与真值参考不一致",
  "file-contains-reference": ({ workspace, reference, expect }) => {
    if (!expect) return "file-contains-reference 需要 expect 指定文件路径";
    if (!reference) return "oracle 缺少 reference";
    const p = join(workspace, expect);
    if (!existsSync(p)) return `期望文件未生成: ${expect}`;
    return readFileSync(p, "utf8").includes(reference) ? null : `文件 ${expect} 未包含真值参考 "${reference}"`;
  },
};

export function registerOracle(id: string, fn: Oracle): void {
  ORACLES[id] = fn;
}

export function listOracles(): string[] {
  return Object.keys(ORACLES);
}


export function grade(task: EvalTask, run: RunResult, ex: Extracted, workspace: string): string[] {
  const reasons: string[] = [];
  const expectedStop = task.expectedStop ?? "completed";
  if (run.stoppedBy !== expectedStop) reasons.push(`停止原因 ${run.stoppedBy} ≠ ${expectedStop}`);

  if (task.expectedTools) {
    for (const name of task.expectedTools) {
      if (!ex.toolNames.has(name)) reasons.push(`未调用工具 ${name}`);
    }
  }
  if (task.expectNoTools && run.toolCallCount > 0) {
    reasons.push(`期望零工具调用，实际 ${run.toolCallCount}`);
  }
  if (task.expectedAnswer && task.expectedAnswer.length > 0) {
    const lower = run.answer.toLowerCase();
    if (!task.expectedAnswer.some((k) => lower.includes(k.toLowerCase()))) {
      reasons.push(`终答未包含期望内容 ${JSON.stringify(task.expectedAnswer)}`);
    }
  }
  if (task.expectedFiles) {
    for (const f of task.expectedFiles) {
      const p = join(workspace, f.path);
      if (!existsSync(p)) {
        reasons.push(`期望文件未生成: ${f.path}`);
        continue;
      }
      if (f.contains && !readFileSync(p, "utf8").includes(f.contains)) {
        reasons.push(`文件 ${f.path} 未包含 "${f.contains}"`);
      }
    }
  }
  if (task.maxSteps !== undefined && run.steps + 1 > task.maxSteps) {
    reasons.push(`步数 ${run.steps + 1} 超过上限 ${task.maxSteps}`);
  }
  if (task.expectGuard && ex.guards === 0) reasons.push("未触发预期的 Guard");
  if (task.expectToolErrors && ex.toolErrors === 0) reasons.push("故障未被工具层捕获并回喂");
  if (task.expectApprovalDenied && ex.approvalsDenied === 0) reasons.push("审批拒绝未被正确施加");
  if (task.expectCompaction && ex.compactions === 0) reasons.push("未触发上下文压缩");
  if (task.expectRepair && ex.repairs === 0) reasons.push("未触发受控参数修复（repair 策略未生效）");
  if (task.expectGroundingReject && ex.groundingRejects === 0) reasons.push("未触发终答接地打回");
  if (task.expectLoopAdvisory && ex.loopAdvisories === 0) reasons.push("未触发死循环软警告（advisory 策略未生效）");
  if (task.expectCompactionEvidence && ex.compactionEvidence === 0) reasons.push("压缩未优先保留工具证据（salience 策略未生效）");
  if (task.expectNoLoopAdvisory && ex.loopAdvisories > 0) reasons.push("治理不变量被破坏：死循环被软警告绕过");
  if (task.expectNoRepair && ex.repairs > 0) reasons.push("治理不变量被破坏：无关工具被模糊修复");
  if (task.oracle) {
    const oracle = ORACLES[task.oracle.id];
    if (!oracle) reasons.push(`未知 oracle: ${task.oracle.id}`);
    else {
      const msg = oracle({ answer: run.answer, workspace, reference: task.oracle.reference, expect: task.oracle.expect, task });
      if (msg) reasons.push(`外部 oracle ${task.oracle.id} 判定失败：${msg}`);
    }
  }
  if (ex.protocolViolations > 0) reasons.push(`存在 ${ex.protocolViolations} 个未配对 tool_call（协议违规）`);
  if (!run.answer) reasons.push("终答为空");
  return reasons;
}

export function faultConfig(task: EvalTask, tmp: string): Partial<RuntimeConfig> {
  const patch: Record<string, unknown> = {
    storage: { dir: tmp },
    permission: { workspace: join(tmp, "ws"), allowedPaths: [join(tmp, "ws")] },
  };
  const budget: Record<string, unknown> = {};
  if (task.fault === "step-limit") budget.maxSteps = 1;
  if (task.maxTokens !== undefined) budget.maxTokens = task.maxTokens;
  if (task.compactTokens !== undefined) budget.compactTokens = task.compactTokens;
  if (Object.keys(budget).length > 0) patch.budget = budget;
  return patch as unknown as Partial<RuntimeConfig>;
}

export function mergeConfigForEval(
  base: Partial<RuntimeConfig>,
  override?: Partial<RuntimeConfig>,
): Partial<RuntimeConfig> {
  if (!override) return base;
  const b = base as Record<string, unknown>;
  const o = override as Record<string, unknown>;
  return {
    ...b,
    ...o,
    storage: b.storage,
    permission: b.permission,
    budget: { ...((b.budget as object) ?? {}), ...((o.budget as object) ?? {}) },
    model: { ...((b.model as object) ?? {}), ...((o.model as object) ?? {}) },
  } as Partial<RuntimeConfig>;
}

export function emptyRun(task: EvalTask, repeat: number, reasons: string[]): EvalRunMetrics {
  return {
    taskId: task.id, category: task.category, repeat, ok: false, reasons, stoppedBy: "error",
    steps: 0, toolCalls: 0, toolErrors: 0, guards: 0, approvalsDenied: 0, compactions: 0,
    protocolViolations: 0, repairs: 0, groundingRejects: 0, loopAdvisories: 0, compactionEvidence: 0,
    tools: {}, providerRetries: 0, faultsInjected: 0, emptyGuardHits: 0, tokens: 0, latencyMs: 0, provider: "unknown", answer: "",
  };
}


export type ContrastMechanism = "retry" | "empty-guard" | "repair";
export type ContrastEffect = "pass" | "efficiency";

export interface ContrastSpec {
  id: string;
  mechanism: ContrastMechanism;
  effect: ContrastEffect;
  times: number;
  variableOn: unknown;
  variableOff: unknown;
  sharedHashOn: string;
  sharedHashOff: string;
  taskHashOn: string;
  taskHashOff: string;
}

export interface ContrastSide {
  ok: boolean;
  answer: string;
  stoppedBy: string;
  faultsInjected: number;
  providerRetries: number;
  emptyGuardHits: number;
  repairs: number;
  toolErrors: number;
  protocolViolations: number;
}

export interface ContrastVerdict {
  id: string;
  mechanism: ContrastMechanism;
  effect: ContrastEffect;
  accepted: boolean;
  reasons: string[];
  on: ContrastSide;
  off: ContrastSide;
}

const contrastSide = (r: EvalRunMetrics): ContrastSide => ({
  ok: r.ok,
  answer: r.answer,
  stoppedBy: r.stoppedBy,
  faultsInjected: r.faultsInjected,
  providerRetries: r.providerRetries,
  emptyGuardHits: r.emptyGuardHits,
  repairs: r.repairs,
  toolErrors: r.toolErrors,
  protocolViolations: r.protocolViolations,
});

export function judgeContrast(spec: ContrastSpec, on: EvalRunMetrics, off: EvalRunMetrics): ContrastVerdict {
  const reasons: string[] = [];

  if (spec.sharedHashOn !== spec.sharedHashOff) reasons.push("公共配置哈希不一致：on/off 不是唯一变量");
  if (spec.taskHashOn !== spec.taskHashOff) reasons.push("任务定义哈希不一致：on/off 不是同一任务");
  if (JSON.stringify(spec.variableOn) === JSON.stringify(spec.variableOff)) {
    reasons.push("唯一变量取值相同：未形成对照");
  }

  if (on.faultsInjected < 1 || off.faultsInjected < 1) {
    reasons.push(`故障是哑弹（on=${on.faultsInjected}, off=${off.faultsInjected}）：至少一侧未实际注入`);
  }
  if (on.faultsInjected !== spec.times) {
    reasons.push(`机制开侧注入未打完（${on.faultsInjected}/${spec.times}）：恢复结论不可信`);
  }

  if (spec.mechanism === "retry") {
    if (on.providerRetries < spec.times) reasons.push(`机制开侧重试计数 ${on.providerRetries} < ${spec.times}`);
    if (off.providerRetries !== 0) reasons.push(`机制关侧仍有 ${off.providerRetries} 次路由重试`);
  } else if (spec.mechanism === "empty-guard") {
    if (on.emptyGuardHits < 1) reasons.push("机制开侧空响应守卫计数为 0");
    if (off.emptyGuardHits !== 0) reasons.push(`机制关侧守卫仍命中 ${off.emptyGuardHits} 次`);
  } else {
    if (on.repairs < 1 || on.toolErrors > 0) {
      reasons.push(`repair 侧未修复或仍有工具错误（repairs=${on.repairs}, toolErrors=${on.toolErrors}）`);
    }
    if (off.repairs !== 0 || off.toolErrors < 1) {
      reasons.push(`fail 侧未产生可归因的工具错误（repairs=${off.repairs}, toolErrors=${off.toolErrors}）`);
    }
  }

  if (spec.effect === "pass") {
    if (!on.ok || on.answer.trim() === "") reasons.push("机制开侧未完成任务或终答为空");
    if (off.ok && off.answer.trim() !== "") reasons.push("机制关侧同样完成：差异不存在");
  } else if (!on.ok || !off.ok) {
    reasons.push("效率级对照两侧都应完成（差异只在机制计数，不在通过率）");
  }

  if (on.protocolViolations > 0 || off.protocolViolations > 0) {
    reasons.push("存在未配对 tool_call（协议违规）");
  }

  return {
    id: spec.id, mechanism: spec.mechanism, effect: spec.effect,
    accepted: reasons.length === 0, reasons,
    on: contrastSide(on), off: contrastSide(off),
  };
}


export interface PromotionScores { dev: number; holdout: number; ood: number }

export interface PromotionSpec {
  id: string;
  before: PromotionScores;
  after: PromotionScores;
  hashes: { dev: [string, string]; holdout: [string, string]; ood: [string, string] };
  searchTouchedHashes: string[];
  available: { dev: boolean; holdout: boolean; ood: boolean };
  protocolViolationsAfter: number;
  integrityOk: boolean;
  usedGroundTruthVerifier: boolean; // harness 内部真值验证器：读自身行为自我确认 → 拒绝晋升（自确认循环）
  usedExternalOracle?: boolean; // 外部真值 oracle（agent 不可见 reference）作独立佐证；只进审计、不影响 promoted
  tolerance?: number;
  selfReportedGain?: number;
  cost?: { remoteBefore: number; remoteAfter: number }; // 可选成本目标（远程调用数，越大越贵）；提供时晋升不得使其上升（P0.5-c：remoteAvoided↑ 且分数不降才纳入）。确定性评测域暂无成本信号，留待 hybrid 评测接入。
}

export interface PromotionVerdict {
  id: string;
  promoted: boolean;
  reasons: string[];
  deltas: PromotionScores;
  blockedByOod: boolean;
  rewardHackingBlocked: boolean;
  externalOracleCorroborated: boolean; // 外部真值 oracle 独立佐证标记；只进审计、不参与 promoted 判定
}

const SLICES = ["dev", "holdout", "ood"] as const;

export function judgePromotion(spec: PromotionSpec): PromotionVerdict {
  const reasons: string[] = [];
  const tol = spec.tolerance ?? 0;
  const finite = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  const deltas: PromotionScores = {
    dev: spec.after.dev - spec.before.dev,
    holdout: spec.after.holdout - spec.before.holdout,
    ood: spec.after.ood - spec.before.ood,
  };

  for (const s of SLICES) {
    if (!spec.available[s]) reasons.push(`${s} 段静默缺格：没有真实评测结果`);
    if (!finite(spec.before[s]) || !finite(spec.after[s])) {
      reasons.push(`${s} 段分数非 [0,1] 有限值：不可参与晋升判定`);
    }
  }

  if (!spec.integrityOk) reasons.push("完整性 tripwire 失败：闭环不可信");
  if (spec.usedGroundTruthVerifier) reasons.push("启用了真值验证器：自确认循环，拒绝晋升");

  for (const s of SLICES) {
    if (spec.hashes[s][0] !== spec.hashes[s][1]) {
      reasons.push(`${s} 段任务集在编辑前后被改动：对比失效（防调难度刷分）`);
    }
  }
  const uniq = new Set(SLICES.map((s) => spec.hashes[s][0]));
  if (uniq.size !== 3) reasons.push("三段任务集指纹不互异：dev/holdout/OOD 未真正留出");

  const oodHashes = spec.hashes.ood;
  if (spec.searchTouchedHashes.some((h) => oodHashes.includes(h))) {
    reasons.push("OOD 任务集出现在搜索轨迹中：违反完全只读，晋升阻断");
  }

  if (!(deltas.dev > 0)) reasons.push(`dev 未严格提升（Δ=${deltas.dev.toFixed(4)}）`);
  if (deltas.holdout < -tol) reasons.push(`holdout 退化 ${deltas.holdout.toFixed(4)} 超过容差 ${tol}`);
  const oodRegressed = deltas.ood < -tol;
  if (oodRegressed) reasons.push(`OOD 退化 ${deltas.ood.toFixed(4)} 超过容差 ${tol}：退化即阻断`);

  if (spec.protocolViolationsAfter > 0) {
    reasons.push(`编辑后存在 ${spec.protocolViolationsAfter} 个协议违规`);
  }

  if (spec.cost && spec.cost.remoteAfter > spec.cost.remoteBefore) reasons.push(`远程调用未不降反升（${spec.cost.remoteBefore}→${spec.cost.remoteAfter}）：成本退化`);

  const promoted = reasons.length === 0;
  const rewardHackingBlocked = (spec.selfReportedGain ?? 0) > 0 && !promoted;
  return {
    id: spec.id, promoted, reasons, deltas,
    blockedByOod: oodRegressed && !promoted,
    rewardHackingBlocked,
    externalOracleCorroborated: spec.usedExternalOracle ?? false,
  };
}
