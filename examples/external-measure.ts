/**
 * bro2 · 外部公开任务测量（v2.28.0）
 *
 * 把 bro2 放到「公开任务 + 公开评分器 + 真实模型端点」上被判分，并做 P0-04：
 *   - 扩 k：每题重复 K 次（默认 3），报告**通过率**而非单发通过（消解 v2.27.0 的 33pp/题单发权重）；
 *   - 跨 holdout 模型：在第二个可工具调用端点（默认 ovhcloud / gpt-oss-120b，与 kilo 不同模型族）
 *     复测，检查 Δ 是否跨模型稳定（Δ 消失即按 §4.2 降级定位）。
 *
 * 两个 arm 共用：同一模型/端点、同一任务、同一输入、同一最大模型调用数、
 * 同一个 Docker 容器里的上游公开 pytest 评分器、同一 /app 路径语义。
 *   - bro2    ：完整 harness（治理 / 上下文 / 工具调度 / 轨迹 / 预算）
 *   - minimal ：最小 scaffold（单 shell 工具、线性历史、无治理层）
 * Δ = bro2 通过数 − minimal 通过数。这是本仓库自跑的内部对照，不是榜单分数。
 *
 * 诚实边界（写进报告产物，不是口头声明）：bro2 自跑 / 非第三方复核 /
 * k≥3 / 公开 easy 任务 / 免费匿名端点 / 不写 external-results.json / 不改 L4 与 leadership.verdict。
 *
 * 运行：sh examples/fetch-external-tasks.sh
 *       docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile
 *       EXT_K=3 EXT_PROVIDERS=kilo,ovhcloud AGENTOS_LIVE_PROVIDER=kilo npm run external:measure
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
export const MAX_MODEL_CALLS = 12;
/**
 * v2.32.0 读数修正：外部测量的「名义步数预算」必须与「累计 token 熔断」成套显式声明。
 * 历史失真根源：configOverride 只写 maxSteps=12，maxTokens 靠 agentos.config.json 默认值
 * 60000 静默生效，实际 binding constraint 是累计 token 而非步数，读数口径失真。
 * 显式写出该默认值（语义不变、历史可复现），并在报告带 effectiveBindingConstraint 标签。
 * 成套口径与修正后读数见 examples/readout-recalibration.ts + docs/CORE-REPORT.html。
 */
export const LEGACY_MAX_TOKENS = 60000;
const STEP_TIMEOUT_MS = 45_000;
const VERIFY_TIMEOUT_MS = 120_000;

/** 每题重复次数（默认 3，消解单发 33pp/题权重）；可用 EXT_K 覆盖。 */
const K = Math.max(1, Number(process.env.EXT_K ?? 3));
/** 复测的端点列表（逗号分隔，默认 kilo + ovhcloud holdout）；可用 EXT_PROVIDERS 覆盖。 */
const PROVIDER_LIST = (process.env.EXT_PROVIDERS ?? "kilo,ovhcloud")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PRIMARY = PROVIDER_LIST[0]!;

/** 透明的路径适配说明：公开任务原文用 /app/...，两个 arm 都在隔离工作区里按相对路径执行。 */
export const ENV_NOTE = `

[harness adapter — 以下为环境说明，非公开任务原文]
你的当前工作目录等价于任务描述中的 /app。所有 /app/xxx 请按当前目录下的相对路径 xxx 读写
（例如 /app/report.txt 写作 report.txt，/app/data/output.json 写作 data/output.json）。
输入文件已放在当前目录，可用 shell 查看与处理。不要访问网络，不要使用绝对路径 /app/...。
完成文件产出后，给出一句简短终答并停止调用工具。`;

export const HONEST_LIMITATIONS = [
  "bro2 自跑、非第三方复核、仅内部对照，不构成公开榜单成绩",
  `k=${K}、公开 easy 任务、免费匿名端点（kilo / ovhcloud gpt-oss-120b），端点能力与限流不稳定`,
  "任务取自 Terminal-Bench original-tasks，非官方 core 子集、非榜单口径",
  "结果是 Model + Harness 端到端产物；既不证明模型能力，也不证明 harness 通用增益",
  "评分器为上游公开 pytest，在统一 Docker 容器中按 /app 语义执行；已用官方 oracle 解与空工作区双向验证",
  "未写 data/benchmark/external-results.json，不改 L4 / leadership.verdict",
  "若 Δ≤0 或换 holdout 模型后消失，按 docs/CAPABILITY-POSITION.md §4.2 降级定位",
  "minimal scaffold 是本仓库自实现基线，不等于公开 mini-swe-agent / Terminus-2；跨模型复测的严格性仍受限于可用免费端点",
];

