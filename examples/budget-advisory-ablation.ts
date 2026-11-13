/**
 * bro2 · 预算软预警 A/B 消融（live 受控对照，v2.31.0）
 *
 * 背景：docs/TRAJECTORY-ANALYSIS.md 的修正记录——v2.30.0 两道失败题的真实机理
 * 是「累计 token 静默熔断发生在产出文件落地之前」，而非「模型空转不肯停」。
 * 本实验检验一个任务无关、不加预算的 harness 改进：硬熔断前注入一次收尾提示。
 *
 * 控制变量：同一模型端点 / 同一 4 个 SOUND 任务 / 同一输入 / 同一公开 verifier /
 * 同一 maxSteps=12 / **同一 maxTokens=60000（不放宽预算）** / 同一 preset 与 policy。
 * 唯一变量：budgetAdvisoryRatio = 0（基线）vs 0.8（预警）。
 *
 * 防过拟合设计：
 *  - design set：`tb-bank-trans-filter`（诊断出问题的样本）；
 *  - holdout（回归）：`tb-analyze-access-logs` / `tb-constraints-scheduling`（v2.30.0 已通过，不参与机制设计）；
 *  - 反证锚点：`tb-assign-seats`（失败源于模型约束求解不全，机制**不该**把它修好；
 *    若意外通过，优先怀疑噪声/泄漏而非宣称增益）。
 *  - 判据在跑之前预注册（PREREGISTERED 常量），含行为对比而非只看分数
 *    （呼应 src/rsi/contrast.ts「自报分数提升但无行为对比 → reward hacking，拒绝」）。
 *
 * 诚实边界：自跑 / 非第三方复核 / 小样本 / 免费匿名端点 / 同集前后对照属弱证据 /
 * 不写 external-results.json / 不改 L4 与 leadership.verdict。
 *
 *   AGENTOS_LIVE_PROVIDER=kilo EXT_K=2 \
 *     node --experimental-strip-types --no-warnings examples/budget-advisory-ablation.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentOS } from "../src/index.ts";
import { faultConfig, mergeConfigForEval } from "../src/observability/eval-grade.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";
import { EventType } from "../src/kernel/events.ts";
import { loadTasks, instructionOf, prepare, runVerifier, MAX_MODEL_CALLS } from "./external-measure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "bench", "external", "budget-advisory-report.json");
const PROVIDER = process.env.TRAJ_PROVIDER ?? "kilo";
const K = Math.max(1, Number(process.env.EXT_K ?? 2));

const ARMS = [
  { id: "A_baseline", label: "v2.30.0 原样（无预算预警）", ratio: 0 },
  { id: "B_advisory", label: "预算软预警 ratio=0.8", ratio: 0.8 },
] as const;

/** 预注册判据（实验运行前固化，不在看结果后调整）。 */
const PREREGISTERED = {
  P1_mechanism: "B 臂出现预算预警事件且 A 臂为 0（机制确实生效）",
  P2_behavior: "B 臂「产出文件未落地」次数 ≤ A 臂（行为对比，不只看分数）",
  P3_result: "B 臂 verifier 通过率 ≥ A 臂，且两个 holdout 通过题不退化",
  acceptance: "仅当 P1∧P2∧P3 全部成立，才称『有初步正向证据』；否则如实判定不成立/无差异",
  counterAnchor: "tb-assign-seats 属模型推理错误，机制不应把它修好；若意外通过需标注为噪声而非增益",
};

interface Trial {
  taskId: string; arm: string; repeat: number;
  verifierPassed: boolean; fileLanded: boolean;
  stoppedBy: string; reason: string; guardKinds: string[];
  budgetAdvisoryFired: boolean; compactions: number; toolErrors: number;
  steps: number; toolCalls: number; tokens: number; latencyMs: number;
  verifierTail: string;
}

