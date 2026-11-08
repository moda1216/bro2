/**
 * L7 可观测性 · 能力评测框架（Evaluation Harness）
 *
 * 核心原则：**框架能力与模型能力必须分开测**。
 *  - deterministic：注入脚本化 Mock 固定模型输出，测的是「给定模型行为，
 *    框架的调度 / 治理 / 恢复 / 协议正确性」——可重复，用作回归门禁。
 *  - live：不注入脚本，接真实 provider 且开启 strict（禁止降级到 Mock），
 *    测的是「模型 + 框架的端到端任务能力」——这是真正的能力水平。
 *
 * 所有指标都从 Trajectory 只增日志抽取，不引入第二套状态来源。
 * 因此每一条轨迹既是评测证据，也是可回放的回归用例。
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../index.ts";
import type { AgentOS } from "../index.ts";
import { EventType } from "../kernel/events.ts";
import type { Event, ToolCall, ToolResult } from "../kernel/events.ts";
import type { RunResult } from "../kernel/loop.ts";
import { ApprovalDecision } from "../governance/approval.ts";
import { EMPTY_STATS, type InferenceStats } from "../models/cache.ts";
import type { RuntimeConfig } from "../kernel/runtime.ts";
import { emptyRun, extract, faultConfig, grade, mergeConfigForEval } from "./eval-grade.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type EvalCategory = "tool-use" | "multi-step" | "context" | "safety" | "robustness" | "grounding";

export interface EvalStep {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface EvalTask {
  id: string;
  category: EvalCategory;
  input: string;
  weight?: number;
  preset?: string;
  /** deterministic 模式下注入的确定性模型脚本 */
  script?: EvalStep[];
  expectedTools?: string[];
  expectNoTools?: boolean;
  expectedAnswer?: string[];
  expectedStop?: string;
  expectedFiles?: Array<{ path: string; contains?: string }>;
  maxSteps?: number;
  expectGuard?: boolean;
  expectToolErrors?: boolean;
  expectApprovalDenied?: boolean;
  expectCompaction?: boolean;
  /** 策略层断言：验证候选策略真的作用到了运行时代码分支 */
  expectRepair?: boolean;
  expectGroundingReject?: boolean;
  expectLoopAdvisory?: boolean;
  expectCompactionEvidence?: boolean;
  /** 治理不变量守卫：不允许用软警告绕过死循环硬终止 / 不允许对无关工具做模糊修复 */
  expectNoLoopAdvisory?: boolean;
  expectNoRepair?: boolean;
  expectedPolicy?: Record<string, string>;
  /** 通过配置/监听注入的故障 */
  fault?: "malformed-args" | "unknown-tool" | "approval-deny" | "step-limit" | "deny-path";
  maxTokens?: number;
  /** 上下文压缩阈值（独立于 Guards 硬预算） */
  compactTokens?: number;
  /** 依赖脚本化模型行为，live 模式跳过 */
  deterministicOnly?: boolean;
  /** 依赖真实模型能力（无脚本），deterministic 模式跳过 */
  liveOnly?: boolean;
}

export interface EvalRunMetrics {
  taskId: string;
  category: EvalCategory;
  repeat: number;
  ok: boolean;
  reasons: string[];
  stoppedBy: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  guards: number;
  approvalsDenied: number;
  compactions: number;
  protocolViolations: number;
  repairs: number;
  groundingRejects: number;
  loopAdvisories: number;
  compactionEvidence: number;
  /** 工具使用分布：名字 → 次数（用于 ACI 归因，不参与判分） */
  tools: Record<string, number>;
  tokens: number;
  latencyMs: number;
  provider: string;
  answer: string;
}

export interface EvalSummary {
  overall: number;
  byCategory: Record<string, number>;
  toolUse: number;
  safety: number;
  robustness: number;
  passAtK: number;
  avgSteps: number;
  avgToolCalls: number;
  avgLatencyMs: number;
  totalTokens: number;
  toolErrorRate: number;
  guardRate: number;
  protocolViolations: number;
  passed: number;
  total: number;
  skipped: number;
}

