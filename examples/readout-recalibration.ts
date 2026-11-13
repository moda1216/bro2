/**
 * bro2 · 测量预算口径读数修正 + 更大 K 机制复验（v2.32.0）
 *
 * 承接 v2.31.0 结尾的「下一步 1 / 2」：
 *  1) 读数修正：v2.30/2.31 测量脚本只声明 maxSteps=12，maxTokens 靠配置默认 60000
 *     静默累计熔断（实测 6~9 步即触发），步数预算形同虚设、读数口径未声明 → 读数失真。
 *     本实验把两套「成套预算口径」并列、同批测量，量化接线对读数的影响。
 *  2) 机制复验：在**校准后的公平口径**下、用更大 K（默认 3 > 上轮 2）复验预算软预警
 *     候选机制（v2.31.0 默认关闭），沿用其预注册判据 P1/P2/P3 + holdout + 反证锚点。
 *
 * 三组，唯一变量分层：
 *   L_legacy     : {maxSteps:12, maxTokens:60000}  advisory=0   → 旧读数口径复现
 *   C_calibrated : {maxSteps:12, maxTokens:120000} advisory=0   → 校准读数 + 机制对照
 *   A_advisory   : {maxSteps:12, maxTokens:120000} advisory=0.8 → 公平口径机制复验
 *   L vs C = 读数修正（归因 measurement-wiring，不计能力）；C vs A = 机制（唯一变量 advisory）。
 *
 * 120000 = 12 步 × 10000 token/步；10000 源自 v2.31.0 实测 16 次运行约 10280 token/步
 * （token 中位数 56540 / 中位步数 5.5），非拍脑袋放大、不针对任何具体任务。
 *
 * 诚实边界：bro2 自跑 / 非第三方复核 / 小样本 / 免费匿名端点 / 不写 external-results.json /
 * 不改 L4 与 leadership.verdict / 通过率差不归因于能力优化。
 *
 *   TRAJ_PROVIDER=kilo EXT_K=3 \
 *     node --experimental-strip-types --no-warnings examples/readout-recalibration.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentOS } from "../src/index.ts";
import { faultConfig, mergeConfigForEval } from "../src/observability/eval-grade.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";
import { EventType } from "../src/kernel/events.ts";
import { loadTasks, instructionOf, prepare, runVerifier, MAX_MODEL_CALLS, fingerprint } from "./external-measure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "data", "bench", "external");
const OUT = join(EXT, "readout-recalibration-report.json");
const EXTERNAL_RESULTS = join(ROOT, "data", "benchmark", "external-results.json");
const PROVIDER = process.env.TRAJ_PROVIDER ?? "kilo";
const K = Math.max(1, Number(process.env.EXT_K ?? 3));

// ---- 成套预算口径（显式、可复核、非针对具体任务） ----
const MAX_STEPS = MAX_MODEL_CALLS;                       // 12
const LEGACY_MAX_TOKENS = 60000;                         // v2.30/2.31 实际生效的配置默认值
const PER_STEP_TOKEN_ALLOWANCE = 10000;                  // v2.31.0 实测依据 ~10280 token/步
const CALIBRATED_MAX_TOKENS = MAX_STEPS * PER_STEP_TOKEN_ALLOWANCE; // 120000，让 12 步真正可用

const GROUPS = [
  { id: "L_legacy", maxTokens: LEGACY_MAX_TOKENS, advisory: 0, role: "旧读数口径复现（token 静默熔断）" },
  { id: "C_calibrated", maxTokens: CALIBRATED_MAX_TOKENS, advisory: 0, role: "校准读数 + 机制对照组" },
  { id: "A_advisory", maxTokens: CALIBRATED_MAX_TOKENS, advisory: 0.8, role: "公平口径下软预警复验" },
] as const;

/** 预注册判据（实验运行前固化，不在看结果后调整）。 */
const PREREGISTERED = {
  R1_wiringDistortion: "L 组出现 guard(tokens) 且这些 trial 的 steps < maxSteps（步数预算未成为约束，读数口径失真被证实）",
  R2_recalibration: "C 组 guard(tokens) 次数 < L 组（成套校准后累计 token 不再是隐藏 binding constraint）",
  R3_attribution: "L→C 读数差只标为 measurement-wiring，不计能力；不写 external-results.json、不改 L4/verdict",
  P1_mechanism: "A 组出现预算预警事件且 C 组为 0（机制确实生效）",
  P2_behavior: "A 组「产出文件未落地」次数 ≤ C 组（行为对比，不只看分数）",
  P3_result: "A 组 verifier 通过率 ≥ C 组，且两个 holdout 通过题不退化",
  acceptance_readout: "R1∧R2 成立才称『读数失真实证成立』；差异一律归因测量接线，不归因能力",
  acceptance_mechanism: "仅当 P1∧P2∧P3 全成立，才称『公平口径下有初步正向证据』；否则如实判定不成立/无差异",
  counterAnchor: "tb-assign-seats 属模型推理错误，机制不应把它修好；若意外通过需标注为噪声而非增益",
};

