/**
 * bro2 · 外部公开任务测量（v2.27.0）
 *
 * 第一次把 bro2 放到「公开任务 + 公开评分器 + 真实模型端点」上被判分。
 * 两个 arm 共用：同一模型/端点、同一任务、同一输入、同一最大模型调用数、
 * 同一个 Docker 容器里的上游公开 pytest 评分器、同一 /app 路径语义。
 *   - bro2    ：完整 harness（治理 / 上下文 / 工具调度 / 轨迹 / 预算）
 *   - minimal ：最小 scaffold（单 shell 工具、线性历史、无治理层）
 * Δ = bro2 通过数 − minimal 通过数。这是本仓库自跑的内部对照，不是榜单分数。
 *
 * 诚实边界（写进报告产物，不是口头声明）：bro2 自跑 / 非第三方复核 /
 * k=1 / 3 个 easy 任务 / 免费匿名端点 / 不写 external-results.json /
 * 不改 L4 与 leadership.verdict。
 *
 * 运行：sh examples/fetch-external-tasks.sh
 *       docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile
 *       AGENTOS_LIVE_PROVIDER=kilo npm run external:measure
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
import type { Message } from "../src/kernel/events.ts";
import type { ToolSchema } from "../src/tools/schema.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "data", "bench", "external");
const UPSTREAM = join(EXT, "upstream");
const OUT = join(EXT, "external-measure-report.json");
const BRO2_REPORT = join(EXT, "bro2-eval-report.json");
const EXTERNAL_RESULTS = join(ROOT, "data", "benchmark", "external-results.json");
const IMAGE = "bro2/tb-verifier:1";
const PROVIDER = process.env.AGENTOS_LIVE_PROVIDER ?? "kilo";
const MAX_MODEL_CALLS = 12;
const STEP_TIMEOUT_MS = 45_000;
const VERIFY_TIMEOUT_MS = 120_000;

/** 透明的路径适配说明：公开任务原文用 /app/...，两个 arm 都在隔离工作区里按相对路径执行。 */
export const ENV_NOTE = `

[harness adapter — 以下为环境说明，非公开任务原文]
你的当前工作目录等价于任务描述中的 /app。所有 /app/xxx 请按当前目录下的相对路径 xxx 读写
（例如 /app/report.txt 写作 report.txt，/app/data/output.json 写作 data/output.json）。
输入文件已放在当前目录，可用 shell 查看与处理。不要访问网络，不要使用绝对路径 /app/...。
完成文件产出后，给出一句简短终答并停止调用工具。`;

export const HONEST_LIMITATIONS = [
  "bro2 自跑、非第三方复核、仅内部对照，不构成公开榜单成绩",
  "k=1、3 个公开 easy 任务、免费匿名端点 kilo-auto/free，端点能力与限流不稳定",
  "任务取自 Terminal-Bench original-tasks，非官方 core 子集、非榜单口径",
  "结果是 Model + Harness 端到端产物；既不证明模型能力，也不证明 harness 通用增益",
  "评分器为上游公开 pytest，在统一 Docker 容器中按 /app 语义执行；已用官方 oracle 解与空工作区双向验证",
  "未写 data/benchmark/external-results.json，不改 L4 / leadership.verdict",
  "若 Δ≤0 或换 holdout 模型后消失，按 docs/CAPABILITY-POSITION.md §4.2 降级定位",
];

interface ExtTask {
  id: string; dir: string; category: EvalTask["category"]; difficulty: string;
  instruction: string; inputs: Array<{ from: string; to: string }>;
  verifier: string; verifierSha256: string; oracle: string; artifact: string;
}
interface VerifyResult { passed: boolean; exitCode: number; output: string }

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
export const fingerprint = (p: string): string => (existsSync(p) ? sha256(p) : "ABSENT");
const tail = (s: string, n: number): string => s.slice(-n);
const dirOf = (t: ExtTask): string => join(UPSTREAM, t.dir);

const loadTasks = (): ExtTask[] => readFileSync(join(EXT, "tasks.jsonl"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))
  .map((l) => JSON.parse(l) as ExtTask);

