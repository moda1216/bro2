/**
 * bro2 · Terminal-Bench 公开 leaderboard 对照（v2.30.0）
 *
 * 用户方向：不要等第三方来填对照槽，直接用「第三方已有公开成绩的任务集」给 bro2 跑，就能对比。
 * Terminal-Bench 官方 leaderboard（llmleaderboard.com / harbor）已有大量 agent 的公开 pass@1；
 * bro2 本就是按 Harbor 自定义 agent 契约设计的（P0-01），跑同一家族任务即可直接对公开数字。
 *
 * 本脚本：用 bro2 完整 harness 在给定的 Terminal-Bench 任务样本上自跑，把样本 pass@1 与
 * data/bench/external/tb-leaderboard-snapshot.json 中的公开成绩对照：
 *   - 若端点模型命中快照中的同模型条目（如 ovhcloud/gpt-oss-120b ↔ 榜单 26.217%），则
 *     Δ = bro2样本通过率 − 榜单全量通过率 即「同模型、不同 harness」的 harness Δ（样本估计）。
 *   - 若端点模型不在榜单（如 kilo 匿名免费模型），则只做「模型+harness 综合位次」定位，不做 harness 隔离。
 *
 * 同时采集 bro2 的轨迹指标（平均步数 / 工具调用数 / 成功率）用于策略 B 的轨迹层面能力画像。
 *
 * 诚实边界：bro2 自跑、非第三方复核、样本量小、与榜单非逐位同任务集、不写 external-results.json、不改 L4/verdict。
 *
 * 运行：sh examples/fetch-external-tasks.sh
 *       docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile
 *       EXT_K=2 EXT_PROVIDERS=kilo,ovhcloud AGENTOS_LIVE_PROVIDER=kilo node --experimental-strip-types --no-warnings examples/tb-leaderboard-compare.ts
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runEval, saveReport } from "../src/observability/eval.ts";
import type { EvalTask } from "../src/observability/eval.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import {
  loadTasks, checkInputs, sanity, instructionOf, prepare, runVerifier, MAX_MODEL_CALLS,
  loadProvider, fingerprint, HONEST_LIMITATIONS,
} from "./external-measure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "data", "bench", "external");
const UPSTREAM = join(EXT, "upstream");
const OUT = join(EXT, "tb-leaderboard-compare-report.json");
const BRO2_REPORT = join(EXT, "bro2-eval-report.json");
const SNAPSHOT = join(EXT, "tb-leaderboard-snapshot.json");
const EXTERNAL_RESULTS = join(ROOT, "data", "benchmark", "external-results.json");

const K = Math.max(1, Number(process.env.EXT_K ?? 2));
const PROVIDER_LIST = (process.env.EXT_PROVIDERS ?? "kilo").split(",").map((s) => s.trim()).filter(Boolean);
const PRIMARY = PROVIDER_LIST[0]!;
const IMAGE = "bro2/tb-verifier:1";
const VERIFY_TIMEOUT_MS = 120_000;

interface ExtTask {
  id: string; dir: string; category: EvalTask["category"]; difficulty: string;
  instruction: string; inputs: Array<{ from: string; to: string }>;
  verifier: string; verifierSha256: string; oracle: string; artifact: string;
}
interface VerifyResult { passed: boolean; exitCode: number; output: string }
interface Bro2Run { verifierPassed: boolean; steps: number; toolCalls: number; latencyMs: number; reasons: string[] }

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const tail = (s: string, n: number): string => s.slice(-n);
const dirOf = (t: ExtTask): string => join(UPSTREAM, t.dir);

function trajSummary(runs: Bro2Run[]) {
  const n = runs.length || 1;
  const steps = runs.reduce((a, r) => a + r.steps, 0) / n;
  const tools = runs.reduce((a, r) => a + r.toolCalls, 0) / n;
  const ok = runs.filter((r) => r.verifierPassed).length;
  return { avgSteps: +steps.toFixed(2), avgToolCalls: +tools.toFixed(2), passRate: +(ok / n).toFixed(4), n };
}

/** 单 provider 跑 bro2（完整 harness），K 次重复，采集判分 + 轨迹指标。 */
async function runBro2(provider: string, tasks: ExtTask[], byId: Map<string, ExtTask>, evalTasks: EvalTask[]): Promise<Record<string, unknown>> {
  const { model, endpoint } = loadProvider(provider);
  const byTask = new Map<string, { passes: number; trials: number; runs: Bro2Run[] }>();
  for (let r = 0; r < K; r += 1) {
    let verifyLog: VerifyResult[] = [];
    const report = await runEval({
      tasks: evalTasks, mode: "live", providerName: provider, k: 1, root: ROOT,
      configOverride: { budget: { maxSteps: MAX_MODEL_CALLS } } as Partial<RuntimeConfig>,
      prepareWorkspace: (task, ws) => prepare(byId.get(task.id)!, ws),
      verifyWorkspace: (task, ws) => {
        const v = runVerifier(byId.get(task.id)!, ws);
        verifyLog.push(v);
        return v.passed ? [] : [`公开 verifier 未通过（exit=${v.exitCode}）：${tail(v.output, 400)}`];
      },
      onProgress: (l) => console.log(l),
    });
    saveReport(BRO2_REPORT, report);
    report.runs.forEach((run, i) => {
      const v = verifyLog[i]!;
      const e = byTask.get(run.taskId) ?? { passes: 0, trials: 0, runs: [] as Bro2Run[] };
      e.trials += 1;
      if (v.passed) e.passes += 1;
      e.runs.push({ verifierPassed: v.passed, steps: run.steps, toolCalls: run.toolCalls, latencyMs: run.latencyMs, reasons: run.reasons });
      byTask.set(run.taskId, e);
    });
  }
  const perTask = tasks.map((t) => {
    const e = byTask.get(t.id)!;
    return { taskId: t.id, trials: e.trials, passes: e.passes, passRate: +(e.passes / e.trials).toFixed(4), traj: trajSummary(e.runs) };
  });
  const passed = perTask.reduce((a, x) => a + x.passes, 0);
  const trials = tasks.length * K;
  return {
    provider, model, endpoint, keyless: true, toolCalling: "native",
    budget: { maxModelCalls: MAX_MODEL_CALLS, k: K, sameInputs: true, sameVerifier: true, samePathSemantics: "/app" },
    sample: { taskIds: tasks.map((t) => t.id), nTasks: tasks.length, trials },
    passed, total: trials, passRate: +(passed / trials).toFixed(4),
    perTask,
  };
}

