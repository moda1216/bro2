/**
 * 接入预检门禁 · 防误判实证
 *
 * 验证的不是「能不能连上模型」，而是三件基础设施可信度：
 *  1) 门禁真的能当门禁（就绪 EXIT=0 / 未就绪 EXIT≠0，且 --json 可被程序判定）；
 *  2) 网络故障与认证故障给出不同结论，不把「Key 错」误导成「服务没起」；
 *  3) live 链路打通后不污染证据面：确定性报告、外部基准、verdict 全部原地不动。
 *
 * 全程只在临时端口起本地服务，不写任何真实凭据、不伪造任何外部证据。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startOllamaBridge } from "./ollama-bridge.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import { runPreflight } from "../src/models/preflight.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin/agentos.ts");

let passed = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(52)} ${detail}`);
}
function hr(t: string): void { console.log(`\n${"─".repeat(84)}\n  ${t}\n${"─".repeat(84)}`); }

/** 文件指纹：存在性 + 长度 + 采样哈希；用于断言「测试运行前后某文件未被本测试改动」。 */
function sniffFile(p: string): string {
  if (!existsSync(p)) return "ABSENT";
  try {
    const buf = readFileSync(p);
    let h = 0;
    for (let i = 0; i < buf.length; i += 1009) h = (Math.imul(h, 31) + buf[i]!) >>> 0;
    return `PRESENT:${buf.length}:${h}`;
  } catch { return "UNREADABLE"; }
}

/**
 * 必须用异步 spawn，不能用 spawnSync：本地 bridge 服务器跑在本进程事件循环里，
 * spawnSync 会同步阻塞父进程导致服务器无法响应子进程请求（经典自死锁，status=null）。
 */
function cli(args: string[], overrides: Record<string, string | undefined> = {}): Promise<{
  status: number | null; stdout: string; stderr: string;
}> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.OLLAMA_BASE_URL;
  delete env.OLLAMA_MODEL;
  delete env.AGENTOS_LIVE_PROVIDER;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
      cwd: ROOT, env: env as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function compat(baseUrl: string, model = "qwen3:8b"): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: "test", baseUrl, apiKey: "", model,
    apiKeyOptional: true, timeoutMs: 8000, maxRetries: 0,
  });
}

async function startAuthRejectServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { message: "Authentication Fails, invalid api key", type: "authentication_error" },
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    async close(): Promise<void> { await new Promise<void>((r) => server.close(() => r())); },
  };
}

console.log("=".repeat(84));
console.log("  bro2 · 接入预检门禁实证");
console.log("=".repeat(84));

// ---------------------------------------------------------------- 1) CLI 门禁
hr("1 / 4  CLI 门禁：退出码与 --json 机器可判定");
const blocked = await cli(["preflight"]);
check("沙箱无端点 → EXIT 非 0", blocked.status !== 0, `status=${blocked.status}`);
check("沙箱无端点 → 输出 BLOCKED", (blocked.stdout ?? "").includes("BLOCKED"));
check("沙箱无端点 → 明确报端点可达失败", (blocked.stdout ?? "").includes("端点可达"));
const blockedJson = await cli(["preflight", "--json"]);
let parsed: { allReady?: boolean; results?: Array<{ ready?: boolean }> } | null = null;
try { parsed = JSON.parse(blockedJson.stdout ?? "") as typeof parsed; } catch { /* 保持 null */ }
check("沙箱 --json 可解析", parsed !== null);
check("沙箱 --json allReady=false", parsed?.allReady === false);

const bridge = await startOllamaBridge("native");
const ready = await cli(["preflight"], { OLLAMA_BASE_URL: bridge.url, OLLAMA_MODEL: bridge.model });
check("指向就绪端点 → EXIT=0", ready.status === 0, `status=${ready.status} ${ready.stdout.includes("BLOCKED") ? "(BLOCKED)" : ""}`);
check("指向就绪端点 → 输出 PASS", (ready.stdout ?? "").includes("PASS"));
const readyJson = await cli(["preflight", "--json"], { OLLAMA_BASE_URL: bridge.url, OLLAMA_MODEL: bridge.model });
let readyParsed: { allReady?: boolean; results?: Array<{ ready?: boolean }> } | null = null;
try { readyParsed = JSON.parse(readyJson.stdout ?? "") as typeof readyParsed; } catch { /* 保持 null */ }
check("就绪 --json allReady=true", readyParsed?.allReady === true);
check("就绪 --json results[0].ready=true", readyParsed?.results?.[0]?.ready === true);