/** 从上游 task.yaml 提取 instruction: |- 块，不改动原文措辞。 */
export function parseInstruction(raw: string): string {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => /^instruction:\s*\|-?\s*$/.test(l));
  if (start < 0) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") { body.push(""); continue; }
    if (/^\S/.test(line)) break;
    body.push(line.replace(/^ {2,3}/, ""));
  }
  return body.join("\n").trim();
}

const instructionOf = (t: ExtTask): string =>
  parseInstruction(readFileSync(join(dirOf(t), t.instruction), "utf8")) + ENV_NOTE;

function checkInputs(tasks: ExtTask[]): void {
  for (const t of tasks) {
    const v = join(dirOf(t), t.verifier);
    if (!existsSync(v)) throw new Error(`缺少上游文件，请先运行 external:fetch：${v}`);
    if (sha256(v) !== t.verifierSha256) throw new Error(`评分器指纹不匹配：${t.id}`);
    for (const f of t.inputs) {
      if (!existsSync(join(dirOf(t), f.from))) throw new Error(`缺少输入文件：${t.id}/${f.from}`);
    }
    if (!existsSync(join(dirOf(t), t.oracle))) throw new Error(`缺少官方 oracle 解：${t.id}`);
  }
}

function prepare(t: ExtTask, workspace: string): void {
  for (const f of t.inputs) {
    const dst = join(workspace, f.to);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(dirOf(t), f.from), dst, { recursive: true });
  }
}