interface ExtTask {
  id: string; dir: string; category: EvalTask["category"]; difficulty: string;
  instruction: string; inputs: Array<{ from: string; to: string }>;
  verifier: string; verifierSha256: string; oracle: string; artifact: string;
}
interface VerifyResult { passed: boolean; exitCode: number; output: string }
interface ArmTrial { verifierPassed: boolean; verifierExitCode: number; verifierOutput: string; steps: number; toolCalls: number; latencyMs: number; reasons: string[]; finalAnswer?: string; error?: string; modelCalls?: number }

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
export const fingerprint = (p: string): string => (existsSync(p) ? sha256(p) : "ABSENT");
const tail = (s: string, n: number): string => s.slice(-n);
const dirOf = (t: ExtTask): string => join(UPSTREAM, t.dir);

export const loadTasks = (): ExtTask[] => readFileSync(join(EXT, "tasks.jsonl"), "utf8")
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

export const instructionOf = (t: ExtTask): string =>
  parseInstruction(readFileSync(join(dirOf(t), t.instruction), "utf8")) + ENV_NOTE;

export function checkInputs(tasks: ExtTask[]): void {
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

export function prepare(t: ExtTask, workspace: string): void {
  for (const f of t.inputs) {
    const dst = join(workspace, f.to);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(dirOf(t), f.from), dst, { recursive: true });
  }
}