function buildComparison(providers: Array<Record<string, any>>): Record<string, unknown> {
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
    benchmark: string; dataAsOf: string; sameModelAnchor: string; entries: Array<Record<string, any>>;
  };
  const anchorModel = snap.sameModelAnchor;
  const comparisons = providers.filter((p) => !p.skipped).map((p) => {
    const myModel = String(p.model).toLowerCase();
    const match = snap.entries.find((e) => String(e.model).toLowerCase() === myModel);
    if (match) {
      const lb = (match.score as number) / 100;
      return {
        provider: p.provider, model: p.model, matchedLeaderboardEntry: match.model,
        bro2SamplePassRate: p.passRate, leaderboardFullPassRate: lb,
        harnessDeltaSample: +(p.passRate - lb).toFixed(4),
        kind: "same-model-harness-delta",
        note: "同模型（" + match.model + "）不同 harness：bro2 样本通过率 − 榜单全量通过率。样本量小、任务集非逐位一致，属样本估计，非严格头对头。",
      };
    }
    return {
      provider: p.provider, model: p.model, matchedLeaderboardEntry: null,
      bro2SamplePassRate: p.passRate, leaderboardFullPassRate: null,
      harnessDeltaSample: null,
      kind: "positioning-only",
      note: "端点模型（" + p.model + "）不在公开榜单（匿名免费端点），只能做「模型+harness 综合位次」定位，无法隔离 harness 贡献。",
    };
  });
  return {
    benchmark: snap.benchmark, leaderboardDataAsOf: snap.dataAsOf, sameModelAnchor: anchorModel,
    comparisons,
  };
}

