/**
 * bro2 · 跨 holdout 模型有效复测（v2.29.0 / P0-04 收口尝试）
 *
 * 在**第二个、不同模型族**的免 Key 端点（ovhcloud / gpt-oss-120b，与 kilo 的 nemotron 不同族）
 * 上重跑 bro2 完整 harness vs minimal scaffold，检查 Δ 是否跨模型稳定。
 *
 * 诚实前提（写进报告）：
 *  - ovhcloud 免 Key 但**限流约 3 次/窗口**，多步 harness 跑分极易撞限流 → 故本脚本在每轮 trial 之间
 *    插入固定冷却（默认 30s）以尊重限流；若仍被 429 拖垮，属**端点稳定性问题，非 Δ 消失**，
 *    按 CAPABILITY-POSITION §4.2 不触发「降级定位」那一条（降级条件是 Δ≤0 或 holdout 上 Δ 消失）。
 *  - k 默认 1（受限于限流，无法稳定跑 k=3；k=1 仅作「harness 能否驱动第二模型族」的可行性证据，
 *    不构成统计结论，单题权重 33pp）。
 *  - 不写 data/benchmark/external-results.json，不改 L4 / leadership.verdict。
 *
 * 运行（后台）：
 *   EXT_K=1 AGENTOS_LIVE_PROVIDER=ovhcloud npm run cross:model
 */
import { writeFileSync, readFileSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

import { runEval, saveReport } from "../src/observability/eval.ts";
import type { EvalTask } from "../src/observability/eval.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import {
  loadTasks, checkInputs, loadProvider, runMinimal, runVerifier, instructionOf, MAX_MODEL_CALLS,
} from "./external-measure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "data", "bench", "external");
const BRO2_REPORT = join(EXT, "bro2-cross-model-report.json");
const OUT = join(EXT, "cross-model-report.json");
const EXTERNAL_RESULTS = join(ROOT, "data", "benchmark", "external-results.json");

const K = Math.max(1, Number(process.env.EXT_K ?? 1));
const HOLDOUT = process.env.EXT_HOLDOUT ?? "ovhcloud";
const TRIAL_PAUSE_MS = Number(process.env.TRIAL_PAUSE_MS ?? 30000);

interface ExtTask { id: string; dir: string; category: EvalTask["category"]; difficulty: string; instruction: string; inputs: Array<{ from: string; to: string }>; verifier: string; verifierSha256: string; oracle: string; artifact: string }
interface VerifyResult { passed: boolean; exitCode: number; output: string }
interface ArmTrial { verifierPassed: boolean; verifierExitCode: number; verifierOutput: string; steps: number; toolCalls: number; latencyMs: number; reasons: string[]; finalAnswer?: string; error?: string; modelCalls?: number }

const byId = (tasks: ExtTask[]) => new Map(tasks.map((t) => [t.id, t]));
const tail = (s: string, n: number): string => s.slice(-n);
const fingerprint = (p: string): string => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "ABSENT");