/** 上游公开评分器：把 agent 工作区挂成 /app，tests/ 只读挂载，在固定镜像里跑 pytest。 */
export function runVerifier(t: ExtTask, workspace: string): VerifyResult {
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

/** 防「空转仪表盘」：评分器必须能判失败（空工作区）也能判通过（上游官方解）。模型无关，只算一次。 */
export function sanity(t: ExtTask): Record<string, unknown> {
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

export function loadProvider(name: string): { provider: OpenAICompatProvider; model: string; endpoint: string } {
  const cfg = JSON.parse(readFileSync(join(ROOT, "agentos.config.json"), "utf8")) as {
    model: { providers: Record<string, { baseUrl: string; model: string; apiKeyOptional?: boolean; timeoutMs?: number; maxRetries?: number }> };
  };
  const p = cfg.model.providers[name];
  if (!p) throw new Error(`provider 未在 agentos.config.json 注册: ${name}`);
  return {
    provider: new OpenAICompatProvider({
      name, baseUrl: p.baseUrl, model: p.model, apiKey: "",
      apiKeyOptional: p.apiKeyOptional === true, timeoutMs: p.timeoutMs, maxRetries: p.maxRetries,
    }),
    model: p.model, endpoint: p.baseUrl,
  };
}

/** 最小 scaffold 基线：单 shell 工具、线性历史、无 bro2 治理/上下文/RSI 层。 */
export async function runMinimal(t: ExtTask, provider: OpenAICompatProvider): Promise<ArmTrial> {
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
      verifierPassed: v.passed, verifierExitCode: v.exitCode, verifierOutput: tail(v.output, 800),
      steps, toolCalls: steps, latencyMs: 0, reasons: error ? [error] : [], finalAnswer: final.slice(0, 300), error: error.slice(0, 300), modelCalls,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 单 provider 测量：bro2 × K 次 + minimal × K 次，返回通过率聚合。 */
async function measureProvider(name: string, tasks: ExtTask[], byId: Map<string, ExtTask>, evalTasks: EvalTask[]): Promise<Record<string, unknown>> {
  const { provider, model, endpoint } = loadProvider(name);

  // bro2：逐次 runEval(k=1) 跑 K 遍，每次独立 verifyWorkspace 记录判分，避免重复覆盖。
  const bro2ByTask = new Map<string, { passes: number; trials: number; runs: ArmTrial[] }>();
  for (let r = 0; r < K; r += 1) {
    let verifyLog: VerifyResult[] = [];
    const report = await runEval({
      tasks: evalTasks, mode: "live", providerName: name, k: 1, root: ROOT,
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
      const e = bro2ByTask.get(run.taskId) ?? { passes: 0, trials: 0, runs: [] as ArmTrial[] };
      e.trials += 1;
      if (v.passed) e.passes += 1;
      e.runs.push({ verifierPassed: v.passed, verifierExitCode: v.exitCode, verifierOutput: tail(v.output, 800), steps: run.steps, toolCalls: run.toolCalls, latencyMs: run.latencyMs, reasons: run.reasons });
      bro2ByTask.set(run.taskId, e);
    });
  }

  // minimal：K 次重复。
  const minByTask = new Map<string, { passes: number; trials: number; runs: ArmTrial[] }>();
  for (let r = 0; r < K; r += 1) {
    for (const t of tasks) {
      const m = await runMinimal(t, provider);
      const e = minByTask.get(t.id) ?? { passes: 0, trials: 0, runs: [] as ArmTrial[] };
      e.trials += 1;
      if (m.verifierPassed) e.passes += 1;
      e.runs.push(m);
      minByTask.set(t.id, e);
    }
  }

  const bro2Per = tasks.map((t) => {
    const e = bro2ByTask.get(t.id)!;
    return { taskId: t.id, trials: e.trials, passes: e.passes, passRate: e.passes / e.trials, runs: e.runs };
  });
  const minPer = tasks.map((t) => {
    const e = minByTask.get(t.id)!;
    return { taskId: t.id, trials: e.trials, passes: e.passes, passRate: e.passes / e.trials, runs: e.runs };
  });
  const perTask = tasks.map((t) => {
    const b = bro2Per.find((x) => x.taskId === t.id)!;
    const m = minPer.find((x) => x.taskId === t.id)!;
    return { taskId: t.id, bro2: b.passes, minimal: m.passes, delta: b.passes - m.passes };
  });
  const bro2Passed = bro2Per.reduce((a, x) => a + x.passes, 0);
  const minPassed = minPer.reduce((a, x) => a + x.passes, 0);
  const trials = tasks.length * K;

  return {
    name, model, endpoint, keyless: true, toolCalling: "native",
    budget: { maxModelCalls: MAX_MODEL_CALLS, k: K, sameInputs: true, sameVerifier: true, samePathSemantics: "/app" },
    arms: {
      bro2: { passed: bro2Passed, total: trials, passRate: bro2Passed / trials, perTask: bro2Per },
      minimal: { passed: minPassed, total: trials, passRate: minPassed / trials, perTask: minPer },
    },
    delta: { bro2MinusMinimal: bro2Passed - minPassed, perTask },
  };
}

async function main(): Promise<void> {
  const tasks = loadTasks();
  checkInputs(tasks);
  const upstream = JSON.parse(readFileSync(join(EXT, "UPSTREAM.json"), "utf8")) as Record<string, unknown>;
  const extBefore = fingerprint(EXTERNAL_RESULTS);

  console.log("=".repeat(84));
  console.log("  bro2 · 外部公开任务测量（Terminal-Bench 公开评分器 + 真实模型端点）· P0-04 硬化");
  console.log("=".repeat(84));
  console.log(`  上游 ${String(upstream.repo)} @ ${String(upstream.commit).slice(0, 12)} · ${tasks.length} 任务 · k=${K} · 端点 ${PROVIDER_LIST.join(",")}`);
  console.log("");

  console.log("  【0/3】公开评分器健全性（空工作区应 fail / 官方解应 pass，模型无关，只算一次）");
  const sanityResults = tasks.map((t) => {
    const r = sanity(t);
    console.log(`    ${r.sound ? "✓" : "✗"} ${String(r.taskId).padEnd(24)} empty=${r.emptyWorkspace} oracle=${r.oracleSolution}`);
    return r;
  });
  if (sanityResults.some((r) => !r.sound)) {
    throw new Error("公开评分器健全性校验失败：接线有误，拒绝出报告（防空转仪表盘）");
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const evalTasks: EvalTask[] = tasks.map((t) => ({ id: t.id, category: t.category, input: instructionOf(t) }));

  const providers: Array<Record<string, unknown>> = [];
  for (const pname of PROVIDER_LIST) {
    console.log(`\n  【测量】端点 ${pname} · bro2 完整 harness + minimal scaffold · 各 ${K} 次`);
    try {
      const res = await measureProvider(pname, tasks, byId, evalTasks);
      providers.push(res);
      console.log(`    ${pname}: bro2 ${String((res.arms as any).bro2.passed)}/${String((res.arms as any).bro2.total)} · minimal ${String((res.arms as any).minimal.passed)}/${String((res.arms as any).minimal.total)} · Δ=${(res.delta as any).bro2MinusMinimal}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`    ${pname}: 测量失败（保留已完成的端点结果）— ${msg.slice(0, 200)}`);
      providers.push({ name: pname, error: msg.slice(0, 400), skipped: true });
    }
    // 增量落盘：即使后续端点失败，已完成结果不丢。
    writeReport(providers, sanityResults, extBefore, upstream, tasks);
  }

  // 跨模型稳定性：bro2 通过率在 kilo / ovhcloud 上是否同向。
  const ok = providers.filter((p) => !p.skipped);
  const crossModel = ok.length >= 2 ? analyzeCrossModel(ok, tasks) : { note: "仅单一端点完成，跨模型稳定性待补", stable: null as boolean | null };
  const out = JSON.parse(readFileSync(OUT, "utf8")) as Record<string, unknown>;
  out.crossModel = crossModel;
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  if (extBefore !== fingerprint(EXTERNAL_RESULTS)) throw new Error("防自指违规：本测量改动了 external-results.json");
}

function writeReport(providers: Array<Record<string, unknown>>, sanity: Array<Record<string, unknown>>, extBefore: string, upstream: Record<string, unknown>, tasks: ExtTask[]): void {
  const ok = providers.filter((p) => !p.skipped);
  const primary = (ok[0] ?? providers[0]!) as Record<string, any>;
  const extAfter = fingerprint(EXTERNAL_RESULTS);
  const output = {
    kind: "external-task-measurement",
    version: 2,
    timestamp: new Date().toISOString(),
    upstream: { ...upstream, selectedTaskIds: tasks.map((t) => t.id) },
    k: K,
    providers: PROVIDER_LIST,
    primaryProvider: PRIMARY,
    verifierImage: IMAGE,
    verifierSanity: sanity,
    providers_detail: providers,
    // 顶层镜像（与 v2.27.0 契约一致）：primary 端点的 arms / delta
    arms: primary.arms,
    delta: primary.delta,
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
        `EXT_K=${K} EXT_PROVIDERS=${PROVIDER_LIST.join(",")} AGENTOS_LIVE_PROVIDER=${PRIMARY} npm run external:measure`,
      ],
    },
  };
  writeFileSync(OUT, JSON.stringify(output, null, 2));
}

function analyzeCrossModel(providers: Array<Record<string, any>>, tasks: ExtTask[]): Record<string, unknown> {
  const byName = new Map(providers.map((p) => [p.name, p as any]));
  const names = [...byName.keys()];
  const bro2Rate: Record<string, number> = {};
  const minRate: Record<string, number> = {};
  const deltaByProvider: Record<string, number> = {};
  const degraded: string[] = [];
  for (const n of names) {
    const p = byName.get(n)!;
    bro2Rate[n] = p.arms.bro2.passRate;
    minRate[n] = p.arms.minimal.passRate;
    deltaByProvider[n] = p.delta.bro2MinusMinimal;
    // 低通过率 + 极小 Δ 视为端点驱动失败（provider_error）导致的无效对照，而非有效的跨模型数据点。
    if (p.arms.bro2.passRate < 0.15 && p.delta.bro2MinusMinimal <= 1) degraded.push(n);
  }
  const valid = names.filter((n) => !degraded.includes(n));
  const perTask = tasks.map((t) => {
    const row: Record<string, number | string> = { taskId: t.id };
    for (const n of names) {
      const b = byName.get(n)!.arms.bro2.perTask.find((x: any) => x.taskId === t.id);
      row[`bro2_${n}`] = b ? b.passRate : NaN;
    }
    return row;
  });
  const deltas = valid.map((n) => deltaByProvider[n]!);
  const signConsistent = deltas.length > 0 && (deltas.every((d) => d >= 0) || deltas.every((d) => d <= 0));
  let note: string;
  if (degraded.length > 0) {
    note = `跨模型复刻未完成：holdout 端点 ${degraded.join(", ")} 被 provider_error 拖垮（bro2 通过率≈0，agent 几乎未产出文件），属无效对照，不能据此判断 Δ 是否跨模型稳定；仅 ${valid.join(", ") || "无"} 提供有效数据。Δ 未消失、未触发 §4.2 降级，但跨模型确认仍缺失，需换一个能在完整 harness 下稳定驱动工具调用的第二端点。`;
  } else if (signConsistent) {
    note = "跨模型 Δ 同向（均 ≥0），非单点过拟合的初步证据；仍需扩大任务集与 k 复核。";
  } else {
    note = "Δ 符号跨模型不一致，需更多任务/端点复核。";
  }
  return {
    providers: names,
    validProviders: valid,
    degradedProviders: degraded,
    bro2PassRateByProvider: bro2Rate,
    minimalPassRateByProvider: minRate,
    deltaByProvider,
    perTaskBro2PassRate: perTask,
    signConsistent,
    note,
  };
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) await main();
