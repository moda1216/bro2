/**
 * L7 可观测性 · 评测判分与故障配置
 * ----------------------------------------------------------
 * 从 eval.ts 拆出的原因只有一个：**单文件不得超过 700 行**（预算门禁）。
 * 职责边界不变：这里只做「从轨迹抽指标 + 按任务判分 + 构造故障配置」，
 * 执行编排与报告聚合仍由 eval.ts 负责，避免第二套口径。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventType } from "../kernel/events.ts";
import type { Event, ToolCall, ToolResult } from "../kernel/events.ts";
import type { RunResult } from "../kernel/loop.ts";
import type { RuntimeConfig } from "../kernel/runtime.ts";
import { ApprovalDecision } from "../governance/approval.ts";
import type { EvalRunMetrics, EvalTask } from "./eval.ts";

// ---------------------------------------------------------------- 指标抽取

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
          // 记录"实际执行"的工具名：repair 策略会修正拼错的调用名
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
  // 协议正确性硬指标：每个 tool_call 必须有配对的 tool 结果消息
  for (const id of requested) if (!answered.has(id)) out.protocolViolations += 1;
  return out;
}

// ---------------------------------------------------------------- 评分

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
  // 所有任务共享的零容忍正确性断言
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

/** ablation 配置合并：policy/budget 可覆盖，隔离路径强制由评测器最后钉死。 */
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

/** 失败兜底：用于环境准备异常等「还没跑到模型」的情况，字段口径与正常结果一致。 */
export function emptyRun(task: EvalTask, repeat: number, reasons: string[]): EvalRunMetrics {
  return {
    taskId: task.id, category: task.category, repeat, ok: false, reasons, stoppedBy: "error",
    steps: 0, toolCalls: 0, toolErrors: 0, guards: 0, approvalsDenied: 0, compactions: 0,
    protocolViolations: 0, repairs: 0, groundingRejects: 0, loopAdvisories: 0, compactionEvidence: 0,
    tools: {}, providerRetries: 0, faultsInjected: 0, tokens: 0, latencyMs: 0, provider: "unknown", answer: "",
  };
}