// ---------------------------------------------------------------- 2) 分级诊断
hr("2 / 4  分级诊断：网络故障 ≠ 认证故障");
const srv = await startAuthRejectServer();
const authR = await runPreflight(compat(srv.url));
await srv.close();
check("401 端点 → 网络可达", authR.probe?.networkReachable === true);
check("401 端点 → authRejected=true", authR.probe?.authRejected === true);
check("401 端点 → httpStatus=401", authR.probe?.httpStatus === 401);
check("401 端点 → ready=false", authR.ready === false);
check("401 端点 → 指引修正 API Key", authR.nextSteps.some((s) => s.includes("API Key")));
check("401 端点 → 不误导去恢复服务", !authR.nextSteps.some((s) => s.includes("先恢复服务")));

const netR = await runPreflight(compat("http://127.0.0.1:1/v1"));
check("网络不可达 → networkReachable=false", netR.probe?.networkReachable === false);
check("网络不可达 → httpStatus=null", netR.probe?.httpStatus === null, `httpStatus=${String(netR.probe?.httpStatus)}`);
check("网络不可达 → 不误导去改 Key", !netR.nextSteps.some((s) => s.includes("修正 API Key")));

const nativeR = await runPreflight(compat(bridge.url, bridge.model));
check("native 端点 → ready=true", nativeR.ready === true);
check("native 端点 → toolCalling=native", nativeR.probe?.toolCalling === "native");
check("native 端点 → 无阻断项", nativeR.blockers.length === 0);

const badBridge = await startOllamaBridge("text-json");
const badR = await runPreflight(compat(badBridge.url, badBridge.model));
await badBridge.close();
check("text-json 端点 → ready=false", badR.ready === false);
check("text-json 端点 → 原生 tool_calls 被阻断", badR.blockers.some((b) => b.includes("原生 tool_calls")));

// ---------------------------------------------------------------- 3) 证据面隔离
hr("3 / 4  live 链路打通后：证据面原地不动");
// 动态触发一次「被阻断的 eval:live」：无端点 → preflight BLOCKED → 直接 exit(1)，
// 既不调 runEval 也不调 saveReport，因此绝不会写真机报告。验证阻断路径确实不污染证据面。
const liveReportPath = join(ROOT, "data/eval-live-report.json");
const beforeLive = sniffFile(liveReportPath);
const blockedLive = await cli(["eval", "--mode", "live", "--provider", "ollama"]);
const afterLive = sniffFile(liveReportPath);
check("被阻断的 eval:live 退出码非 0", blockedLive.status !== 0, `status=${blockedLive.status}`);
check("被阻断的 eval:live 未改动 live 报告", beforeLive === afterLive,
  `before=${beforeLive.slice(0, 12)} after=${afterLive.slice(0, 12)}`);
const det = JSON.parse(readFileSync(join(ROOT, "data/eval-report.json"), "utf8")) as {
  mode: string; gate: { pass: boolean }; summary: { overall: number };
};
check("确定性报告 mode 仍为 deterministic", det.mode === "deterministic");
check("确定性报告门禁仍 PASS", det.gate.pass === true);
check("确定性报告 overall 仍为 1", det.summary.overall === 1);
check("未伪造外部基准结果", !existsSync(join(ROOT, "data/benchmark/external-results.json")));

const smokePath = join(ROOT, "data/live-link-smoke.json");
check("链路自检产物已落盘", existsSync(smokePath));
if (existsSync(smokePath)) {
  const smoke = JSON.parse(readFileSync(smokePath, "utf8")) as Record<string, unknown>;
  check("产物标注非模型能力分数", smoke.isModelCapabilityScore === false);
  check("产物标注仿真端点", smoke.endpointKind === "simulated-local-bridge");
  check("产物 verdict 仍为 not-proven", smoke.verdict === "not-proven");
  check("产物含真实 HTTP 请求数", typeof smoke.httpRequests === "number" && (smoke.httpRequests as number) > 0);
  check("产物含获取真分数的命令", Array.isArray(smoke.howToGetRealScore));
}

// ---------------------------------------------------------------- 4) 阶梯不变
hr("4 / 4  证据阶梯与领先结论不变");
const benchPath = join(ROOT, "data/benchmark-report.json");
const bench = JSON.parse(readFileSync(benchPath, "utf8")) as {
  leadership?: { verdict?: string };
  ladder?: { levels?: Array<{ id: number; status: string }> };
};
check("leadership.verdict = not-proven", bench.leadership?.verdict === "not-proven");
const l4 = bench.ladder?.levels?.find((l) => l.id === 4);
check("L4 仍为 not-achieved", l4?.status === "not-achieved", `status=${l4?.status}`);

await bridge.close();

console.log("\n" + "=".repeat(84));
console.log(`  实证结果: ${passed}/${total}`);
console.log("  说明：本脚本验证的是「接入基础设施可信度」，不产生任何模型能力分数。");
console.log("=".repeat(84));
if (passed !== total) process.exitCode = 1;