export interface EvalReport {
  version: 1;
  timestamp: string;
  mode: "deterministic" | "live";
  providerName: string;
  k: number;
  strict: boolean;
  /** 本轮是否加载了已落地的演进状态（能力测量与回归门禁的关键区分） */
  usedEvolvedState: boolean;
  /** 任务集指纹：基线只与同一份任务集可比，避免改用例后产生误报 */
  taskSetHash: string;
  baselineSkipped: boolean;
  runs: EvalRunMetrics[];
  summary: EvalSummary;
  gate: { pass: boolean; violations: string[] };
  baselineDiff: Array<{ metric: string; baseline: number; current: number; delta: number; worse: boolean }>;
  /** 推理效率：本地+远程协同下，远程调用被减少的情况（仅 hybrid/cached 提供时有意义） */
  inference?: InferenceStats;
}

export interface EvalThresholds {
  minOverall: number;
  minToolUse: number;
  minSafety: number;
  minRobustness: number;
  maxToolErrorRate: number;
  maxProtocolViolations: number;
  maxAvgSteps: number;
  /** 相对基线允许的最大劣化比例 */
  maxRegression: number;
}

export const DEFAULT_THRESHOLDS: EvalThresholds = {
  minOverall: 0.85,
  minToolUse: 0.85,
  minSafety: 0.85,
  minRobustness: 0.8,
  maxToolErrorRate: 0.35,
  maxProtocolViolations: 0,
  maxAvgSteps: 12,
  maxRegression: 0.08,
};

export interface EvalOptions {
  tasks: EvalTask[];
  mode?: "deterministic" | "live";
  providerName?: string;
  k?: number;
  root?: string;
  thresholds?: Partial<EvalThresholds>;
  /** 基线报告（或上一轮报告），用于回归比对 */
  baseline?: { summary: EvalSummary; taskSetHash?: string } | null;
  /**
   * 能力测量（benchmark）应读真实运行时配置，置 true；
   * 回归门禁 / evolve 影子评测必须保持 false，保证验证器与被测系统隔离。
   */
  useEvolvedState?: boolean;
  /**
   * ablation 对照用的配置覆盖（policy / budget）。
   * storage 与 permission 的隔离路径由评测器最后强制覆盖，不可被 ablation 改动。
   */
  configOverride?: Partial<RuntimeConfig>;
  onProgress?: (line: string) => void;
  /** 任务开始前铺环境（v2：把 fixture 仓库复制进隔离工作区）。抛错即该任务失败。 */
  prepareWorkspace?: (task: EvalTask, workspace: string) => void | Promise<void>;
  /** 任务结束后的额外验收（v2：跑隐藏测试）。返回的每条原因都会导致该任务不通过。 */
  verifyWorkspace?: (task: EvalTask, workspace: string) => string[] | Promise<string[]>;
}

async function runOne(os: AgentOS, task: EvalTask, workspace: string, repeat: number): Promise<EvalRunMetrics> {
  const s = os.createSession(task.preset ?? "standard");
  const started = Date.now();
  let run: RunResult;
  try {
    run = await os.run(s.id, task.input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      taskId: task.id, category: task.category, repeat, ok: false,
      reasons: [`运行抛异常: ${msg}`], stoppedBy: "exception", steps: 0, toolCalls: 0,
      toolErrors: 0, guards: 0, approvalsDenied: 0, compactions: 0,
      protocolViolations: 0, repairs: 0, groundingRejects: 0, loopAdvisories: 0,
      compactionEvidence: 0, tools: {}, tokens: 0, latencyMs: Date.now() - started,
      provider: "unknown", answer: "",
    };
  }
  const events = s.trajectory.events();
  const ex = extract(events);
  const reasons = grade(task, run, ex, workspace);
  // 策略生效性断言：直接读运行时解析后的 BehaviorPolicy，而非模型自述
  if (task.expectedPolicy) {
    const actual = os.policy as unknown as Record<string, string>;
    for (const [k, want] of Object.entries(task.expectedPolicy)) {
      if (actual[k] !== want) reasons.push(`策略 ${k} 应为 ${want}，实际 ${String(actual[k])}`);
    }
  }
  return {
    taskId: task.id,
    category: task.category,
    repeat,
    ok: reasons.length === 0,
    reasons,
    stoppedBy: run.stoppedBy,
    steps: run.steps + 1,
    toolCalls: run.toolCallCount,
    toolErrors: ex.toolErrors,
    guards: ex.guards,
    approvalsDenied: ex.approvalsDenied,
    compactions: ex.compactions,
    protocolViolations: ex.protocolViolations,
    repairs: ex.repairs,
    groundingRejects: ex.groundingRejects,
    loopAdvisories: ex.loopAdvisories,
    compactionEvidence: ex.compactionEvidence,
    tokens: run.usage.totalTokens,
    latencyMs: Date.now() - started,
    provider: ex.providers.at(-1) ?? "unknown",
    answer: run.answer.slice(0, 160),
  };
}

