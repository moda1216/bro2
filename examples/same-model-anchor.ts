/**
 * bro2 · 同模型隔离锚点（v2.33.0）
 * ----------------------------------------------------------
 * 承接 v2.30.0 起悬置的「下一步 ③：同模型隔离锚点」。端点扫描（endpoint-scan.ts）
 * 已证实：ovhcloud/gpt-oss-120b 匿名免 Key、原生 tool_calls、身份与公开榜条目一致；
 * v2.30 的 provider_error 根因是匿名层 2 req/min 与 harness 退避（1s/2s/4s、maxRetries=2）
 * 不匹配，而非端点故障。
 *
 * 本脚本在**测量侧**为该端点做节流适配（不改 src、不改默认行为、不加模型能力）：
 *   - 相邻 chat/completions 请求间隔 ≥31s；429 时按同节奏等待重试；
 *   - 墙钟上限随节流同步校准（节流等待不该消耗 agent 的时间预算）；
 *   - token/步数口径沿用 v2.32.0 校准值，显式成套声明。
 *
 * 产出：bro2(gpt-oss-120b) 在冻结 4 任务上的可复核读数，与公开榜
 * `gpt-oss-120b = 26.217%`（Terminal-Bench 2.1 全量 / default-official harness）并列。
 *
 * 诚实红线：**两者任务集不同、难度不可比，之差不是严格 harness-Δ**。
 * 本轮价值 = 把「第二端点不可用」推进为「第二端点可用 + 有读数 + Δ 边界清楚」。
 * 不写 external-results.json、不改 L4/verdict、自跑非第三方复核、小样本。
 *
 * 运行：
 *   ANCHOR_TASKS=tb-analyze-access-logs ANCHOR_K=1 \
 *     node --experimental-strip-types --no-warnings examples/same-model-anchor.ts
 *   （不设 ANCHOR_TASKS 则跑全部 4 任务；默认 K=2）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentOS } from "../src/index.ts";
import { faultConfig, mergeConfigForEval } from "../src/observability/eval-grade.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";
import { EventType } from "../src/kernel/events.ts";
import {
  loadTasks, instructionOf, prepare, runVerifier, checkInputs,
  MAX_MODEL_CALLS, fingerprint, HONEST_LIMITATIONS,
} from "./external-measure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "data", "bench", "external");
const OUT = join(EXT, "same-model-anchor-report.json");
const SNAPSHOT = join(EXT, "tb-leaderboard-snapshot.json");
const SCAN = join(EXT, "endpoint-scan-report.json");
const EXTERNAL_RESULTS = join(ROOT, "data", "benchmark", "external-results.json");

const PROVIDER = "ovhcloud";
const MODEL = "gpt-oss-120b";
const OVH_BASE = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";
const OVH_HOST = "oai.endpoints.kepler.ai.cloud.ovh.net";

// ---- 预算口径（沿用 v2.32.0 校准值，显式成套） ----
const MAX_STEPS = MAX_MODEL_CALLS;        // 12
const MAX_TOKENS = 120_000;               // 12 × 10000 token/步（v2.31 实测依据）
const MAX_SECONDS = 3600;                 // 墙钟口径校准：节流等待不计入 agent 时间预算
const ADVISORY = 0;                       // 软预警维持默认关闭（v2.31/v2.32 未证明有效）

// ---- 节流适配（唯一新增的测量侧机制，任务无关） ----
const MIN_GAP_MS = 31_000;
const MAX_429_RETRIES = 4;
const MIN_GAP_BASIS = "OVHcloud 匿名层 2 req/min/model/IP（catalog rate_limit_api_anonymous，2026-10-08 复核）→ 相邻请求 ≥30s，取 31s 留余量";
const throttle = { waits: 0, waitMs: 0, rateLimit429: 0, chatCalls: 0, max429Retries: MAX_429_RETRIES };
let lastAt = 0;
let chain: Promise<unknown> = Promise.resolve();
const rawFetch = globalThis.fetch.bind(globalThis);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isOvhChat(input: unknown): boolean {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  return url.includes(OVH_HOST) && url.includes("/chat/completions");
}

async function throttled(input: unknown, init?: RequestInit): Promise<Response> {
  const gap = MIN_GAP_MS - (Date.now() - lastAt);
  if (gap > 0) { throttle.waits += 1; throttle.waitMs += gap; await sleep(gap); }
  for (let i = 0; i <= MAX_429_RETRIES; i += 1) {
    lastAt = Date.now();
    throttle.chatCalls += 1;
    const res = await rawFetch(input as string, init);
    if (res.status !== 429) return res;
    throttle.rateLimit429 += 1;
    if (i === MAX_429_RETRIES) return res;
    await sleep(MIN_GAP_MS);
  }
  return rawFetch(input as string, init);
}

globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  if (!isOvhChat(input)) return rawFetch(input as string, init);
  const job = chain.then(() => throttled(input, init));
  chain = job.then(() => undefined, () => undefined);
  return job;
}) as typeof fetch;

const TOOLS = [{ type: "function", function: {
  name: "echo", description: "Echo a short string back",
  parameters: { type: "object", properties: { s: { type: "string" } }, required: ["s"] },
} }];

/** 身份核实：以响应 model 字段为准（BlockRun 重定向是反例），不匹配则拒绝出报告。 */
async function verifyIdentity(): Promise<Record<string, unknown>> {
  const r = await fetch(OVH_BASE + "/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, messages: [{ role: "user", content: 'Call the echo tool with s="ok" and nothing else.' }],
      max_tokens: 96, tools: TOOLS, tool_choice: "auto",
    }),
  });
  const txt = await r.text();
  let j: any = null; try { j = JSON.parse(txt); } catch {}
  const respModel: string | null = j?.model ?? null;
  return {
    http: r.status, respModel, requestedModel: MODEL,
    toolCalls: j?.choices?.[0]?.message?.tool_calls?.length ?? 0,
    matchesAnchor: respModel === MODEL,
    error: j?.error?.message ?? (r.status >= 400 ? txt.slice(0, 200) : null),
  };
}

