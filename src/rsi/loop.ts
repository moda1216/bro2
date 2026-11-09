/**
 * bro2 · 自我改进主循环（L3 能力面 + 受限 L4 元层）
 *
 * 单代流程：
 *   完整性 tripwire → train/holdout 基线评测 → 失败挖掘 → 按先验排序生成单原子候选
 *   → 写保护校验 → 影子 train → 影子 holdout → 单调晋升 / 回滚 → 账本 → 先验更新
 *
 * 晋升判据（全部同时满足）：
 *   train 严格提升 · train 门禁 PASS · holdout 严格提升 · holdout 门禁 PASS
 *   · 协议违规 = 0 · 保护面完整 · patch 在白名单且不在拒绝缓冲 · 漂移未越界
 * 任一不满足即回滚；候选从未接触真实运行时。
 */
import { writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { runEval, loadTasks } from "../observability/eval.ts";
import type { EvalReport, EvalTask, EvalThresholds } from "../observability/eval.ts";
import { judgePromotion } from "../observability/eval-grade.ts";
import { Ledger, IncidentLog, metaPatch, genesisPatch } from "./ledger.ts";
import type { OperatorStats } from "./ledger.ts";
import {
  computeIntegrity, diffIntegrity, checkPatch, extractHoldoutAnswers,
} from "./guardrails.ts";
import { mineFailures } from "./miner.ts";
import {
  proposePatches, applyPatch, noteRejected, updateStrategyWeights,
} from "./operators.ts";
import {
  evolvePaths, loadState, loadStrategy, saveState, saveStrategy,
  makeShadowRoot, freshDefaultState, freshDefaultStrategy, loadMetaState,
} from "./shadow.ts";
import type {
  EvolvableState, EvolutionStrategy, Patch, GenerationRecord,
  EvolveReport, LedgerEntry, MetaState,
} from "./types.ts";
import { shortHash, DEFAULT_META, LEAN_OPERATOR_SET } from "./types.ts";

/**
 * evolve 用相对提升判据，绝对分数下限交给主评测门禁；
 * 但协议违规零容忍与工具错误率上限保持不变，避免"提升"以正确性为代价。
 */
const EVOLVE_THRESHOLDS: EvalThresholds = {
  minOverall: 0,
  minToolUse: 0,
  minSafety: 0,
  minRobustness: 0,
  maxToolErrorRate: 0.35,
  maxProtocolViolations: 0,
  maxAvgSteps: 999,
  maxRegression: 0.08,
};

export interface EvolveOptions {
  root: string;
  /** 只诊断与提议，不写回 state / strategy（仍写账本，保证可审计）。 */
  dryRun?: boolean;
  /** 复位到初始次优状态与初始先验，用于可复现演示。 */
  reset?: boolean;
  generations?: number;
  /** 测试通道：注入候选验证 tripwire（置于候选队列最前）。 */
  injectedPatches?: Patch[];
  /**
   * 改进机制自身的状态（meta RSI）。缺省为 DEFAULT_META，
   * 与未引入元层之前的行为完全一致；元候选在隔离的 scratch 里评估。
   */
  meta?: MetaState;
  /** 账本 / 报告隔离目录，供 meta RSI 影子评测使用，避免污染真实只增账本。 */
  scratchDir?: string;
  onProgress?: (line: string) => void;
}

async function evaluate(root: string, state: EvolvableState, tasks: EvalTask[]): Promise<EvalReport> {
  const shadow = makeShadowRoot(root, state);
  try {
    return await runEval({
      tasks,
      mode: "deterministic",
      k: 1,
      root: shadow,
      baseline: null,
      thresholds: EVOLVE_THRESHOLDS,
    });
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
}

function ledgerBase(
  gen: number,
  parent: string | null,
  patch: Patch,
  stateHash: string,
): Omit<LedgerEntry, "seq" | "ts" | "decision" | "reason" | "gatePass" | "integrityOk"> {
  return {
    generation: gen,
    parent,
    patch,
    trainBefore: 0,
    trainAfter: 0,
    holdoutBefore: 0,
    holdoutAfter: 0,
    protocolViolations: 0,
    stateHash,
  };
}

export async function runEvolve(options: EvolveOptions): Promise<EvolveReport> {
  const root = options.root;
  const paths = evolvePaths(root, options.scratchDir);
  // 已通过冻结 fitness 晋升的元改进会真正作用于下一次 evolve（Imp_t → Imp_{t+1}）；
  // meta RSI 的影子评测显式传入 options.meta 覆盖，保证公平比较。
  const meta = options.meta ?? loadMetaState(root);
  const dryRun = options.dryRun === true;
  const train = loadTasks(paths.train);
  const holdout = loadTasks(paths.holdout);
  const ood = loadTasks(paths.ood);
  const holdoutAnswers = extractHoldoutAnswers(holdout);
  const taskSetHash = shortHash({ train, holdout, ood });
  const baselineIntegrity = computeIntegrity(root);

  let state: EvolvableState = options.reset ? freshDefaultState() : loadState(root);
  let strategy: EvolutionStrategy = options.reset ? freshDefaultStrategy() : loadStrategy(root);
  const ledger = new Ledger(paths.ledger);
  const incidents = new IncidentLog(paths.incidents);
  const incidentsBefore = incidents.count();
  const generations: GenerationRecord[] = [];

  let promoted = 0;
  let rejected = 0;
  let blocked = 0;
  let evalRuns = 0;
  let drift = 0;
  let plateau = 0;
  const trainCurve: number[] = [];
  const holdoutCurve: number[] = [];
  let stoppedBy = "max-generations";

  // 账本写入统一收口到一个 helper（少而精：原散落 6 处 ledger.append 合并，避免重复与漂移）。
  const appendLed = (
    generation: number, patch: Patch, decision: string, reason: string,
    stBefore: EvolvableState, stAfter: EvolvableState, extra: Record<string, unknown> = {},
  ): void => {
    ledger.append({ ...ledgerBase(generation, shortHash(stBefore), patch, shortHash(stAfter)), decision, reason, ...extra });
  };
  // 阶段 C：OOD 退化阻断写入 journal 可复核；与 ledger 同走 scratchDir 隔离，避免污染真实只增账本。
  const journalOodBlock = (reasons: string[]): void => {
    appendFileSync(
      join(paths.dir, "journal.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), id: "W4-C-ood-block", event: "block", reason: reasons.join("; "), segment: "ood" }) + "\n",
    );
  };

  appendLed(0, genesisPatch(), "genesis", `任务集指纹 ${taskSetHash} · 保护面 ${Object.keys(baselineIntegrity).length} 文件`, state, state, { gatePass: true, integrityOk: true });

  const maxGen = options.generations ?? strategy.maxGenerations;
  const say = (line: string): void => options.onProgress?.(line);

  for (let gen = 1; gen <= maxGen; gen += 1) {
    // 本代实证统计：只用于更新搜索先验，保证跨运行可复现（不依赖账本历史累积）
    const genStats: Record<string, OperatorStats> = {};
    const bump = (name: string, key: keyof OperatorStats): void => {
      const s = genStats[name] ?? { promoted: 0, rejected: 0, blocked: 0 };
      s[key] += 1;
      genStats[name] = s;
    };
    // ---- tripwire 0：写保护评测面完整性 ----
    const changed = diffIntegrity(baselineIntegrity, computeIntegrity(root));
    if (changed.length > 0) {
      incidents.append({
        generation: gen,
        severity: "critical",
        kind: "integrity",
        detail: `保护面被修改: ${changed.join(", ")}`,
      });
      stoppedBy = "integrity_violation";
      break;
    }
    if (evalRuns >= strategy.maxEvalRuns) {
      stoppedBy = "eval-budget";
      break;
    }

    // ---- 基线评测（train/holdout/ood 三段分离：holdout 与 ood 内容均不进入 miner）----
    const trainBefore = await evaluate(root, state, train);
    evalRuns += 1;
    const holdoutBefore = await evaluate(root, state, holdout);
    evalRuns += 1;
    const oodBefore = await evaluate(root, state, ood);
    evalRuns += 1;
    trainCurve.push(trainBefore.summary.overall);
    holdoutCurve.push(holdoutBefore.summary.overall);

    const signals = mineFailures(trainBefore, {
      evidenceLimit: meta.evidenceLimit,
      policyRule: meta.policyRule,
    });
    const rec: GenerationRecord = {
      generation: gen,
      signals: signals.map((s) => ({ kind: s.kind, count: s.count, taskIds: s.taskIds })),
      candidates: 0,
      promoted: 0,
      rejected: 0,
      blocked: 0,
      trainBefore: trainBefore.summary.overall,
      trainAfter: trainBefore.summary.overall,
      holdoutBefore: holdoutBefore.summary.overall,
      holdoutAfter: holdoutBefore.summary.overall,
      decision: "",
    };
    say(
      `第 ${gen} 代  train=${trainBefore.summary.overall}  holdout=${holdoutBefore.summary.overall}  ` +
      `失败信号=${signals.length ? signals.map((s) => `${s.kind}×${s.count}`).join(",") : "无"}`,
    );

    if (signals.length === 0) {
      rec.decision = "converged";
      generations.push(rec);
      stoppedBy = "converged";
      break;
    }

    // ---- 提议（单原子编辑 + 编辑预算 + 拒绝缓冲 + 元层搜索策略）----
    const effectiveStrategy: EvolutionStrategy =
      meta.editBudgetAdaptation === "plateau-expand" && plateau > 0
        ? { ...strategy, editBudget: Math.min(5, strategy.editBudget + 2) }
        : strategy;
    const proposed = proposePatches(signals, state, effectiveStrategy, {
      candidateOrder: meta.candidateOrder,
      ...(meta.operatorSet === "lean" ? { operatorSet: LEAN_OPERATOR_SET } : {}),
    });
    const patches: Patch[] = gen === 1 && options.injectedPatches?.length
      ? [...options.injectedPatches, ...proposed]
      : proposed;
    rec.candidates = patches.length;

    let didPromote = false;
    for (const p of patches) {
      if (evalRuns >= strategy.maxEvalRuns) {
        stoppedBy = "eval-budget";
        break;
      }

      const chk = checkPatch(p, {
        state,
        holdoutAnswers,
        rejectedEdits: strategy.rejectedEdits,
        drift,
        maxDrift: strategy.maxDrift,
      });
      if (!chk.ok) {
        blocked += 1;
        rec.blocked += 1;
        bump(p.operator, "blocked");
        incidents.append({
          generation: gen,
          severity: chk.severity,
          kind: "patch_blocked",
          detail: `${p.operator}: ${chk.reason}`,
          ...(p.id ? { patchId: p.id } : {}),
        });
        appendLed(gen, p, "blocked", chk.reason, state, state, { gatePass: false, integrityOk: true });
        say(`  ⊘ 拦截 ${p.operator}: ${chk.reason}`);
        continue;
      }

      const candidateState = applyPatch(state, p);
      const trainAfter = await evaluate(root, candidateState, train);
      evalRuns += 1;

      if (!trainAfter.gate.pass || trainAfter.summary.protocolViolations > 0 ||
          !(trainAfter.summary.overall > trainBefore.summary.overall)) {
        rejected += 1;
        rec.rejected += 1;
        bump(p.operator, "rejected");
        strategy = noteRejected(strategy, p.id);
        const reason = !trainAfter.gate.pass || trainAfter.summary.protocolViolations > 0
          ? "train 门禁失败或存在协议违规" : "train 未提升：改动无法被外部断言验证";
        appendLed(gen, p, "rejected", reason, state, candidateState, {
          trainBefore: trainBefore.summary.overall, trainAfter: trainAfter.summary.overall,
          holdoutBefore: holdoutBefore.summary.overall, gatePass: trainAfter.gate.pass,
          protocolViolations: trainAfter.summary.protocolViolations, integrityOk: true,
        });
        say(`  ✗ 拒绝 ${p.operator}: ${reason}`);
        continue;
      }

      const holdoutAfter = await evaluate(root, candidateState, holdout);
      evalRuns += 1;
      const oodAfter = await evaluate(root, candidateState, ood);
      evalRuns += 1;
      // 阶段 C：用三段晋升铁律（judgePromotion）作为真实晋升闸门——
      // dev 严格提升 · holdout/OOD 不退化 · OOD 完全只读（搜索只碰 dev）· 协议零违规 · 完整性通过。
      const verdict = judgePromotion({
        id: p.id,
        before: { dev: trainBefore.summary.overall, holdout: holdoutBefore.summary.overall, ood: oodBefore.summary.overall },
        after: { dev: trainAfter.summary.overall, holdout: holdoutAfter.summary.overall, ood: oodAfter.summary.overall },
        hashes: {
          dev: [trainBefore.taskSetHash, trainBefore.taskSetHash],
          holdout: [holdoutBefore.taskSetHash, holdoutBefore.taskSetHash],
          ood: [oodBefore.taskSetHash, oodBefore.taskSetHash],
        },
        searchTouchedHashes: [trainBefore.taskSetHash],
        available: { dev: true, holdout: true, ood: true },
        protocolViolationsAfter: trainAfter.summary.protocolViolations,
        integrityOk: changed.length === 0,
        usedGroundTruthVerifier: false,
        tolerance: 0,
      });

      if (verdict.promoted) {
        const parentState = state;
        state = candidateState;
        drift += p.changes.length;
        promoted += 1;
        rec.promoted += 1;
        bump(p.operator, "promoted");
        didPromote = true;
        rec.trainAfter = trainAfter.summary.overall;
        rec.holdoutAfter = holdoutAfter.summary.overall;
        appendLed(gen, p, "promoted",
          `三段晋升 dev Δ=${verdict.deltas.dev.toFixed(4)} holdout Δ=${verdict.deltas.holdout.toFixed(4)} ood Δ=${verdict.deltas.ood.toFixed(4)}`,
          parentState, candidateState, {
            trainBefore: trainBefore.summary.overall, trainAfter: trainAfter.summary.overall,
            holdoutBefore: holdoutBefore.summary.overall, holdoutAfter: holdoutAfter.summary.overall,
            gatePass: true, integrityOk: true,
          });
        if (!dryRun) saveState(root, state);
        say(`  ✓ 晋升 ${p.operator}: ${p.description}  holdout ${holdoutBefore.summary.overall} → ${holdoutAfter.summary.overall}`);
        break; // 每代最多晋升 1 个，保证单调、可归因
      }

      rejected += 1;
      rec.rejected += 1;
      strategy = noteRejected(strategy, p.id);
      if (verdict.blockedByOod) journalOodBlock(verdict.reasons);
      appendLed(gen, p, "rejected", `三段门禁未过：${verdict.reasons.join("；")}`, state, candidateState, {
        trainBefore: trainBefore.summary.overall, trainAfter: trainAfter.summary.overall,
        holdoutBefore: holdoutBefore.summary.overall, holdoutAfter: holdoutAfter.summary.overall,
        gatePass: holdoutAfter.gate.pass, protocolViolations: holdoutAfter.summary.protocolViolations,
        integrityOk: true,
      });
      say(`  ✗ 拒绝 ${p.operator}: ${verdict.reasons[0] ?? "三段门禁未过"}`);
    }

    // ---- 受限 L4：改进机制自身由本代实证成败更新 ----
    strategy = updateStrategyWeights(strategy, genStats);
    appendLed(gen, metaPatch(`meta-${gen}`, "算子先验更新"), "meta", "由账本实证成败更新搜索先验；非能力声明，不参与晋升判定", state, state, { gatePass: true, integrityOk: true });
    if (!dryRun) saveStrategy(root, strategy);

    rec.decision = didPromote ? "promoted" : "no-improvement";
    generations.push(rec);
    plateau = didPromote ? 0 : plateau + 1;
    if (plateau >= meta.plateauPatience) {
      stoppedBy = "plateau";
      break;
    }
    if (stoppedBy === "eval-budget") break;
  }

  const finalChanged = diffIntegrity(baselineIntegrity, computeIntegrity(root));
  const report: EvolveReport = {
    version: 1,
    agent: "bro2",
    timestamp: new Date().toISOString(),
    dryRun,
    level: "L3 + 受限 L4（有界 RSI）",
    taskSetHash,
    integrity: {
      ok: finalChanged.length === 0,
      files: Object.keys(baselineIntegrity).length,
      changed: finalChanged,
    },
    generations,
    promoted,
    rejected,
    blocked,
    incidents: incidents.count() - incidentsBefore,
    evalRuns,
    trainCurve,
    holdoutCurve,
    finalState: state,
    finalStrategy: strategy,
    meta,
    ledgerPath: paths.ledger,
    stoppedBy,
  };
  if (!dryRun) writeFileSync(paths.report, JSON.stringify(report, null, 2));
  return report;
}

export function formatEvolveReport(report: EvolveReport): string {
  const lines: string[] = [];
  const bar = "=".repeat(84);
  lines.push(bar);
  lines.push(
    `  bro2 · 有界可验证自我改进报告   ${report.level}   ` +
    `dryRun=${report.dryRun}   指纹=${report.taskSetHash}`,
  );
  lines.push(bar);
  lines.push("");
  lines.push("  【代数明细】");
  for (const g of report.generations) {
    lines.push(
      `   #${g.generation}  信号 ${g.signals.map((s) => `${s.kind}×${s.count}`).join(",") || "无"}` +
      `   候选 ${g.candidates}  晋升 ${g.promoted}  拒绝 ${g.rejected}  拦截 ${g.blocked}`,
    );
    lines.push(
      `        train ${g.trainBefore} → ${g.trainAfter}   ` +
      `holdout ${g.holdoutBefore} → ${g.holdoutAfter}   ${g.decision}`,
    );
  }
  lines.push("");
  lines.push("  【曲线】");
  lines.push(`   train   ${report.trainCurve.join(" → ") || "（无）"}`);
  lines.push(`   holdout ${report.holdoutCurve.join(" → ") || "（无）"}`);
  lines.push("");
  lines.push("  【治理与防作弊】");
  lines.push(`   保护面完整性  ${report.integrity.ok ? "✓ 未变更" : `✗ 变更: ${report.integrity.changed.join(", ")}`}（${report.integrity.files} 文件）`);
  lines.push(`   本轮晋升 ${report.promoted} · 拒绝 ${report.rejected} · 拦截 ${report.blocked} · 新增 incident ${report.incidents}`);
  lines.push(`   eval 次数 ${report.evalRuns}   停止原因 ${report.stoppedBy}`);
  lines.push("");
  lines.push("  【最终状态与先验（L4 自指证据）】");
  lines.push(`   loopDetectionThreshold = ${report.finalState.budget.loopDetectionThreshold}`);
  lines.push(`   行为策略 ${Object.entries(report.finalState.policy ?? {}).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  const w = report.finalStrategy.operatorWeights;
  lines.push(`   算子权重 ${Object.entries(w).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  lines.push(`   拒绝缓冲 ${report.finalStrategy.rejectedEdits.length} 条`);
  lines.push("");
  lines.push(`   账本 ${report.ledgerPath}`);
  lines.push(bar);
  return lines.join("\n");
}