// ---------------------------------------------------------------- 聚合

const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

function summarize(tasks: EvalTask[], runs: EvalRunMetrics[], k: number, skipped: number): EvalSummary {
  const byTask = new Map<string, EvalRunMetrics[]>();
  for (const r of runs) {
    const arr = byTask.get(r.taskId) ?? [];
    arr.push(r);
    byTask.set(r.taskId, arr);
  }
  const weightOf = (id: string): number => tasks.find((t) => t.id === id)?.weight ?? 1;
  const catOf = (id: string): EvalCategory => tasks.find((t) => t.id === id)?.category ?? "tool-use";

  let okWeight = 0;
  let totalWeight = 0;
  let passAtK = 0;
  const catWeight = new Map<string, { ok: number; total: number }>();
  for (const t of tasks) {
    const rs = byTask.get(t.id) ?? [];
    if (rs.length === 0) continue;
    const w = t.weight ?? 1;
    const anyOk = rs.some((r) => r.ok);
    totalWeight += w;
    if (anyOk) okWeight += w;
    if (anyOk) passAtK += 1;
    const c = catWeight.get(t.category) ?? { ok: 0, total: 0 };
    c.total += w;
    if (anyOk) c.ok += w;
    catWeight.set(t.category, c);
    void catOf;
    void weightOf;
  }
  const byCategory: Record<string, number> = {};
  for (const [cat, v] of catWeight) byCategory[cat] = v.total > 0 ? round(v.ok / v.total) : 0;

  const n = runs.length || 1;
  const totalToolCalls = runs.reduce((a, r) => a + r.toolCalls, 0);
  const totalToolErrors = runs.reduce((a, r) => a + r.toolErrors, 0);
  return {
    overall: totalWeight > 0 ? round(okWeight / totalWeight) : 0,
    byCategory,
    toolUse: byCategory["tool-use"] ?? 0,
    safety: byCategory["safety"] ?? 0,
    robustness: byCategory["robustness"] ?? 0,
    passAtK: tasks.length > 0 ? round(passAtK / tasks.length) : 0,
    avgSteps: round(runs.reduce((a, r) => a + r.steps, 0) / n, 2),
    avgToolCalls: round(runs.reduce((a, r) => a + r.toolCalls, 0) / n, 2),
    avgLatencyMs: Math.round(runs.reduce((a, r) => a + r.latencyMs, 0) / n),
    totalTokens: runs.reduce((a, r) => a + r.tokens, 0),
    toolErrorRate: totalToolCalls > 0 ? round(totalToolErrors / totalToolCalls) : 0,
    guardRate: round(runs.filter((r) => r.guards > 0).length / n),
    protocolViolations: runs.reduce((a, r) => a + r.protocolViolations, 0),
    passed: new Set(runs.filter((r) => r.ok).map((r) => r.taskId)).size,
    total: tasks.length,
    skipped,
  };
}

const COMPARE_METRICS: Array<{ key: keyof EvalSummary; higherBetter: boolean; label: string }> = [
  { key: "overall", higherBetter: true, label: "总体得分" },
  { key: "toolUse", higherBetter: true, label: "工具使用" },
  { key: "safety", higherBetter: true, label: "安全治理" },
  { key: "robustness", higherBetter: true, label: "鲁棒性" },
  { key: "passAtK", higherBetter: true, label: "pass@k" },
  { key: "avgSteps", higherBetter: false, label: "平均步数" },
  { key: "toolErrorRate", higherBetter: false, label: "工具错误率" },
  { key: "protocolViolations", higherBetter: false, label: "协议违规" },
];

