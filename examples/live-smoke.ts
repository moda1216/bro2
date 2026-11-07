/**
 * bro2 · live 链路自检（拿「第一份可复现的 live 报告」，但绝不是模型能力分数）
 *
 * 为什么需要这个脚本：
 *  沙箱内无 API Key、无 Ollama / GPU，物理上拿不到真实模型能力分数。
 *  但「eval --mode live 这条链路到底能不能跑通」是可以被实证的：
 *  examples/ollama-bridge.ts 是一个进程外的真实 HTTP 服务，走完整
 *  TCP → SSE → tool_calls delta 合并 → 工具执行 → 结果回喂 → 判分 → 报告落盘。
 *  本脚本把它串起来，证明除「模型权重」外的每一环都可用。
 *
 * 诚实用途边界（写进产物，不是口头声明）：
 *  - 端点返回的是脚本化响应，分数反映「框架 + 脚本」，**不是模型智能水平**；
 *  - 产物写 data/live-link-smoke.json，绝不写 data/benchmark/external-results.json；
 *  - 不影响 leadership.verdict（仍为 not-proven），不进证据阶梯 L4；
 *  - 不覆盖 data/eval-report.json（L1 证据与确定性基线的唯一来源）。
 *
 * 真机上要拿真实分数：把 OLLAMA_BASE_URL / OPENAI_* 指向真模型，
 * 跑 `npm run preflight && npm run eval:live` → data/eval-live-report.json。
 * 见 docs/TAKEOVER.md §1。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startOllamaBridge } from "./ollama-bridge.ts";
import { createAgentOS } from "../src/index.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import { runPreflight, formatPreflight } from "../src/models/preflight.ts";
import { runEval, loadTasks } from "../src/observability/eval.ts";
import type { EvalTask } from "../src/observability/eval.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "live-link-smoke.json");

/** 专为协议仿真端点设计的链路验收任务：断言的是链路是否闭合，不是模型是否聪明。 */
const LINK_TASK: EvalTask = {
  id: "link-01",
  category: "tool-use",
  input: "调用 calc 计算 sum([7,8,15]) 并报告结果",
  expectedTools: ["calc"],
  expectedAnswer: ["30"],
  maxSteps: 4,
};

