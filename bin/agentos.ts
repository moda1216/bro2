#!/usr/bin/env node
/**
 * bro2 入口
 *   node --experimental-strip-types bin/agentos.ts                    交互 CLI
 *   ... bin/agentos.ts run --task "..." --preset standard             单次任务（headless）
 *   ... bin/agentos.ts web --port 3080                               Web UI + REST/SSE API
 *   ... bin/agentos.ts doctor                                        模型接入诊断（面向人，永远 EXIT=0）
 *   ... bin/agentos.ts preflight [--provider X] [--all] [--json]      接入门禁（未就绪 EXIT=1，CI 可用）
 *   ... bin/agentos.ts eval --mode deterministic                      框架能力回归评测 → eval-report.json
 *   ... bin/agentos.ts eval --mode live                               真实模型评测（先过 preflight）→ eval-live-report.json
 *   ... bin/agentos.ts evolve --reset                                 有界可验证自我改进
 */
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS, AGENT_NAME } from "../src/index.ts";
import { runCLI } from "../src/interfaces/cli.ts";
import { startServer } from "../src/interfaces/api.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import { runPreflight, formatPreflight } from "../src/models/preflight.ts";
import type { PreflightResult } from "../src/models/preflight.ts";
import { runEval, loadTasks, loadBaseline, saveReport, formatReport } from "../src/observability/eval.ts";
import { runEvolve, formatEvolveReport, runMetaEvolve, formatMetaReport } from "../src/rsi/index.ts";
import { runBenchmark, formatBenchmarkReport } from "../src/benchmark/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Flags {
  task?: string;
  preset?: string;
  model?: string;
  port?: number;
  host?: string;
  mode: string;
  evalMode?: string;
  k: number;
  tasks?: string;
  baseline?: string;
  saveBaseline?: string;
  json: boolean;
  autoApprove: boolean;
  quiet: boolean;
  dryRun: boolean;
  reset: boolean;
  generations?: number;
  rounds?: number;
  all?: boolean;
  skipPreflight?: boolean;
}

function parse(argv: string[]): Flags {
  const first = argv[0] && !argv[0].startsWith("--") ? argv[0] : "cli";
  const flags: Flags = {
    mode: ["cli", "run", "web", "eval", "doctor", "preflight", "evolve", "meta", "benchmark"].includes(first) ? first : "cli",
    k: 1,
    json: false,
    autoApprove: false,
    quiet: false,
    dryRun: false,
    reset: false,
    all: false,
    skipPreflight: false,
  };
  for (let i = first === "cli" && argv[0]?.startsWith("--") ? 0 : 1; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--task" && next) { flags.task = next; i += 1; }
    else if (a === "--preset" && next) { flags.preset = next; i += 1; }
    else if (a === "--model" && next) { flags.model = next; i += 1; }
    else if (a === "--provider" && next) { flags.model = next; i += 1; }
    else if (a === "--port" && next) { flags.port = Number(next); i += 1; }
    else if (a === "--host" && next) { flags.host = next; i += 1; }
    else if (a === "--mode" && next) { flags.evalMode = next; i += 1; }
    else if (a === "--k" && next) { flags.k = Math.max(1, Number(next)); i += 1; }
    else if (a === "--tasks" && next) { flags.tasks = next; i += 1; }
    else if (a === "--baseline" && next) { flags.baseline = next; i += 1; }
    else if (a === "--save-baseline" && next) { flags.saveBaseline = next; i += 1; }
    else if (a === "--generations" && next) { flags.generations = Math.max(1, Number(next)); i += 1; }
    else if (a === "--rounds" && next) { flags.rounds = Math.max(1, Number(next)); i += 1; }
    else if (a === "--json") flags.json = true;
    else if (a === "--auto-approve") flags.autoApprove = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--reset") flags.reset = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--skip-preflight") flags.skipPreflight = true;
  }
  if (flags.mode === "cli" && flags.task) flags.mode = "run";
  return flags;
}

const flags = parse(process.argv.slice(2));
const os = createAgentOS({ autoApprove: flags.autoApprove });