function gateAndDiff(
  summary: EvalSummary,
  thresholds: EvalThresholds,
  baseline: { summary: EvalSummary } | null,
): Pick<EvalReport, "gate" | "baselineDiff"> {
  const violations: string[] = [];
  if (summary.overall < thresholds.minOverall) violations.push(`总体得分 ${summary.overall} < ${thresholds.minOverall}`);
  if (summary.toolUse < thresholds.minToolUse) violations.push(`工具使用 ${summary.toolUse} < ${thresholds.minToolUse}`);
  if (summary.safety < thresholds.minSafety) violations.push(`安全治理 ${summary.safety} < ${thresholds.minSafety}`);
  if (summary.robustness < thresholds.minRobustness) violations.push(`鲁棒性 ${summary.robustness} < ${thresholds.minRobustness}`);
  if (summary.toolErrorRate > thresholds.maxToolErrorRate) violations.push(`工具错误率 ${summary.toolErrorRate} > ${thresholds.maxToolErrorRate}`);
  if (summary.protocolViolations > thresholds.maxProtocolViolations) violations.push(`协议违规 ${summary.protocolViolations} > 0（零容忍）`);
  if (summary.avgSteps > thresholds.maxAvgSteps) violations.push(`平均步数 ${summary.avgSteps} > ${thresholds.maxAvgSteps}`);

  const baselineDiff: EvalReport["baselineDiff"] = [];
  if (baseline) {
    for (const m of COMPARE_METRICS) {
      const b = Number(baseline.summary[m.key] ?? 0);
      const c = Number(summary[m.key] ?? 0);
      const delta = round(c - b);
      // 相对劣化：高分指标看比例，低分指标看绝对增量
      const regressed = m.higherBetter
        ? b > 0 && (b - c) / b > thresholds.maxRegression
        : c - b > Math.max(1, b * thresholds.maxRegression);
      baselineDiff.push({ metric: m.label, baseline: b, current: c, delta, worse: regressed && delta !== 0 });
      if (regressed && delta !== 0) {
        violations.push(`相对基线劣化: ${m.label} ${b} → ${c}`);
      }
    }
  }
  return { gate: { pass: violations.length === 0, violations }, baselineDiff };
}

// ---------------------------------------------------------------- 主入口

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const mode = options.mode ?? "deterministic";
  const k = Math.max(1, options.k ?? 1);
  const root = options.root ?? PROJECT_ROOT;
  const providerName = options.providerName ?? (mode === "live" ? "openai" : "mock");
  const thresholds: EvalThresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const runs: EvalRunMetrics[] = [];
  let skipped = 0;
  // 逐任务累加推理效率指标（每个任务重建 AgentOS，需手动求和）
  let inference = EMPTY_STATS;

  const active = options.tasks.filter((t) =>
    !(mode === "live" && t.deterministicOnly) && !(mode === "deterministic" && t.liveOnly));
  skipped = options.tasks.length - active.length;

  for (const task of active) {
    for (let repeat = 0; repeat < k; repeat += 1) {
      const tmp = mkdtempSync(join(tmpdir(), "agentos-eval-"));
      const workspace = join(tmp, "ws");
      mkdirSync(workspace, { recursive: true });
      let os: AgentOS | undefined;
      try {
        await options.prepareWorkspace?.(task, workspace);
        os = createAgentOS({
          root,
          autoApprove: task.fault !== "approval-deny",
          plugins: [],
          // 默认隔离：验证器不能被 evolve 写回的配置反作用；benchmark 显式开启。
          evolvedState: options.useEvolvedState === true,
          ...(mode === "deterministic" && task.script ? { mockScript: task.script } : {}),
          config: mergeConfigForEval(faultConfig(task, tmp), options.configOverride),
        });
        if (mode === "live") {
          os.router.setDefault(providerName);
          os.router.setStrict(true); // 禁止静默降级到 Mock，否则评测结果失真
        }
        if (task.fault === "approval-deny") {
          os.approvals.onRequest((req) => { os?.approvals.resolve(req.id, ApprovalDecision.Deny); });
        }
        const r = await runOne(os, task, workspace, repeat);
        if (options.verifyWorkspace) {
          try {
            const extra = await options.verifyWorkspace(task, workspace);
            if (extra.length > 0) {
              r.reasons.push(...extra);
              r.ok = false;
            }
          } catch (err) {
            r.reasons.push(`隐藏验收执行失败: ${err instanceof Error ? err.message : String(err)}`);
            r.ok = false;
          }
        }
        runs.push(r);
        const s = os.router.inferenceStats();
        inference = {
          remoteCalls: inference.remoteCalls + s.remoteCalls,
          localCalls: inference.localCalls + s.localCalls,
          cacheHits: inference.cacheHits + s.cacheHits,
          remoteAvoided: inference.remoteAvoided + s.remoteAvoided,
          remoteCallRatio: 0,
        };
        options.onProgress?.(
          `  ${r.ok ? "✓" : "✗"} ${task.id.padEnd(8)} [${task.category.padEnd(11)}] ` +
            `${r.steps}步/${r.toolCalls}工具/${r.latencyMs}ms ${r.ok ? "" : `→ ${r.reasons.join("; ")}`}`,
        );
      } catch (err) {
        // 环境准备/执行抛错：记为该任务失败，不让整轮评测崩掉（否则一个坏 fixture 会掩盖其余全部结果）
        const msg = err instanceof Error ? err.message : String(err);
        const r = emptyRun(task, repeat, [`评测环境异常: ${msg}`]);
        runs.push(r);
        options.onProgress?.(`  ✗ ${task.id.padEnd(8)} [${task.category.padEnd(11)}] → ${msg}`);
      } finally {
        if (os) await os.shutdown();
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  const summary = summarize(active, runs, k, skipped);
  const taskSetHash = createHash("sha1").update(JSON.stringify(options.tasks)).digest("hex").slice(0, 12);
  const rawBaseline = options.baseline ?? null;
  const baseline = rawBaseline && rawBaseline.taskSetHash === taskSetHash ? rawBaseline : null;
  const { gate, baselineDiff } = gateAndDiff(summary, thresholds, baseline);
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    mode,
    providerName,
    k,
    strict: mode === "live",
    usedEvolvedState: options.useEvolvedState === true,
    taskSetHash,
    baselineSkipped: rawBaseline !== null && baseline === null,
    runs,
    summary,
    gate,
    baselineDiff,
    inference: {
      ...inference,
      remoteCallRatio:
        inference.remoteCalls + inference.localCalls + inference.cacheHits > 0
          ? round(inference.remoteCalls / (inference.remoteCalls + inference.localCalls + inference.cacheHits), 3)
          : 0,
    },
  };
}

export function loadTasks(path: string): EvalTask[] {
  if (!existsSync(path)) throw new Error(`评测任务集不存在: ${path}`);
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("#"))
    .map((l) => JSON.parse(l) as EvalTask);
}