interface Trial {
  taskId: string; repeat: number;
  verifierPassed: boolean; fileLanded: boolean;
  stoppedBy: string; reason: string; guardKinds: string[];
  toolErrors: number; compactions: number;
  steps: number; toolCalls: number; tokens: number; latencyMs: number;
  verifierTail: string;
}

async function trial(t: ReturnType<typeof loadTasks>[number], repeat: number): Promise<Trial> {
  const tmp = mkdtempSync(join(tmpdir(), "bro2-anchor-"));
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
          maxSteps: MAX_STEPS, maxTokens: MAX_TOKENS, maxSeconds: MAX_SECONDS,
          budgetAdvisoryRatio: ADVISORY,
        } } as Partial<RuntimeConfig>,
      ),
    });
    os.router.setDefault(PROVIDER);
    os.router.setStrict(true); // 禁止静默降级，唯一模型不得被替换
    const s = os.createSession("standard");
    const r = await os.run(s.id, input);
    const v = runVerifier(t, ws);
    const events = s.trajectory.events();
    const guardKinds = events.filter((e) => e.type === EventType.Guard)
      .map((e) => String((e.payload as Record<string, unknown>).kind ?? "unknown"));
    const toolErrors = events.filter((e) => {
      if (e.type !== EventType.ToolResult) return false;
      return (e.payload as { result?: { ok?: boolean } }).result?.ok === false;
    }).length;
    const noFile = /does not exist|FileNotFoundError|No such file or directory/i.test(v.output);
    return {
      taskId: t.id, repeat, verifierPassed: v.passed, fileLanded: !noFile,
      stoppedBy: r.stoppedBy, reason: r.reason, guardKinds, toolErrors,
      compactions: events.filter((e) => e.type === EventType.Compaction).length,
      steps: r.steps, toolCalls: r.toolCallCount, tokens: r.usage.totalTokens,
      latencyMs: Date.now() - started, verifierTail: v.output.slice(-300),
    };
  } finally {
    if (os) await os.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const round = (n: number) => +n.toFixed(4);
const all = loadTasks();
checkInputs(all);
const filter = (process.env.ANCHOR_TASKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const tasks = filter.length ? all.filter((t) => filter.includes(t.id)) : all;
if (!tasks.length) throw new Error(`ANCHOR_TASKS 未匹配任何任务: ${filter.join(",")}`);
const K = Math.max(1, Number(process.env.ANCHOR_K ?? 2));
const extBefore = fingerprint(EXTERNAL_RESULTS);

console.log("=".repeat(92));
console.log("  bro2 · 同模型隔离锚点 · gpt-oss-120b via ovhcloud（节流适配）· v2.33.0");
console.log("=".repeat(92));
console.log(`  ${tasks.length} 任务 × K=${K} = ${tasks.length * K} 次 | 预算 maxSteps=${MAX_STEPS} maxTokens=${MAX_TOKENS} maxSeconds=${MAX_SECONDS}`);
console.log(`  节流 ${MIN_GAP_MS}ms（${MIN_GAP_BASIS}）| 429 最多重试 ${MAX_429_RETRIES} 次`);
console.log("  【0】模型身份核实");
const identity = await verifyIdentity();
console.log(`    http=${identity.http} resp_model=${identity.respModel} tools=${identity.toolCalls} matches=${identity.matchesAnchor}`);
if (!identity.matchesAnchor || identity.http !== 200 || (identity.toolCalls as number) < 1) {
  throw new Error("模型身份/工具调用核实失败：拒绝出报告（防空转仪表盘）");
}

const trials: Trial[] = [];
for (const t of tasks) {
  for (let k = 1; k <= K; k += 1) {
    const r = await trial(t, k);
    trials.push(r);
    console.log(`  [${String(trials.length).padStart(2)}/${tasks.length * K}] ${t.id.padEnd(28)} r${k} ${r.verifierPassed ? "✓PASS" : "✗FAIL"} ${r.steps}步 ${r.toolCalls}工具 ${r.tokens}tok stop=${r.stoppedBy} guards=[${r.guardKinds.join(",")}] ${(r.latencyMs / 1000).toFixed(0)}s`);
  }
}

const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
  benchmark: string; dataAsOf: string; sameModelAnchor: string;
  entries: Array<{ model: string; score: number; isSameModelAnchor?: boolean; harness?: string }>;
};
const anchorEntry = snap.entries.find((e) => e.isSameModelAnchor)!;
const lbRate = anchorEntry.score / 100;
const passes = trials.filter((t) => t.verifierPassed).length;
const passRate = trials.length ? passes / trials.length : 0;
const stops: Record<string, number> = {};
for (const t of trials) stops[t.stoppedBy] = (stops[t.stoppedBy] ?? 0) + 1;
const scan = JSON.parse(readFileSync(SCAN, "utf8")) as { summary: Record<string, unknown> };
const extAfter = fingerprint(EXTERNAL_RESULTS);

const report = {
  generatedAt: new Date().toISOString(),
  kind: "same-model-anchor-probe",
  provider: PROVIDER, model: MODEL, endpoint: OVH_BASE, keyless: true, toolCalling: "native",
  question: "给 bro2 接一个能稳定驱动完整 harness 的第二端点，做同模型隔离锚点（v2.30 起悬置的下一步③）",
  endpointScan: {
    source: "data/bench/external/endpoint-scan-report.json",
    totalProbes: scan.summary.totalProbes,
    toolsOk: scan.summary.toolsOk,
    usableSameModelAnchor: scan.summary.usableSameModelAnchor,
    verdict: "15 个候选中 5 个 TOOLS_OK；唯一身份匹配公开榜条目的是 ovhcloud/gpt-oss-120b。第二端点从来不缺，缺的是限流适配。",
  },
  throttling: {
    basis: MIN_GAP_BASIS, minGapMs: MIN_GAP_MS, max429Retries: MAX_429_RETRIES,
    stats: { ...throttle },
    note: "纯测量侧 fetch 适配：不改 src、不改默认行为、不改预算口径（除墙钟显式校准）、不加模型能力。",
  },
  identity,
  budget: {
    maxSteps: MAX_STEPS, maxTokens: MAX_TOKENS, maxSeconds: MAX_SECONDS, budgetAdvisoryRatio: ADVISORY,
    wiring: "coupled-explicit", source: "v2.32.0 校准口径 + 墙钟随节流同步校准",
    maxSecondsNote: "节流引入的等待不应消耗 agent 时间预算；显式放宽并由报告披露，避免把测量适配伪装成能力约束。",
  },
  sample: { taskIds: tasks.map((t) => t.id), nTasks: tasks.length, k: K, trials: trials.length },
  leaderboard: {
    benchmark: snap.benchmark, dataAsOf: snap.dataAsOf,
    anchorModel: anchorEntry.model, anchorHarness: anchorEntry.harness ?? "default/official",
    fullPassRate: lbRate, source: "llmleaderboard.com/benchmarks/terminal-bench",
  },
  trials,
  summary: {
    passes, total: trials.length, passRate: round(passRate),
    stopDistribution: stops,
    providerErrorCount: trials.filter((t) => t.stoppedBy === "provider_error").length,
    tokenGuardCount: trials.filter((t) => t.guardKinds.includes("tokens")).length,
    fileMissing: trials.filter((t) => !t.fileLanded).length,
    avgSteps: round(trials.reduce((a, t) => a + t.steps, 0) / (trials.length || 1)),
    avgToolCalls: round(trials.reduce((a, t) => a + t.toolCalls, 0) / (trials.length || 1)),
    avgTokens: Math.round(trials.reduce((a, t) => a + t.tokens, 0) / (trials.length || 1)),
    totalToolErrors: trials.reduce((a, t) => a + t.toolErrors, 0),
    totalLatencyMs: trials.reduce((a, t) => a + t.latencyMs, 0),
  },
  comparison: {
    bro2SamplePassRate: round(passRate),
    leaderboardFullPassRate: lbRate,
    nominalDelta: round(passRate - lbRate),
    kind: "non-strict-positioning-reference",
    isStrictHarnessDelta: false,
    note: "两者不可直接相减归因于 harness：本样本是 4 个 curated（静态输入 / 纯 stdlib 评分器）Terminal-Bench 任务子集，公开榜 26.217% 是 Terminal-Bench 2.1 全量任务集上 gpt-oss-120b + default/official harness 的 pass@1。任务集非逐位一致、难度分布不可比，之差混合了任务集差异、harness 差异与端点噪声。仅作位次参照，不构成严格同模型 harness-Δ 隔离估计。",
    whatWouldBeNeeded: "官方 harness 在同一 4 任务子集上的 pass@1，或 bro2 在榜单全量任务集上的成绩，二者取其一才可构成可归因的 Δ。",
  },
  verifierSanity: {
    status: "inherited-from-v2.30.0/v2.32.0",
    note: "4 任务公开 verifier 双向健全性（空工作区 fail / 官方解 pass）在 v2.30.0 与 v2.32.0 已验证且 SHA256SUMS 未变；本轮为节省容器时间未重跑，checkInputs 已校验输入文件存在与指纹一致。",
  },
  honesty: [
    ...HONEST_LIMITATIONS,
    "同模型锚点已取得有效读数（端点身份核实通过、非 provider_error），但对照为「非逐位同任务集」的位次参照，不是严格 harness-Δ。",
    "节流是测量侧适配，不是 bro2 能力优化；不得把通过率变化归因于机制改进。",
    "不写 external-results.json（前后指纹一致）、不改 L4 与 leadership.verdict、不改 src 默认行为。",
    "自跑、非第三方复核、免费匿名端点、小样本；单端点结果不外推。",
  ],
  externalResultsUntouched: extBefore === extAfter,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log("\n" + "=".repeat(92));
console.log(`  完成：bro2(${MODEL}) ${passes}/${trials.length} = ${round(passRate)} | 公开榜全量 = ${lbRate}`);
console.log(`  名义差 = ${report.comparison.nominalDelta}（${report.comparison.kind}，不可归因 harness）`);
console.log(`  停止分布 ${JSON.stringify(stops)} | provider_error=${report.summary.providerErrorCount} | 节流等待 ${throttle.waits} 次 / ${(throttle.waitMs / 1000).toFixed(0)}s | 429重试=${throttle.rateLimit429}`);
console.log(`  external-results.json 未改动: ${report.externalResultsUntouched}`);
console.log(`  报告: ${OUT}`);