/** 上游公开评分器：把 agent 工作区挂成 /app，tests/ 只读挂载，在固定镜像里跑 pytest。 */
function runVerifier(t: ExtTask, workspace: string): VerifyResult {
  const ctx = mkdtempSync(join(tmpdir(), "bro2-tb-verify-"));
  try {
    const ws = join(ctx, "ws");
    const tests = join(ctx, "tests");
    mkdirSync(ws, { recursive: true });
    mkdirSync(tests, { recursive: true });
    cpSync(workspace, ws, { recursive: true });
    cpSync(join(dirOf(t), dirname(t.verifier)), tests, { recursive: true });
    const r = spawnSync("docker", [
      "run", "--rm", "-v", `${ws}:/app`, "-v", `${tests}:/tests:ro`, "-w", "/app",
      IMAGE, "python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "/tests/test_outputs.py",
    ], { encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
    return {
      passed: r.status === 0,
      exitCode: r.status ?? -1,
      output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}`.slice(-4000),
    };
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

function applyOracle(t: ExtTask, workspace: string): { ok: boolean; output: string } {
  const r = spawnSync("docker", [
    "run", "--rm", "-v", `${workspace}:/app`,
    "-v", `${join(dirOf(t), t.oracle)}:/solution.sh:ro`, "-w", "/app",
    IMAGE, "bash", "-lc", "bash /solution.sh",
  ], { encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-800) };
}

/** 防「空转仪表盘」：评分器必须能判失败（空工作区）也能判通过（上游官方解）。 */
function sanity(t: ExtTask): Record<string, unknown> {
  const tmp = mkdtempSync(join(tmpdir(), "bro2-tb-sanity-"));
  try {
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    const r1 = runVerifier(t, empty);
    const ws = join(tmp, "oracle");
    mkdirSync(ws);
    prepare(t, ws);
    const oracle = applyOracle(t, ws);
    const r2 = runVerifier(t, ws);
    return {
      taskId: t.id,
      verifierSha256: sha256(join(dirOf(t), t.verifier)),
      emptyWorkspace: r1.passed ? "UNEXPECTED-PASS" : "fail",
      oracleSolution: r2.passed ? "pass" : "FAIL",
      oracleExitOk: oracle.ok,
      oracleOutput: tail(oracle.output, 300),
      sound: !r1.passed && r2.passed && oracle.ok,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function loadProvider(): { provider: OpenAICompatProvider; model: string; endpoint: string } {
  const cfg = JSON.parse(readFileSync(join(ROOT, "agentos.config.json"), "utf8")) as {
    model: { providers: Record<string, { baseUrl: string; model: string; apiKeyOptional?: boolean; timeoutMs?: number; maxRetries?: number }> };
  };
  const p = cfg.model.providers[PROVIDER];
  if (!p) throw new Error(`provider 未在 agentos.config.json 注册: ${PROVIDER}`);
  return {
    provider: new OpenAICompatProvider({
      name: PROVIDER, baseUrl: p.baseUrl, model: p.model, apiKey: "",
      apiKeyOptional: p.apiKeyOptional === true, timeoutMs: p.timeoutMs, maxRetries: p.maxRetries,
    }),
    model: p.model, endpoint: p.baseUrl,
  };
}

/** 最小 scaffold 基线：单 shell 工具、线性历史、无 bro2 治理/上下文/RSI 层。 */
async function runMinimal(t: ExtTask, provider: OpenAICompatProvider): Promise<Record<string, unknown>> {
  const tmp = mkdtempSync(join(tmpdir(), "bro2-tb-min-"));
  const ws = join(tmp, "ws");
  mkdirSync(ws);
  try {
    prepare(t, ws);
    const messages: Message[] = [
      { role: "system", content: "You are a terminal coding agent. Use the shell tool to complete the task in the current working directory. When finished, reply with a short final answer and no tool call." },
      { role: "user", content: instructionOf(t) },
    ];
    const tools: ToolSchema[] = [{
      name: "shell", description: "Execute a bash command in the working directory; stdout/stderr is returned.",
      parameters: { type: "object", properties: { command: { type: "string", description: "bash command" } }, required: ["command"] },
    }];
    let modelCalls = 0;
    let steps = 0;
    let final = "";
    let error = "";
    while (modelCalls < MAX_MODEL_CALLS) {
      let resp;
      try {
        resp = await provider.complete({ messages, tools, temperature: 0 });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        break;
      }
      modelCalls += 1;
      if (resp.toolCalls.length === 0) {
        final = resp.content;
        messages.push({ role: "assistant", content: resp.content });
        break;
      }
      messages.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });
      for (const c of resp.toolCalls) {
        const cmd = String(c.arguments?.command ?? "");
        const r = spawnSync("bash", ["-lc", cmd], { cwd: ws, encoding: "utf8", timeout: STEP_TIMEOUT_MS, maxBuffer: 256 * 1024 });
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}`.slice(-6000) || "(no output)";
        messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: out });
      }
      steps += 1;
    }
    const v = runVerifier(t, ws);
    return {
      taskId: t.id, verifierPassed: v.passed, verifierExitCode: v.exitCode,
      verifierOutput: tail(v.output, 800), modelCalls, steps,
      finalAnswer: final.slice(0, 300), error: error.slice(0, 300),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const tasks = loadTasks();
  checkInputs(tasks);
  const upstream = JSON.parse(readFileSync(join(EXT, "UPSTREAM.json"), "utf8")) as Record<string, unknown>;
  const extBefore = fingerprint(EXTERNAL_RESULTS);

  console.log("=".repeat(84));
  console.log("  bro2 · 外部公开任务测量（Terminal-Bench 公开评分器 + 真实模型端点）");
  console.log("=".repeat(84));
  console.log(`  上游 ${String(upstream.repo)} @ ${String(upstream.commit).slice(0, 12)} · ${tasks.length} 任务`);
  console.log(`  端点 ${PROVIDER} · 同预算 maxModelCalls=${MAX_MODEL_CALLS} · k=1`);
  console.log("");

  console.log("  【0/3】公开评分器健全性（空工作区应 fail / 官方解应 pass）");
  const sanityResults = tasks.map((t) => {
    const r = sanity(t);
    console.log(`    ${r.sound ? "✓" : "✗"} ${String(r.taskId).padEnd(24)} empty=${r.emptyWorkspace} oracle=${r.oracleSolution}`);
    return r;
  });
  if (sanityResults.some((r) => !r.sound)) {
    throw new Error("公开评分器健全性校验失败：接线有误，拒绝出报告（防空转仪表盘）");
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const verifyMap = new Map<string, VerifyResult>();
  const evalTasks: EvalTask[] = tasks.map((t) => ({ id: t.id, category: t.category, input: instructionOf(t) }));

  console.log("\n  【1/3】bro2 完整 harness · live（strict，禁止降级到 Mock）");
  const report = await runEval({
    tasks: evalTasks, mode: "live", providerName: PROVIDER, k: 1, root: ROOT,
    configOverride: { budget: { maxSteps: MAX_MODEL_CALLS } } as Partial<RuntimeConfig>,
    prepareWorkspace: (task, ws) => prepare(byId.get(task.id)!, ws),
    verifyWorkspace: (task, ws) => {
      const v = runVerifier(byId.get(task.id)!, ws);
      verifyMap.set(task.id, v);
      return v.passed ? [] : [`公开 verifier 未通过（exit=${v.exitCode}）：${tail(v.output, 400)}`];
    },
    onProgress: (l) => console.log(l),
  });
  saveReport(BRO2_REPORT, report);

  console.log("\n  【2/3】minimal scaffold 基线（同模型 / 同任务 / 同预算 / 同评分器）");
  const { provider, model, endpoint } = loadProvider();
  const minimal: Array<Record<string, unknown>> = [];
  for (const t of tasks) {
    console.log(`    → ${t.id}`);
    minimal.push(await runMinimal(t, provider));
  }

  const bro2PerTask = report.runs.map((r) => {
    const v = verifyMap.get(r.taskId);
    return {
      taskId: r.taskId, verifierPassed: v?.passed === true, evalOk: r.ok,
      steps: r.steps, toolCalls: r.toolCalls, latencyMs: r.latencyMs,
      reasons: r.reasons, verifierExitCode: v?.exitCode ?? null,
      verifierOutput: tail(v?.output ?? "", 800),
    };
  });
  const perTask = tasks.map((t) => {
    const b = bro2PerTask.find((x) => x.taskId === t.id)!;
    const m = minimal.find((x) => x.taskId === t.id)!;
    const bv = b.verifierPassed ? 1 : 0;
    const mv = m.verifierPassed ? 1 : 0;
    return { taskId: t.id, bro2: bv, minimal: mv, delta: bv - mv };
  });
  const bro2Passed = perTask.reduce((a, x) => a + x.bro2, 0);
  const minimalPassed = perTask.reduce((a, x) => a + x.minimal, 0);
  const extAfter = fingerprint(EXTERNAL_RESULTS);

  const output = {
    kind: "external-task-measurement",
    version: 1,
    timestamp: new Date().toISOString(),
    upstream: { ...upstream, selectedTaskIds: tasks.map((t) => t.id) },
    provider: { name: PROVIDER, model, endpoint, keyless: true, toolCalling: "native" },
    budget: { maxModelCalls: MAX_MODEL_CALLS, k: 1, sameInputs: true, sameVerifier: true, samePathSemantics: "/app" },
    verifierImage: IMAGE,
    verifierSanity: sanityResults,
    arms: { bro2: { passed: bro2Passed, total: tasks.length, perTask: bro2PerTask }, minimal: { passed: minimalPassed, total: tasks.length, perTask: minimal } },
    delta: { bro2MinusMinimal: bro2Passed - minimalPassed, perTask },
    honest: {
      isLeaderboardScore: false,
      thirdPartyVerified: false,
      isModelCapabilityScore: false,
      writtenToExternalResults: extBefore !== extAfter,
      leadershipVerdictChanged: false,
      l4Changed: false,
      selfRunInternalContrastOnly: true,
      limitations: HONEST_LIMITATIONS,
      reproduce: [
        "sh examples/fetch-external-tasks.sh",
        "docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile",
        `AGENTOS_LIVE_PROVIDER=${PROVIDER} npm run external:measure`,
      ],
    },
  };
  writeFileSync(OUT, JSON.stringify(output, null, 2));
  if (extBefore !== extAfter) throw new Error("防自指违规：本测量改动了 external-results.json");

  console.log("\n  【3/3】结果（主指标 = 上游公开评分器判定，非自建断言）");
  for (const p of perTask) {
    console.log(`    ${p.taskId.padEnd(24)} bro2=${p.bro2}  minimal=${p.minimal}  Δ=${p.delta >= 0 ? "+" : ""}${p.delta}`);
  }
  console.log(`    ── 合计 bro2 ${bro2Passed}/${tasks.length} · minimal ${minimalPassed}/${tasks.length} · Δ=${bro2Passed - minimalPassed >= 0 ? "+" : ""}${bro2Passed - minimalPassed}`);
  console.log("\n  诚实边界：自跑内部对照 / k=1 / 免费端点 / 非榜单分数 / 不写 external-results.json / 不改 L4");
  console.log(`  报告：${OUT}`);
  console.log(`  明细：${BRO2_REPORT}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) await main();