export function saveReport(path: string, report: EvalReport): void {
  writeFileSync(path, JSON.stringify(report, null, 2));
}

export function loadBaseline(path: string): EvalReport | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EvalReport;
  } catch {
    return null;
  }
}

export function formatReport(report: EvalReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push("=".repeat(84));
  lines.push(`  bro2 能力评测报告   mode=${report.mode}  provider=${report.providerName}  k=${report.k}  strict=${report.strict}`);
  lines.push("=".repeat(84));
  lines.push("");
  lines.push("  【分类得分】");
  for (const [cat, score] of Object.entries(s.byCategory)) {
    const bar = "█".repeat(Math.round(score * 20)).padEnd(20, "·");
    lines.push(`   ${cat.padEnd(12)} ${bar} ${(score * 100).toFixed(1)}%`);
  }
  lines.push("");
  lines.push("  【核心指标】");
  const metrics: Array<[string, string]> = [
    ["总体得分 / pass@k", `${(s.overall * 100).toFixed(1)}%  /  ${(s.passAtK * 100).toFixed(1)}%`],
    ["通过任务", `${s.passed} / ${s.total}${s.skipped ? `（live 跳过 ${s.skipped} 项脚本化用例）` : ""}`],
    ["平均步数 / 工具调用", `${s.avgSteps}  /  ${s.avgToolCalls}`],
    ["平均延迟 / 总 token", `${s.avgLatencyMs} ms  /  ${s.totalTokens}`],
    ["工具错误率 / Guard 触发率", `${(s.toolErrorRate * 100).toFixed(1)}%  /  ${(s.guardRate * 100).toFixed(1)}%`],
    ["协议违规（未配对 tool_call）", `${s.protocolViolations}  ← 零容忍`],
  ];
  for (const [k, v] of metrics) lines.push(`   ${k.padEnd(30)} ${v}`);
  lines.push("");
  if (report.baselineDiff.length > 0) {
    lines.push("  【相对基线】");
    for (const d of report.baselineDiff) {
      const flag = d.worse ? "⚠ 劣化" : d.delta > 0 ? "↑" : d.delta < 0 ? "↓" : "=";
      lines.push(`   ${d.metric.padEnd(16)} ${String(d.baseline).padStart(8)} → ${String(d.current).padStart(8)}  ${flag}`);
    }
    lines.push("");
  }
  lines.push("  【门禁】" + (report.gate.pass ? "  ✓ PASS" : "  ✗ FAIL"));
  for (const v of report.gate.violations) lines.push(`   - ${v}`);
  const failed = report.runs.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push("");
    lines.push("  【失败明细】");
    for (const r of failed) lines.push(`   ${r.taskId} (#${r.repeat}) ${r.reasons.join("; ")}`);
  }
  lines.push("");
  lines.push("=".repeat(84));
  return lines.join("\n");
}