async function main(): Promise<void> {
  const tasks = loadTasks() as ExtTask[];
  checkInputs(tasks);
  const idMap = byId(tasks);
  const extBefore = fingerprint(EXTERNAL_RESULTS);

  console.log("=".repeat(84));
  console.log(`  bro2 · 跨 holdout 模型有效复测 · holdout=${HOLDOUT} · k=${K} · 冷却=${TRIAL_PAUSE_MS}ms`);
  console.log("=".repeat(84));

  // 评分器健全性（模型无关，复用 external-measure 的 sanity 已证明 sound；这里只跑一次确认）
  const { sanity } = await import("./external-measure.ts");
  const sanityResults = tasks.map((t) => sanity(t));
  if (sanityResults.some((r) => !r.sound)) throw new Error("评分器健全性失败，拒绝出报告");

  const evalTasks: EvalTask[] = tasks.map((t) => ({ id: t.id, category: t.category, input: instructionOf(t) }));

  // bro2 × K
  const bro2ByTask = new Map<string, { passes: number; trials: number; runs: ArmTrial[] }>();
  for (let r = 0; r < K; r += 1) {
    let verifyLog: VerifyResult[] = [];
    const report = await runEval({
      tasks: evalTasks, mode: "live", providerName: HOLDOUT, k: 1, root: ROOT,
      configOverride: { budget: { maxSteps: MAX_MODEL_CALLS } } as Partial<RuntimeConfig>,
      prepareWorkspace: (task, ws) => {
        const t = idMap.get(task.id)!;
        for (const f of t.inputs) { const dst = join(ws, f.to); mkdirSync(dirname(dst), { recursive: true }); cpSync(join(EXT, "upstream", t.dir, f.from), dst, { recursive: true }); }
      },
      verifyWorkspace: (task, ws) => {
        const v = runVerifier(idMap.get(task.id)!, ws);
        verifyLog.push(v);
        return v.passed ? [] : [`holdout verifier 未通过（exit=${v.exitCode}）：${tail(v.output, 400)}`];
      },
      onProgress: (l) => console.log(l),
    });
    saveReport(BRO2_REPORT, report);
    report.runs.forEach((run, i) => {
      const v = verifyLog[i]!;
      const e = bro2ByTask.get(run.taskId) ?? { passes: 0, trials: 0, runs: [] as ArmTrial[] };
      e.trials += 1; if (v.passed) e.passes += 1;
      e.runs.push({ verifierPassed: v.passed, verifierExitCode: v.exitCode, verifierOutput: tail(v.output, 800), steps: run.steps, toolCalls: run.toolCalls, latencyMs: run.latencyMs, reasons: run.reasons });
      bro2ByTask.set(run.taskId, e);
    });
    if (r < K - 1) await sleep(TRIAL_PAUSE_MS);
  }

  // minimal × K
  const { provider, model, endpoint } = loadProvider(HOLDOUT);
  const minByTask = new Map<string, { passes: number; trials: number; runs: ArmTrial[] }>();
  for (let r = 0; r < K; r += 1) {
    for (const t of tasks) {
      await sleep(TRIAL_PAUSE_MS / 2);
      const m = await runMinimal(t, provider as OpenAICompatProvider);
      const e = minByTask.get(t.id) ?? { passes: 0, trials: 0, runs: [] as ArmTrial[] };
      e.trials += 1; if (m.verifierPassed) e.passes += 1; e.runs.push(m);
      minByTask.set(t.id, e);
    }
  }

  const brep = (id: string) => { const e = bro2ByTask.get(id)!; return { taskId: id, passes: e.passes, trials: e.trials, passRate: e.passes / e.trials, runs: e.runs }; };
  const mrep = (id: string) => { const e = minByTask.get(id)!; return { taskId: id, passes: e.passes, trials: e.trials, passRate: e.passes / e.trials, runs: e.runs }; };
  const bro2Passed = tasks.reduce((a, t) => a + brep(t.id).passes, 0);
  const minPassed = tasks.reduce((a, t) => a + mrep(t.id).passes, 0);
  const trials = tasks.length * K;
  const delta = bro2Passed - minPassed;

  const out = {
    kind: "cross-model-retest",
    version: 1,
    timestamp: new Date().toISOString(),
    holdoutProvider: HOLDOUT, model, endpoint, k: K, maxModelCalls: MAX_MODEL_CALLS, trialPauseMs: TRIAL_PAUSE_MS,
    note: "k=1 受 ovhcloud 限流约束，仅作 harness 能否驱动第二模型族的可行性证据；非统计结论。若被 429 拖垮属端点稳定性问题，非 Δ 消失，不触发 §4.2 降级。",
    arms: {
      bro2: { passed: bro2Passed, total: trials, passRate: bro2Passed / trials, perTask: tasks.map((t) => brep(t.id)) },
      minimal: { passed: minPassed, total: trials, passRate: minPassed / trials, perTask: tasks.map((t) => mrep(t.id)) },
    },
    delta: { bro2MinusMinimal: delta },
    honest: {
      isLeaderboardScore: false, thirdPartyVerified: false, isModelCapabilityScore: false,
      writtenToExternalResults: false, leadershipVerdictChanged: false, l4Changed: false,
      limitations: [
        "k=1 受 ovhcloud 限流约束，非统计结论",
        "ovhcloud 免 Key 但限流约 3 次/窗口，多步跑分易撞限流；冷却后仍可能 429",
        "若被 429 拖垮属端点稳定性问题，非 Δ 消失，不触发 §4.2 降级",
        "不写 external-results.json，不改 L4 / verdict",
      ],
    },
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  const extAfter = fingerprint(EXTERNAL_RESULTS);
  if (extBefore !== extAfter) throw new Error("防自指违规：本测量改动了 external-results.json");

  console.log(`\n  holdout=${HOLDOUT} · bro2 ${bro2Passed}/${trials} · minimal ${minPassed}/${trials} · Δ=${delta}`);
  console.log(`  产物: ${OUT}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) await main();