// ---------------------------------------------------------------- doctor
if (flags.mode === "doctor") {
  process.stdout.write("\n" + "=".repeat(84) + `\n  ${AGENT_NAME} · 模型接入诊断\n` + "=".repeat(84) + "\n");
  for (const [name, provider] of os.providers) {
    if (!(provider instanceof OpenAICompatProvider)) {
      process.stdout.write(`\n  [${name}] 离线确定性模型（Mock）——无需端点探测，用于框架回归。\n`);
      continue;
    }
    const p = provider as OpenAICompatProvider & { configured: boolean; baseUrl?: string };
    process.stdout.write(`\n  [${name}]  OpenAI 兼容端点（本地 Ollama / vLLM / LM Studio / 云端 API）\n`);
    process.stdout.write(`    configured : ${p.configured ? "✓" : "✗ 未配置 baseUrl 或 model"}\n`);
    if (!p.configured) {
      process.stdout.write("    → 设置 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL，或 OLLAMA_BASE_URL / OLLAMA_MODEL\n");
      continue;
    }
    const r = await p.probe();
    process.stdout.write(`    reachable  : ${r.reachable ? "✓" : "✗"}   (${r.latencyMs} ms)\n`);
    process.stdout.write(`    network    : ${r.networkReachable ? "✓ 端点可达" : "✗ 网络不可达"}   http=${r.httpStatus ?? "-"}\n`);
    process.stdout.write(`    auth       : ${r.authRejected ? "✗ 认证被拒 (401/403)" : r.networkReachable ? "✓ 通过" : "? 未判定"}\n`);
    process.stdout.write(`    model      : ${r.model}\n`);
    process.stdout.write(`    models     : ${r.models.length ? r.models.slice(0, 8).join(", ") : "(端点未提供清单)"}\n`);
    process.stdout.write(`    streaming  : ${r.streaming ? "✓ SSE" : "✗"}\n`);
    const tc: Record<string, string> = { native: "✓ 原生 tool_calls", "text-json": "✗ 只写进正文", unsupported: "✗ 不支持", unknown: "? 未判定" };
    process.stdout.write(`    toolCalling: ${tc[r.toolCalling] ?? r.toolCalling}   ← Agent 能否使用工具的硬前提\n`);
    for (const w of r.warnings) process.stdout.write(`    ! ${w}\n`);
    for (const s of r.suggestions) process.stdout.write(`    → ${s}\n`);
  }
  process.stdout.write("\n" + "=".repeat(84) + "\n");
  await os.shutdown();
}

// ---------------------------------------------------------------- preflight
else if (flags.mode === "preflight") {
  const names = flags.all
    ? [...os.providers.keys()]
    : [flags.model ?? process.env.AGENTOS_LIVE_PROVIDER ?? "ollama"];
  const results: PreflightResult[] = [];
  let allReady = true;
  for (const name of names) {
    const provider = os.providers.get(name);
    if (!provider) {
      process.stderr.write(`未注册的 provider: ${name}\n`);
      allReady = false;
      continue;
    }
    if (!(provider instanceof OpenAICompatProvider)) {
      // --all 时 Mock 是预期内的离线回退，不算阻断；单独指定时才判为错误。
      if (!flags.all) {
        process.stderr.write(`provider "${name}" 是离线 Mock，不能用于 live 评测。\n`);
        allReady = false;
      }
      continue;
    }
    const r = await runPreflight(provider);
    results.push(r);
    if (!r.ready) allReady = false;
    if (!flags.json) process.stdout.write(formatPreflight(r) + "\n");
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ allReady, results }, null, 2) + "\n");
  } else {
    process.stdout.write(`\n  门禁结论: ${allReady ? "✓ PASS —— 可以执行 npm run eval:live" : "✗ BLOCKED —— 禁止运行 live 评测"}\n`);
  }
  await os.shutdown();
  if (!allReady) process.exitCode = 1;
}