interface Trial {
  group: string; taskId: string; repeat: number;
  maxTokens: number; advisory: number;
  verifierPassed: boolean; fileLanded: boolean;
  stoppedBy: string; reason: string; guardKinds: string[];
  budgetAdvisoryFired: boolean; compactions: number; toolErrors: number;
  steps: number; toolCalls: number; tokens: number; latencyMs: number;
  verifierTail: string;
}

async function trial(t: ReturnType<typeof loadTasks>[number], g: (typeof GROUPS)[number], repeat: number): Promise<Trial> {
  const tmp = mkdtempSync(join(tmpdir(), "bro2-recal-"));
  const ws = join(tmp, "ws");
  mkdirSync(ws, { recursive: true });
  let os: ReturnType<typeof createAgentOS> | undefined;
  const started = Date.now();
  try {
    prepare(t, ws);
    const input = instructionOf(t);
    os = createAgentOS({
      root: ROOT, autoApprove: true, plugins: [], evolvedState: false,
      config: mergeConfigForEval(
        faultConfig({ id: t.id, category: t.category, input }, tmp),
        { budget: {
          maxSteps: MAX_STEPS, maxTokens: g.maxTokens, budgetAdvisoryRatio: g.advisory,
        } } as Partial<RuntimeConfig>,
      ),
    });
    os.router.setDefault(PROVIDER);
    os.router.setStrict(true);
    const s = os.createSession("standard");
    const r = await os.run(s.id, input);
    const v = runVerifier(t, ws);
    const events = s.trajectory.events();
    const guardKinds = events
      .filter((e) => e.type === EventType.Guard)
      .map((e) => String((e.payload as Record<string, unknown>).kind ?? "unknown"));
    const toolErrors = events.filter((e) => {
      if (e.type !== EventType.ToolResult) return false;
      const rr = (e.payload as { result?: { ok?: boolean } }).result;
      return rr?.ok === false;
    }).length;
    const compactions = events.filter((e) => e.type === EventType.Compaction).length;
    const budgetAdvisoryFired = events.some((e) => e.type === EventType.BudgetAdvisory);
    const noFile = /does not exist|FileNotFoundError|No such file or directory/i.test(v.output);
    return {
      group: g.id, taskId: t.id, repeat, maxTokens: g.maxTokens, advisory: g.advisory,
      verifierPassed: v.passed, fileLanded: !noFile,
      stoppedBy: r.stoppedBy, reason: r.reason, guardKinds,
      budgetAdvisoryFired, compactions, toolErrors,
      steps: r.steps, toolCalls: r.toolCallCount, tokens: r.usage.totalTokens,
      latencyMs: Date.now() - started, verifierTail: v.output.slice(-300),
    };
  } finally {
    if (os) await os.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const round = (n: number): number => +n.toFixed(3);
const tasks = loadTasks();
const extBefore = fingerprint(EXTERNAL_RESULTS);
console.log(`读数修正 + 大K机制复验 · 端点 ${PROVIDER} · ${tasks.length} 任务 · K=${K} · ${GROUPS.length} 组 = ${tasks.length * K * GROUPS.length} 次`);
console.log(`口径: legacy maxTokens=${LEGACY_MAX_TOKENS} / calibrated maxTokens=${CALIBRATED_MAX_TOKENS} (=${MAX_STEPS}×${PER_STEP_TOKEN_ALLOWANCE}) · maxSteps=${MAX_STEPS}`);
console.log(`L vs C = 读数修正(归因 measurement-wiring) | C vs A = 软预警机制复验(唯一变量 advisory)\n`);

const all: Trial[] = [];
for (const g of GROUPS) {
  console.log(`── 组 ${g.id} · ${g.role} ──`);
  for (let rep = 0; rep < K; rep += 1) {
    for (const t of tasks) {
      let tr: Trial;
      try {
        tr = await trial(t, g, rep);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ! ${g.id} r${rep} ${t.id} → 环境异常: ${msg.slice(0, 120)}`);
        tr = {
          group: g.id, taskId: t.id, repeat: rep, maxTokens: g.maxTokens, advisory: g.advisory,
          verifierPassed: false, fileLanded: false, stoppedBy: "exception", reason: msg,
          guardKinds: [], budgetAdvisoryFired: false, compactions: 0, toolErrors: 0,
          steps: 0, toolCalls: 0, tokens: 0, latencyMs: 0, verifierTail: "",
        };
      }
      all.push(tr);
      console.log(`  ${tr.verifierPassed ? "✓" : "✗"} ${g.id.padEnd(13)} r${rep} ${t.id.padEnd(28)} ` +
        `${tr.steps}步/${tr.toolCalls}工具/${tr.tokens}tok stop=${tr.stoppedBy} ` +
        `guards=[${tr.guardKinds.join(",")}] adv=${tr.budgetAdvisoryFired ? 1 : 0} file=${tr.fileLanded ? 1 : 0}`);
    }
  }
}

const HOLDOUT = ["tb-analyze-access-logs", "tb-constraints-scheduling"];
const DESIGN = "tb-bank-trans-filter";
const COUNTER = "tb-assign-seats";

const stopDist = (xs: Trial[]): Record<string, number> => {
  const d: Record<string, number> = {};
  for (const x of xs) d[x.stoppedBy] = (d[x.stoppedBy] ?? 0) + 1;
  return d;
};
const groupSummary = (id: string) => {
  const xs = all.filter((x) => x.group === id);
  const n = xs.length || 1;
  const h = xs.filter((x) => HOLDOUT.includes(x.taskId));
  return {
    group: id,
    budget: { maxSteps: MAX_STEPS, maxTokens: xs[0]?.maxTokens, advisory: xs[0]?.advisory },
    passRate: round(xs.filter((x) => x.verifierPassed).length / n),
    passes: xs.filter((x) => x.verifierPassed).length, trials: xs.length,
    fileMissing: xs.filter((x) => !x.fileLanded).length,
    budgetAdvisoryFired: xs.filter((x) => x.budgetAdvisoryFired).length,
    tokenGuardCount: xs.filter((x) => x.guardKinds.includes("tokens")).length,
    stepsGuardCount: xs.filter((x) => x.guardKinds.includes("steps")).length,
    completedStops: xs.filter((x) => x.stoppedBy === "completed").length,
    tokenGuardTrialsBelowStepBudget: xs.filter((x) => x.guardKinds.includes("tokens") && x.steps < MAX_STEPS).length,
    exceptionCount: xs.filter((x) => x.stoppedBy === "exception").length,
    avgSteps: round(xs.reduce((a, x) => a + x.steps, 0) / n),
    avgToolCalls: round(xs.reduce((a, x) => a + x.toolCalls, 0) / n),
    avgTokens: round(xs.reduce((a, x) => a + x.tokens, 0) / n),
    stopDistribution: stopDist(xs),
    holdoutPassRate: round(h.length ? h.filter((x) => x.verifierPassed).length / h.length : 0),
    perTask: tasks.map((t) => {
      const g2 = xs.filter((x) => x.taskId === t.id);
      return {
        taskId: t.id, passes: g2.filter((x) => x.verifierPassed).length, trials: g2.length,
        fileLanded: g2.filter((x) => x.fileLanded).length,
        advisory: g2.filter((x) => x.budgetAdvisoryFired).length,
        tokenGuard: g2.filter((x) => x.guardKinds.includes("tokens")).length,
        stops: [...new Set(g2.map((x) => x.stoppedBy))],
      };
    }),
  };
};

const L = groupSummary("L_legacy");
const C = groupSummary("C_calibrated");
const A = groupSummary("A_advisory");

// ---- 读数修正判据（跑之前固化） ----
const R1 = L.tokenGuardTrialsBelowStepBudget > 0;
const R2 = C.tokenGuardCount < L.tokenGuardCount;
const R3 = extBefore === fingerprint(EXTERNAL_RESULTS); // 归因锁：external-results 未被触碰
const readoutVerdict = R1 && R2
  ? "读数失真实证成立：旧口径读数受累计 token 静默熔断污染；成套校准后步数预算真正生效。读数差归因测量接线，不计能力。"
  : R1
    ? "旧口径读数失真实证成立，但校准未减少 token 熔断（如实记录，不外推）。"
    : "本批未复现旧口径的 token 提前熔断（免费端点噪声），读数失真实证不成立（如实记录）。";

// ---- 机制复验判据（沿用 v2.31.0 冻结口径） ----
const P1 = A.budgetAdvisoryFired > 0 && C.budgetAdvisoryFired === 0;
const P2 = A.fileMissing <= C.fileMissing;
const P3 = A.passRate >= C.passRate && A.holdoutPassRate >= C.holdoutPassRate;
const mechanismVerdict = P1 && P2 && P3
  ? "公平口径下有初步正向证据（严格限于本样本、更大 K 仍属小样本）"
  : "判据未全成立／无差异（如实记录，不宣称增益）";

// ---- 诚实二次判读（只增层，不改预注册判据）----
// 预注册判据「机械成立」≠ 机制有效。效应量必须排除噪声解释才可作数：
//   A−C 的通过差若 ≤ C 组独有的 provider_error 次数，则差异可完全由端点噪声解释；
//   且软预警若在 A 组几乎不触发（≤1 次），机制根本未被充分检验。
// 呼应 src/rsi/contrast.ts「自报分数提升但无行为/效应支撑 → reward hacking，拒绝」。
const cProviderErr = (C.stopDistribution as Record<string, number>)["provider_error"] ?? 0;
const aProviderErr = (A.stopDistribution as Record<string, number>)["provider_error"] ?? 0;
const deltaTrialWins = A.passes - C.passes;
const advisoryFiredTrials = A.budgetAdvisoryFired;
const noiseExplainable = deltaTrialWins > 0 && deltaTrialWins <= (cProviderErr - aProviderErr);
const mechanismUnderTested = advisoryFiredTrials <= 1;
const evidenceInsufficient = noiseExplainable || mechanismUnderTested;
const honestReappraisal = {
  preregisteredVerdict: mechanismVerdict,
  deltaTrialWins, cProviderErrors: cProviderErr, aProviderErrors: aProviderErr,
  advisoryFiredTrials, advisoryArmTrials: A.trials,
  noiseExplainable, mechanismUnderTested, evidenceInsufficient,
  conclusion: evidenceInsufficient
    ? `判据 P1∧P2∧P3 机械全绿，但 A−C 通过差仅 ${deltaTrialWins} 个 trial、可被 C 组独有的 ${cProviderErr} 次 provider_error 端点噪声完全解释；且软预警在 A 组 ${A.trials} 次运行里仅触发 ${advisoryFiredTrials} 次，机制几乎未被检验。据此判定「证据不足（噪声主导）」，不构成机制有效的可靠证据：维持默认关闭、不据此开启、不改 L4/verdict。`
    : "效应量超出可解释噪声，机制信号值得进一步复验（仍属小样本）。",
  discipline: "预注册判据结果原样保留（不事后改判据），本段为只增的二次判读层；反证锚点 assign-seats 三组全 fail，确认无答案泄漏。",
};

const report = {
  version: 2,
  generatedAt: new Date().toISOString(),
  kind: "readout-recalibration-and-mechanism-retest",
  sourceFindings: [
    "v2.30.0/TB 对照与 v2.31.0 A/B 的测量脚本只覆盖 maxSteps=12，maxTokens 靠配置默认 60000 静默累计熔断",
    "v2.31.0 实测 16 次运行 token 中位数 56540、最大 75138、5/16 触发 guard(tokens)、最高仅 9 步：步数预算形同虚设",
    "v2.31.0 A/B 为负结果；本轮在成套校准口径 + K=3 下复验软预警候选机制（默认关闭）",
  ],
  control: {
    provider: PROVIDER, keyless: true, k: K, taskIds: tasks.map((t) => t.id),
    maxSteps: MAX_STEPS, sameInputs: true, sameVerifier: true,
    samePreset: "standard", samePolicy: "DEFAULT_POLICY",
    groups: GROUPS.map((g) => ({ id: g.id, maxTokens: g.maxTokens, advisory: g.advisory, role: g.role })),
    design: "L vs C 唯一变量 = 成套预算口径；C vs A 唯一变量 = budgetAdvisoryRatio",
  },
  budgetWiring: {
    legacy: { maxSteps: MAX_STEPS, maxTokens: LEGACY_MAX_TOKENS, effectiveBindingConstraint: "cumulative-tokens(60000)", declaredInReport: false },
    calibrated: { maxSteps: MAX_STEPS, maxTokens: CALIBRATED_MAX_TOKENS, effectiveBindingConstraint: "steps(12) or natural-completion", declaredInReport: true },
    derivation: `CALIBRATED_MAX_TOKENS = maxSteps(${MAX_STEPS}) × perStepAllowance(${PER_STEP_TOKEN_ALLOWANCE})；perStepAllowance 源自 v2.31.0 实测约 10280 token/步，非放大、不针对具体任务`,
    attribution: "measurement-wiring-not-capability",
    comparableAsCapabilityDelta: false,
  },
  preregistered: PREREGISTERED,
  sets: { design: DESIGN, holdout: HOLDOUT, counterAnchor: COUNTER },
  groups: [L, C, A],
  readout: {
    R1_wiringDistortion: R1, R2_recalibration: R2, R3_attribution: R3,
    legacyPassRate: L.passRate, calibratedPassRate: C.passRate,
    readoutDelta: round(C.passRate - L.passRate),
    attribution: "measurement-wiring-not-capability",
    verdict: readoutVerdict,
  },
  mechanism: {
    P1_mechanism: P1, P2_behavior: P2, P3_result: P3,
    calibratedBaselinePassRate: C.passRate, advisoryPassRate: A.passRate,
    holdout: { baseline: C.holdoutPassRate, advisory: A.holdoutPassRate },
    counterAnchor: { taskId: COUNTER, baselinePasses: C.perTask.find((x) => x.taskId === COUNTER)?.passes, advisoryPasses: A.perTask.find((x) => x.taskId === COUNTER)?.passes },
    verdict: mechanismVerdict,
    honestReappraisal,
  },
  verifierSanity: {
    status: "4/4 SOUND（沿用 v2.30.0 双向验证：空工作区 fail / 官方 oracle 解 pass）",
    reference: "data/bench/external/tb-leaderboard-compare-report.json · verifierSanity",
  },
  honest: {
    selfRun: true, thirdPartyVerified: false,
    limitations: [
      `小样本（4 任务、每组 K=${K}、共 ${all.length} 次）、免费匿名端点（kilo 路由模型不固定）、单次随机性大`,
      "读数修正前后通过率差归因于『测量预算接线成套化』，不是 bro2 能力变化；不写 external-results.json、不改 L4/verdict",
      "校准口径提高了 maxTokens 上限（60000→120000），这是修尺子不是加资源刷分；差异不得包装成能力优化",
      "机制复验为同集前后对照，属弱证据；软预警仍默认关闭，不因本轮改变默认行为",
      "bro2 自跑、非第三方复核；公开 verifier 为上游 pytest，healthy 已双向验证",
    ],
  },
  trials: all,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nL(legacy):     pass=${L.passes}/${L.trials} tokenGuard=${L.tokenGuardCount} stop=${JSON.stringify(L.stopDistribution)}`);
console.log(`C(calibrated): pass=${C.passes}/${C.trials} tokenGuard=${C.tokenGuardCount} stop=${JSON.stringify(C.stopDistribution)}`);
console.log(`A(advisory):   pass=${A.passes}/${A.trials} tokenGuard=${A.tokenGuardCount} adv=${A.budgetAdvisoryFired} stop=${JSON.stringify(A.stopDistribution)}`);
console.log(`读数: R1=${R1} R2=${R2} R3=${R3} Δ=${report.readout.readoutDelta} → ${readoutVerdict}`);
console.log(`机制: P1=${P1} P2=${P2} P3=${P3} → ${mechanismVerdict}`);
if (!R3) console.log("⚠ 防自指违规：external-results.json 被改动");
console.log(`报告：${OUT}`);