async function trial(t: ReturnType<typeof loadTasks>[number], arm: (typeof ARMS)[number], repeat: number): Promise<Trial> {
  const tmp = mkdtempSync(join(tmpdir(), "bro2-abl-"));
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
        { budget: { maxSteps: MAX_MODEL_CALLS, budgetAdvisoryRatio: arm.ratio } } as Partial<RuntimeConfig>,
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
      taskId: t.id, arm: arm.id, repeat,
      verifierPassed: v.passed, fileLanded: !noFile,
      stoppedBy: r.stoppedBy, reason: r.reason, guardKinds,
      budgetAdvisoryFired, compactions, toolErrors,
      steps: r.steps, toolCalls: r.toolCallCount, tokens: r.usage.totalTokens,
      latencyMs: Date.now() - started,
      verifierTail: v.output.slice(-300),
    };
  } finally {
    if (os) await os.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const round = (n: number): number => +n.toFixed(3);
const tasks = loadTasks();
console.log(`预算软预警 A/B 消融 · 端点 ${PROVIDER} · ${tasks.length} 任务 · K=${K} · maxSteps=${MAX_MODEL_CALLS} · maxTokens 不变`);
console.log(`唯一变量：budgetAdvisoryRatio（A=0 / B=0.8）\n`);

const all: Trial[] = [];
for (const arm of ARMS) {
  for (let rep = 0; rep < K; rep += 1) {
    for (const t of tasks) {
      let tr: Trial;
      try {
        tr = await trial(t, arm, rep);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ! ${arm.id} r${rep} ${t.id} → 环境异常: ${msg.slice(0, 120)}`);
        tr = {
          taskId: t.id, arm: arm.id, repeat: rep, verifierPassed: false, fileLanded: false,
          stoppedBy: "exception", reason: msg, guardKinds: [], budgetAdvisoryFired: false,
          compactions: 0, toolErrors: 0, steps: 0, toolCalls: 0, tokens: 0, latencyMs: 0,
          verifierTail: "",
        };
      }
      all.push(tr);
      console.log(`  ${tr.verifierPassed ? "✓" : "✗"} ${arm.id.padEnd(11)} r${rep} ${t.id.padEnd(28)} ` +
        `${tr.steps}步/${tr.toolCalls}工具/${tr.tokens}tok stop=${tr.stoppedBy} ` +
        `adv=${tr.budgetAdvisoryFired ? 1 : 0} file=${tr.fileLanded ? 1 : 0} guards=[${tr.guardKinds.join(",")}]`);
    }
  }
}

const HOLDOUT = ["tb-analyze-access-logs", "tb-constraints-scheduling"];
const DESIGN = "tb-bank-trans-filter";
const COUNTER = "tb-assign-seats";

const armSummary = (id: string) => {
  const xs = all.filter((x) => x.arm === id);
  const n = xs.length || 1;
  return {
    arm: id,
    passRate: round(xs.filter((x) => x.verifierPassed).length / n),
    passes: xs.filter((x) => x.verifierPassed).length, trials: xs.length,
    fileLandingRate: round(xs.filter((x) => x.fileLanded).length / n),
    fileMissing: xs.filter((x) => !x.fileLanded).length,
    budgetAdvisoryFired: xs.filter((x) => x.budgetAdvisoryFired).length,
    tokenGuardCount: xs.filter((x) => x.guardKinds.includes("tokens")).length,
    guardStops: xs.filter((x) => x.stoppedBy === "guard").length,
    avgSteps: round(xs.reduce((a, x) => a + x.steps, 0) / n),
    avgToolCalls: round(xs.reduce((a, x) => a + x.toolCalls, 0) / n),
    avgTokens: round(xs.reduce((a, x) => a + x.tokens, 0) / n),
    holdoutPassRate: round((() => {
      const h = xs.filter((x) => HOLDOUT.includes(x.taskId));
      return h.length ? h.filter((x) => x.verifierPassed).length / h.length : 0;
    })()),
    perTask: tasks.map((t) => {
      const g = xs.filter((x) => x.taskId === t.id);
      return {
        taskId: t.id, passes: g.filter((x) => x.verifierPassed).length, trials: g.length,
        fileLanded: g.filter((x) => x.fileLanded).length,
        advisory: g.filter((x) => x.budgetAdvisoryFired).length,
        stops: [...new Set(g.map((x) => x.stoppedBy))],
      };
    }),
  };
};

const A = armSummary("A_baseline");
const B = armSummary("B_advisory");
const P1 = B.budgetAdvisoryFired > 0 && A.budgetAdvisoryFired === 0;
const P2 = B.fileMissing <= A.fileMissing;
const P3 = B.passRate >= A.passRate && B.holdoutPassRate >= A.holdoutPassRate;
const verdict = P1 && P2 && P3 ? "初步正向证据（严格限于本样本）" : "判据未全成立／无差异（如实记录，不宣称增益）";

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  kind: "budget-advisory-ablation",
  sourceFinding: "docs/TRAJECTORY-ANALYSIS.md §4 修正：失败主因是累计 token 静默熔断早于产出落地，而非空转不停",
  control: {
    provider: PROVIDER, keyless: true, k: K, taskIds: tasks.map((t) => t.id),
    maxSteps: MAX_MODEL_CALLS, maxTokensUnchanged: 60000,
    sameInputs: true, sameVerifier: true, samePreset: "standard", samePolicy: "DEFAULT_POLICY",
    onlyVariable: "budget.budgetAdvisoryRatio (A=0 / B=0.8)",
  },
  preregistered: PREREGISTERED,
  sets: { design: DESIGN, holdout: HOLDOUT, counterAnchor: COUNTER },
  arms: [A, B],
  criteria: { P1_mechanism: P1, P2_behavior: P2, P3_result: P3 },
  verdict,
  trials: all,
  honest: {
    selfRun: true, thirdPartyVerified: false,
    limitations: [
      "小样本（4 任务、K=" + K + "）、免费匿名端点、单次结果随机性大（诊断中同题两次跑机理不同）",
      "同集前后对照属弱证据，可能过拟合；不宣称泛化能力提升",
      "未写 data/benchmark/external-results.json，不改 L4 与 leadership.verdict",
      "预算未放宽（maxTokens 保持 60000），增益不得归因于加资源",
      "bro2 自跑、非第三方复核；公开 verifier 为上游 pytest，healthy 已双向验证",
    ],
  },
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nA: pass=${A.passes}/${A.trials} fileMissing=${A.fileMissing} adv=${A.budgetAdvisoryFired} tokenGuard=${A.tokenGuardCount} holdout=${A.holdoutPassRate}`);
console.log(`B: pass=${B.passes}/${B.trials} fileMissing=${B.fileMissing} adv=${B.budgetAdvisoryFired} tokenGuard=${B.tokenGuardCount} holdout=${B.holdoutPassRate}`);
console.log(`P1=${P1} P2=${P2} P3=${P3} → ${verdict}`);
console.log(`报告：${OUT}`);