// ---------------------------------------------------------------- eval
else if (flags.mode === "eval") {
  const tasksPath = flags.tasks ?? join(ROOT, "data/eval-tasks.jsonl");
  const baselinePath = flags.baseline ?? join(ROOT, "data/eval-baseline.json");
  const tasks = loadTasks(resolve(ROOT, tasksPath));
  const requested = flags.evalMode ?? process.env.AGENTOS_EVAL_MODE ?? "deterministic";
  const mode = requested === "live" ? "live" : "deterministic";
  const providerName = flags.model ?? (mode === "live"
    ? (process.env.AGENTOS_LIVE_PROVIDER ?? os.router.defaultName)
    : "mock");

  // live 预检门禁：端点未就绪时拒绝开跑，避免产出会被误读成「能力差」的低分报告。
  if (mode === "live" && !flags.skipPreflight) {
    const provider = os.providers.get(providerName);
    if (!(provider instanceof OpenAICompatProvider)) {
      process.stderr.write(`预检失败：provider "${providerName}" 不是 OpenAI 兼容端点，live 评测禁止使用 Mock。\n`);
      await os.shutdown();
      process.exit(1);
    }
    const pf = await runPreflight(provider);
    if (!flags.json) process.stdout.write(formatPreflight(pf) + "\n");
    if (!pf.ready) {
      if (flags.json) process.stdout.write(JSON.stringify({ error: "preflight-blocked", preflight: pf }, null, 2) + "\n");
      process.stderr.write("已拒绝运行 live 评测：先修复上述阻断项；确需跳过用 --skip-preflight（不建议）。\n");
      await os.shutdown();
      process.exit(1);
    }
  }

  const report = await runEval({
    tasks,
    mode,
    providerName,
    k: flags.k,
    root: ROOT,
    baseline: loadBaseline(baselinePath),
    onProgress: (line) => { if (!flags.json && !flags.quiet) process.stdout.write(line + "\n"); },
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(report) + "\n");
    process.stdout.write(`任务集: ${tasksPath}   指纹: ${report.taskSetHash}\n`);
    if (report.baselineSkipped) process.stdout.write("注意：任务集已变更，旧基线指纹不匹配，本轮跳过回归对比。\n");
  }
  // live 报告独立落盘：绝不覆盖 data/eval-report.json（L1 证据与确定性基线的唯一来源）。
  const artifactPath = join(ROOT, mode === "live" ? "data/eval-live-report.json" : "data/eval-report.json");
  saveReport(artifactPath, report);
  if (flags.saveBaseline) saveReport(resolve(ROOT, flags.saveBaseline), report);
  if ((!existsSync(baselinePath) || report.baselineSkipped) && report.gate.pass && mode === "deterministic") {
    saveReport(baselinePath, report);
    if (!flags.json) process.stdout.write(`已更新回归基线: ${baselinePath}\n`);
  }
  if (!flags.json) process.stdout.write(`报告已写入: ${artifactPath}\n`);
  await os.shutdown();
  if (!report.gate.pass) process.exitCode = 1;
}

// ---------------------------------------------------------------- evolve
else if (flags.mode === "evolve") {
  const report = await runEvolve({
    root: ROOT,
    dryRun: flags.dryRun,
    reset: flags.reset,
    ...(flags.generations ? { generations: flags.generations } : {}),
    onProgress: (line) => { if (!flags.json && !flags.quiet) process.stdout.write(line + "\n"); },
  });
  if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    process.stdout.write(formatEvolveReport(report) + "\n");
    if (!flags.dryRun) process.stdout.write(`演进报告: ${join(ROOT, "data/evolve-report.json")}\n`);
  }
  await os.shutdown();
  if (!report.integrity.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- meta（改进机制自身迭代）
else if (flags.mode === "meta") {
  const report = await runMetaEvolve({
    root: ROOT,
    dryRun: flags.dryRun,
    ...(flags.rounds ? { rounds: flags.rounds } : {}),
    ...(flags.generations ? { generations: flags.generations } : {}),
    onProgress: (line) => { if (!flags.json && !flags.quiet) process.stdout.write(line + "\n"); },
  });
  if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatMetaReport(report) + "\n");
  await os.shutdown();
  if (!report.integrity.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- benchmark（能力基准 + 领先度评估）
else if (flags.mode === "benchmark") {
  const report = await runBenchmark({
    root: ROOT,
    onProgress: (line) => { if (!flags.json && !flags.quiet) process.stdout.write(line + "\n"); },
  });
  if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatBenchmarkReport(report) + "\n");
  await os.shutdown();
}

// ---------------------------------------------------------------- web / run / cli
else if (flags.mode === "web") {
  const server = await startServer(os, {
    host: flags.host ?? os.config.server.host,
    port: flags.port ?? os.config.server.port,
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (flags.port ?? os.config.server.port);
  process.stdout.write(`${AGENT_NAME} Web UI: http://${flags.host ?? os.config.server.host}:${port}\n`);
} else {
  await runCLI(os, {
    ...(flags.preset ? { preset: flags.preset } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.task ? { task: flags.task } : {}),
    autoApprove: flags.autoApprove,
    quiet: flags.quiet,
  });
}