async function main(): Promise<void> {
  const tasks = loadTasks();
  checkInputs(tasks);
  const upstream = JSON.parse(readFileSync(join(EXT, "UPSTREAM.json"), "utf8")) as Record<string, unknown>;
  const extBefore = fingerprint(EXTERNAL_RESULTS);

  console.log("=".repeat(84));
  console.log("  bro2 · Terminal-Bench 公开 leaderboard 对照（第三方已有公开成绩的任务集）· v2.30.0");
  console.log("=".repeat(84));
  console.log(`  上游 ${String(upstream.repo)} @ ${String(upstream.commit).slice(0, 12)} · ${tasks.length} 任务 · k=${K} · 端点 ${PROVIDER_LIST.join(",")}`);

  console.log("\n  【0】公开评分器健全性（空工作区应 fail / 官方解应 pass，模型无关）");
  const sanityResults = tasks.map((t) => {
    const r = sanity(t);
    console.log(`    ${r.sound ? "✓" : "✗"} ${String(r.taskId).padEnd(30)} empty=${r.emptyWorkspace} oracle=${r.oracleSolution}`);
    return r;
  });
  if (sanityResults.some((r) => !r.sound)) throw new Error("公开评分器健全性校验失败：拒绝出报告（防空转仪表盘）");

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const evalTasks: EvalTask[] = tasks.map((t) => ({ id: t.id, category: t.category, input: instructionOf(t) }));

  const providers: Array<Record<string, unknown>> = [];
  for (const pname of PROVIDER_LIST) {
    console.log(`\n  【测量】端点 ${pname} · bro2 完整 harness · ${K} 次`);
    try {
      const res = await runBro2(pname, tasks, byId, evalTasks);
      providers.push(res);
      console.log(`    ${pname}: bro2 ${String(res.passed)}/${String(res.total)} · passRate=${String(res.passRate)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`    ${pname}: 测量失败 — ${msg.slice(0, 200)}`);
      providers.push({ provider: pname, error: msg.slice(0, 400), skipped: true });
    }
    const out = {
      kind: "terminal-bench-leaderboard-compare",
      version: 1,
      timestamp: new Date().toISOString(),
      upstream: { ...upstream, selectedTaskIds: tasks.map((t) => t.id) },
      k: K,
      providers: PROVIDER_LIST,
      primaryProvider: PRIMARY,
      verifierImage: IMAGE,
      verifierSanity: sanityResults,
      providers_detail: providers,
      leaderboardComparison: buildComparison(providers as Array<Record<string, any>>),
      honest: {
        isLeaderboardScore: false,
        thirdPartyVerified: false,
        isModelCapabilityScore: false,
        writtenToExternalResults: extBefore !== fingerprint(EXTERNAL_RESULTS),
        leadershipVerdictChanged: false,
        l4Changed: false,
        selfRunInternalContrastOnly: false,
        comparesAgainstPublicLeaderboard: true,
        limitations: HONEST_LIMITATIONS,
        reproduce: [
          "sh examples/fetch-external-tasks.sh",
          "docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile",
          `EXT_K=${K} EXT_PROVIDERS=${PROVIDER_LIST.join(",")} AGENTOS_LIVE_PROVIDER=${PRIMARY} node --experimental-strip-types --no-warnings examples/tb-leaderboard-compare.ts`,
        ],
      },
    };
    writeFileSync(OUT, JSON.stringify(out, null, 2));
  }

  if (extBefore !== fingerprint(EXTERNAL_RESULTS)) throw new Error("防自指违规：本测量改动了 external-results.json");
  console.log(`\n  报告：${OUT}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) await main();