interface Assertion { label: string; ok: boolean; detail: string }
const assertions: Assertion[] = [];
function check(label: string, ok: boolean, detail: string): void {
  assertions.push({ label, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(42)} ${detail}`);
}

/** 轻量文件指纹：存在性 + 长度 + 采样哈希；用于断言「本测试运行前后某文件未被本测试改动」。 */
function sniffFile(p: string): string {
  if (!existsSync(p)) return "ABSENT";
  try {
    const buf = readFileSync(p);
    let h = 0;
    for (let i = 0; i < buf.length; i += 1009) h = (Math.imul(h, 31) + buf[i]!) >>> 0;
    return `PRESENT:${buf.length}:${h}`;
  } catch { return "UNREADABLE"; }
}

const saved = {
  base: process.env.OLLAMA_BASE_URL,
  model: process.env.OLLAMA_MODEL,
  key: process.env.OLLAMA_API_KEY,
};

// 真机 live 报告路径：本链路自检只调 runEval(live)（内部不落盘），不应改动该文件；
// 用前后指纹比对，既兼容「已有真实报告」也兼容「无报告」两种情况。
const liveReportPath = join(ROOT, "data/eval-live-report.json");
const liveReportBefore = sniffFile(liveReportPath);

const bridge = await startOllamaBridge("native");
let linkReport: Awaited<ReturnType<typeof runEval>> | undefined;
let fullReport: Awaited<ReturnType<typeof runEval>> | undefined;
let preflight: Awaited<ReturnType<typeof runPreflight>> | undefined;

try {
  process.env.OLLAMA_BASE_URL = bridge.url;
  process.env.OLLAMA_MODEL = bridge.model;
  delete process.env.OLLAMA_API_KEY; // 本地端点免认证

  console.log("=".repeat(84));
  console.log("  bro2 · live 链路自检（进程外真实 HTTP/SSE 端点）");
  console.log("=".repeat(84));
  console.log(`  endpoint = ${bridge.url}   model = ${bridge.model}`);
  console.log("");

  // ---- 0) 接入门禁 ----
  const os = createAgentOS({ root: ROOT, autoApprove: true, plugins: [] });
  const provider = os.providers.get("ollama");
  if (!(provider instanceof OpenAICompatProvider)) throw new Error("ollama provider 未注册");
  preflight = await runPreflight(provider);
  console.log(formatPreflight(preflight));
  check("preflight.ready", preflight.ready, `ready=${preflight.ready}`);
  await os.shutdown();
  if (!preflight.ready) throw new Error("预检未通过，链路自检中止");

  // ---- 1) 单任务闭环判分：证明 live 判分链路能判「通过」 ----
  console.log("\n  【1/2】链路闭环任务（live 判分）");
  linkReport = await runEval({
    tasks: [LINK_TASK], mode: "live", providerName: "ollama", k: 1, root: ROOT,
    onProgress: (l) => console.log("    " + l),
  });
  check("linkReport.mode === live", linkReport.mode === "live", `mode=${linkReport.mode}`);
  check("linkReport.strict === true", linkReport.strict === true, `strict=${linkReport.strict}`);
  check("链路任务判分通过", linkReport.runs[0]?.ok === true,
    `overall=${linkReport.summary.overall} ok=${linkReport.runs[0]?.ok}`);
  check("协议违规为 0", linkReport.summary.protocolViolations === 0,
    `protocolViolations=${linkReport.summary.protocolViolations}`);

  // ---- 2) 完整任务集：证明 19 任务全跑完不崩、跳过规则正确 ----
  console.log("\n  【2/2】完整任务集（live 链路稳定性）");
  const tasks = loadTasks(join(ROOT, "data/eval-tasks.jsonl"));
  fullReport = await runEval({ tasks, mode: "live", providerName: "ollama", k: 1, root: ROOT });
  check("全部任务产出结果", fullReport.runs.length === fullReport.summary.total,
    `runs=${fullReport.runs.length} total=${fullReport.summary.total}`);
  check("deterministicOnly 被跳过", fullReport.summary.skipped === 7,
    `skipped=${fullReport.summary.skipped}`);
  check("完整集协议违规为 0", fullReport.summary.protocolViolations === 0,
    `protocolViolations=${fullReport.summary.protocolViolations}`);
  check("strict 模式未降级到 Mock", fullReport.strict === true && fullReport.providerName === "ollama",
    `provider=${fullReport.providerName}`);

  // ---- 3) 真实 HTTP 证据 ----
  console.log("\n  【HTTP 证据】");
  const recs = bridge.records;
  check("确有真实 HTTP 请求", recs.length > 0, `requests=${recs.length}`);
  check("请求为 SSE 流式", recs.some((r) => r.stream), `stream=${recs.filter((r) => r.stream).length}`);
  check("请求携带 tools", recs.some((r) => r.hasTools), `withTools=${recs.filter((r) => r.hasTools).length}`);
  check("本地端点免认证", recs.every((r) => !r.hasAuth), `withAuth=${recs.filter((r) => r.hasAuth).length}`);
  check("结果回喂（tool 角色消息）", recs.some((r) => r.messageRoles.includes("tool")),
    `withToolResult=${recs.filter((r) => r.messageRoles.includes("tool")).length}`);

  // ---- 4) 不污染证据面 ----
  console.log("\n  【证据面隔离】");
  const det = JSON.parse(readFileSync(join(ROOT, "data/eval-report.json"), "utf8")) as {
    mode: string; gate: { pass: boolean };
  };
  check("确定性报告未被覆盖", det.mode === "deterministic" && det.gate.pass,
    `mode=${det.mode} gate=${det.gate.pass}`);
  check("未伪造外部基准结果", !existsSync(join(ROOT, "data/benchmark/external-results.json")), "external-results.json 不存在");
  const liveReportAfter = sniffFile(liveReportPath);
  check("本链路自检未改动真机 live 报告", liveReportBefore === liveReportAfter,
    `eval-live-report.json 状态未变（${liveReportBefore.slice(0, 14)} → ${liveReportAfter.slice(0, 14)}）`);

  // ---- 5) 落盘（显著标注：不是模型能力分数） ----
  const artifact = {
    kind: "live-link-smoke",
    version: 1,
    agent: "bro2",
    timestamp: new Date().toISOString(),
    endpointKind: "simulated-local-bridge",
    endpoint: bridge.url,
    isModelCapabilityScore: false,
    notARealScoreReason:
      "端点为本地 OpenAI 兼容协议仿真，返回脚本化响应；分数反映的是框架链路与脚本，不含模型智能。真实分数必须在真机上用真模型跑 eval:live。",
    verdict: "not-proven",
    preflight: { ready: preflight.ready, endpoint: preflight.endpoint, model: preflight.model },
    httpRequests: recs.length,
    linkTask: {
      overall: linkReport.summary.overall,
      ok: linkReport.runs[0]?.ok ?? false,
      strict: linkReport.strict,
      protocolViolations: linkReport.summary.protocolViolations,
    },
    fullTaskSet: {
      total: fullReport.summary.total,
      active: fullReport.runs.length,
      skipped: fullReport.summary.skipped,
      overall: fullReport.summary.overall,
      protocolViolations: fullReport.summary.protocolViolations,
    },
    assertions,
    disclaimer:
      "本产物只证明 live 链路可用，不得用于证据阶梯 L3/L4，不得用于宣布领先。完整任务集分数低是预期结果：脚本化端点无法回答真实任务。",
    howToGetRealScore: [
      "npm run doctor",
      "export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 && export OLLAMA_MODEL=qwen3:8b   # 或 OPENAI_* 指向云端",
      "npm run preflight",
      "npm run eval:live        # → data/eval-live-report.json 才是第一份真实分数",
    ],
  };
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));

  const passed = assertions.filter((a) => a.ok).length;
  console.log("\n" + "=".repeat(84));
  console.log(`  实证结果: ${passed}/${assertions.length}`);
  console.log(`  产物: ${OUT}`);
  console.log("");
  console.log("  ⚠ 这不是模型能力分数。端点为本地协议仿真，完整任务集分数低是预期结果；");
  console.log("    它的价值是证明 live 链路（门禁 → SSE → tool_calls → 工具执行 → 回喂 → 判分）真实可用。");
  console.log("    真机上把端点换成真模型，同一条命令即可得到第一份真实分数。");
  console.log("=".repeat(84));
  if (passed !== assertions.length) process.exitCode = 1;
} finally {
  if (saved.base === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = saved.base;
  if (saved.model === undefined) delete process.env.OLLAMA_MODEL; else process.env.OLLAMA_MODEL = saved.model;
  if (saved.key === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = saved.key;
  await bridge.close();
}
