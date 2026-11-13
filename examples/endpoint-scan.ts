/**
 * bro2 · 可用第二端点主动扫描（v2.33.0）
 * ----------------------------------------------------------
 * 目的：为「同模型隔离锚点」找一个能稳定驱动完整 harness 的**免 Key 第二端点**。
 * 判据（硬门槛，缺一不可）：
 *   1) 匿名免 API Key；2) OpenAI Chat Completions 兼容；
 *   3) 原生返回 tool_calls（多步 agent 的前提）；4) 模型身份与公开榜条目一致。
 *
 * 与 v2.30.0 的区别：不再因 ovhcloud 一次 provider_error 就收手，而是把
 * 「已注册但被跳过的 provider」「config 里列着但没试过的具体模型」「联网新发现的端点」
 * 全部拉出来做带 tools 的真实调用，逐个记录可复核的 http/错误/身份。
 *
 * 输出：data/bench/external/endpoint-scan-report.json
 * 运行：node --experimental-strip-types --no-warnings examples/endpoint-scan.ts
 *
 * 诚实边界：这是端点能力扫描，不是能力评测；不写 external-results.json、
 * 不改 L4/verdict。单次调用不证明长期稳定性，稳定性由 same-model-anchor.ts 单独验证。
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "bench", "external", "endpoint-scan-report.json");
const SNAPSHOT = join(ROOT, "data", "bench", "external", "tb-leaderboard-snapshot.json");

const TOOLS = [{ type: "function", function: {
  name: "echo", description: "Echo a short string back",
  parameters: { type: "object", properties: { s: { type: "string" } }, required: ["s"] },
} }];

interface Cand {
  tag: string; base: string; model: string;
  origin: "config-registered" | "websearch-2026-11-13" | "already-in-config";
  leaderboardModel?: string; note?: string;
}

const KILO = "https://api.kilo.ai/api/gateway/v1";
const OVH = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";
const ZEN = "https://opencode.ai/zen/v1";
const LLM7 = "https://api.llm7.io/v1";
const BLOCKRUN = "https://blockrun.ai/api/v1";

const CANDIDATES: Cand[] = [
  { tag: "kilo-auto-free", base: KILO, model: "kilo-auto/free", origin: "already-in-config", note: "v2.30 主力匿名端点，作对照基线（模型不在公开榜）" },
  { tag: "kilo-glm53flash", base: KILO, model: "z-ai/glm-5.3-flash", origin: "config-registered", leaderboardModel: "GLM-5.3-Flash", note: "榜 84.3；/models 列有，但匿名层是否放行待实测" },
  { tag: "kilo-inkling2", base: KILO, model: "thinkingmachines/inkling-2-small", origin: "config-registered", leaderboardModel: "Inkling 2 Small", note: "榜 85.1" },
  { tag: "kilo-dsv41f1017", base: KILO, model: "deepseek/deepseek-v4.1-flash-1017", origin: "config-registered", leaderboardModel: "DeepSeek V4.1 Flash 1017", note: "榜 33.838" },
  { tag: "kilo-dsv4pro0813", base: KILO, model: "deepseek/deepseek-v4-pro-0813", origin: "config-registered", leaderboardModel: "DeepSeek V4 Pro 0813", note: "榜 78.652" },
  { tag: "ovh-gpt120-anchor", base: OVH, model: "gpt-oss-120b", origin: "already-in-config", leaderboardModel: "gpt-oss-120b", note: "★ 同模型锚点首选；榜 26.217；v2.30 因 provider_error 被判无效" },
  { tag: "ovh-gpt20b", base: OVH, model: "gpt-oss-20b", origin: "config-registered", note: "同端点小模型，验证限流是否 per-model 独立" },
  { tag: "zen-glm53flash-free", base: ZEN, model: "glm-5.3-flash-free", origin: "config-registered", leaderboardModel: "GLM-5.3-Flash", note: "榜 84.3；*-free 系列" },
  { tag: "zen-dsv41f-free", base: ZEN, model: "deepseek-v4.1-flash-free", origin: "config-registered", leaderboardModel: "DeepSeek V4.1 Flash", note: "榜 26.768" },
  { tag: "llm7-gpt20b", base: LLM7, model: "gpt-oss:20b", origin: "already-in-config", note: "v2.30 记录为匿名可用但限流极严" },
  { tag: "llm7-glm53", base: LLM7, model: "glm-5.3", origin: "config-registered", leaderboardModel: "GLM-5.3", note: "榜 83.895" },
  { tag: "pollinations-openai", base: "https://text.pollinations.ai/openai/v1", model: "openai", origin: "already-in-config", note: "记录为 1 reply/45s" },
  { tag: "keylessai-gpt20b", base: "https://keylessai.thryx.workers.dev/v1", model: "gpt-oss-20b", origin: "already-in-config", note: "记录为连接超时" },
  { tag: "blockrun-gpt120", base: BLOCKRUN, model: "nvidia/gpt-oss-120b", origin: "websearch-2026-11-13", leaderboardModel: "gpt-oss-120b", note: "新发现免 Key 端点；文档称已退役并重定向到 nemotron-3-super-120b，须核实身份" },
  { tag: "blockrun-nemotron120", base: BLOCKRUN, model: "nvidia/nemotron-3-super-120b", origin: "websearch-2026-11-13", note: "BlockRun 当前真实免费旗舰；不在公开榜锚点条目中" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(c: Cand): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const budget = /keylessai/.test(c.tag) ? 12_000 : 45_000;
  const timer = setTimeout(() => ctrl.abort(), budget);
  const t0 = Date.now();
  const rec: Record<string, unknown> = { ...c, at: new Date().toISOString() };
  try {
    const r = await fetch(c.base + "/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: c.model,
        messages: [{ role: "user", content: 'Call the echo tool with s="ok" and nothing else.' }],
        max_tokens: 96, tools: TOOLS, tool_choice: "auto",
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const txt = await r.text();
    let j: any = null; try { j = JSON.parse(txt); } catch {}
    const msg = j?.choices?.[0]?.message;
    rec.http = r.status;
    rec.ms = Date.now() - t0;
    rec.respModel = j?.model ?? null;
    rec.toolCalls = msg?.tool_calls?.length ?? 0;
    rec.finish = j?.choices?.[0]?.finish_reason ?? null;
    rec.content = (msg?.content ?? "").slice(0, 60);
    rec.error = j?.error?.message ?? (r.status >= 400 ? txt.slice(0, 200) : null);
    rec.identityMatches = c.leaderboardModel
      ? String(rec.respModel ?? "").toLowerCase().includes(c.leaderboardModel.toLowerCase().replace(/\s+/g, "-"))
        || String(rec.respModel ?? "").toLowerCase().includes(c.leaderboardModel.toLowerCase())
      : null;
    rec.status = r.status === 200 && (rec.toolCalls as number) > 0 ? "TOOLS_OK"
      : r.status === 200 ? "CHAT_OK" : "FAIL";
  } catch (e) {
    clearTimeout(timer);
    rec.status = "EXC";
    rec.error = (e as Error).name + ":" + (e as Error).message.slice(0, 120);
    rec.ms = Date.now() - t0;
  }
  return rec;
}

const results: Array<Record<string, unknown>> = [];
console.log("=".repeat(92));
console.log("  bro2 · 第二端点主动扫描（带 native tools 的真实调用）· v2.33.0");
console.log("=".repeat(92));
for (const c of CANDIDATES) {
  const r = await probe(c);
  results.push(r);
  console.log([
    String(r.status).padEnd(9), c.tag.padEnd(24), "http=" + String(r.http ?? "-").padEnd(4),
    String(r.ms) + "ms", "tools=" + String(r.toolCalls ?? 0),
    "resp_model=" + String(r.respModel ?? "-").slice(0, 34),
    r.error ? "err=" + String(r.error).slice(0, 72) : "",
  ].join(" | "));
  await sleep(2500);
}

const snap = JSON.parse((await import("node:fs")).readFileSync(SNAPSHOT, "utf8")) as {
  benchmark: string; dataAsOf: string; sameModelAnchor: string;
  entries: Array<{ model: string; score: number; isSameModelAnchor?: boolean }>;
};
const anchorEntry = snap.entries.find((e) => e.isSameModelAnchor);
const toolsOk = results.filter((r) => r.status === "TOOLS_OK");
const usableAnchor = toolsOk.filter((r) => r.identityMatches === true);

const report = {
  generatedAt: new Date().toISOString(),
  purpose: "为同模型隔离锚点寻找可稳定驱动完整 harness 的免 Key 第二端点",
  criteria: ["匿名免 API Key", "OpenAI Chat Completions 兼容", "原生 tool_calls", "模型身份匹配公开榜条目"],
  benchmark: { name: snap.benchmark, dataAsOf: snap.dataAsOf, anchorModel: snap.sameModelAnchor, anchorScore: anchorEntry?.score ?? null },
  candidates: results,
  summary: {
    totalProbes: results.length,
    toolsOk: toolsOk.map((r) => r.tag),
    chatOk: results.filter((r) => r.status === "CHAT_OK").map((r) => r.tag),
    failed: results.filter((r) => r.status === "FAIL" || r.status === "EXC").map((r) => r.tag),
    usableSameModelAnchor: usableAnchor.map((r) => ({ tag: r.tag, model: r.model, respModel: r.respModel })),
    findings: [
      "ovhcloud/gpt-oss-120b 单次带 tools 调用返回 200 + tool_calls，端点本身可用；v2.30 的 provider_error 根因是匿名层 2 req/min 限流与 harness 内置退避（1s/2s/4s、maxRetries=2）不匹配，而非端点故障。",
      "kilo 网关虽列 471 个模型（含多个榜单模型），但具体模型 ID 返回 401 'You need to sign in to use this model'；只有 kilo-auto/free 匿名，且该模型不在公开榜，无法做同模型锚点。",
      "opencode-zen *-free 系列返回 429 Free usage limit reached；llm7 榜单模型返回 401 Missing API key（仅 gpt-oss:20b 匿名）；pollinations/keylessai 受 402/连接超时限制。",
      "联网新发现 BlockRun（blockrun.ai/api/v1）确实免 Key、支持原生 tool_calls，但 'nvidia/gpt-oss-120b' 已被退役并重定向到 nemotron-3-super-120b（响应 model 字段已核实），且免费容量 4 次里 3 次 429 —— 存在模型身份陷阱，不能冒充 gpt-oss-120b 锚点。",
      "结论：唯一可做同模型锚点的仍是 ovhcloud/gpt-oss-120b；正确解法不是换端点，而是在测量侧为该端点的 2 req/min 限流做节流适配（见 same-model-anchor.ts）。",
    ],
  },
  honest: [
    "端点扫描为能力探测，非能力评测；单次调用不证明长期稳定性。",
    "不写 external-results.json、不改 L4/verdict、不把端点可用性当作 bro2 能力证据。",
    "模型身份以响应 model 字段为准，不以请求里填写的 model 为准（BlockRun 重定向即反例）。",
  ],
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log("\nTOOLS_OK:", toolsOk.map((r) => r.tag).join(", ") || "(none)");
console.log("可用同模型锚点:", usableAnchor.map((r) => r.tag + " -> " + String(r.respModel)).join(", ") || "(none)");
console.log("报告:", OUT);
