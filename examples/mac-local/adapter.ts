/**
 * bro2 · P1 本地自治 · 24G Mac 本地推理适配器（mac-local adapter）
 * ----------------------------------------------------------------
 * 目标：把「24G 统一内存 Mac 上跑本地模型」从散落在 docs/ENDPOINT-HEALTH.md 的
 * 经验笔记，固化成一个**可验算、可证伪、可复制配置**的外置工具。
 *
 * 它做三件可核对的事（不做真机性能臆测）：
 *  1) 第一性原理内存预算：权重 = params_B × bits_per_weight / 8；KV = 2·layers·ctx·
 *     kv_heads·head_dim·2B；再加 runtime overhead。对候选模型 × 量化给出 fits/not-fits。
 *     ——必须能判出「32B F16 装不下」，否则预算模型是恒真废物（可证伪自检）。
 *  2) 两条具体后端路径的**可执行配置**：MLX (mlx_lm.server) 与 GGUF (llama_cpp.server)，
 *     各自含启动命令 + OpenAI 兼容 provider 配置片段（可直接贴进 agentos.config.json）。
 *     ——强制注入两条本项目一手教训的硬约束：n_ctx ≥ 4096（system+tools≈3700）、
 *       llama.cpp function-calling 必须 stream:false（stream:true + tool_choice:auto 抛 ValueError）。
 *  3) 断网 / 无 key 契约校验：所有 baseUrl 必须是 127.0.0.1 回环、apiKeyOptional=true、
 *     必须声明 tool_calls 预检步骤。任一条不满足 → exit 1。
 *
 * 诚实边界：本沙箱是 8GB Linux，无 Apple Silicon / MLX / GPU，无法实测 tokens/s 与
 * 量化精度损失。本工具证明的是**预算可复算 + 配置自洽 + 契约满足**，不是「跑得动/跑得快」。
 * 真机基准必须由人在 24G Mac 上按生成的命令执行并回填，属 REWRITE-BRIEF §3 一手素材缺口。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/mac-local/adapter.ts
 * 输出：data/evidence/mac-local-plan.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "data/evidence/mac-local-plan.json");
const line = (s = ""): void => process.stdout.write(s + "\n");

// ── 硬件与预算口径（可核对的常数，改这里即改结论）─────────────────────────
/** Apple Silicon 统一内存：GPU/CPU/ANE 共享，模型权重与 KV 都吃这 24G。 */
const UNIFIED_GB = 24;
/** macOS 系统 + 浏览器 + runtime 预留；保守取 4G，避免把机器跑 swap。 */
const RESERVED_GB = 4;
const USABLE_GB = UNIFIED_GB - RESERVED_GB; // 20
/** 激活缓冲 / 采样 / fragmentation 余量（经验值，写明而非藏起来）。 */
const OVERHEAD_GB = 1.5;
/** KV cache 元素字节数：f16。 */
const KV_BYTES = 2;
/** n_ctx 硬下限：本项目实测 system prompt + 工具定义 ≈ 3700 tokens（见 ENDPOINT-HEALTH §7）。 */
const MIN_CTX = 4096;

/** llama.cpp 量化位宽（bits/weight，含 scale/零头，取保守上界）。 */
const QUANT_BITS: Record<string, number> = {
  "Q4_K_M": 4.85,
  "Q5_K_M": 5.75,
  "Q8_0": 8.5,
  "F16": 16,
};

interface ModelSpec {
  id: string;
  paramsB: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  context: string;
}
/** 候选模型结构取自各模型公开 config（Qwen2.5 系列与项目既有 local-qwen* 同族）。 */
const MODELS: ModelSpec[] = [
  { id: "Qwen2.5-0.5B", paramsB: 0.5, layers: 24, kvHeads: 2, headDim: 64, context: "项目已实测基线（llama.cpp）" },
  { id: "Qwen2.5-1.5B", paramsB: 1.5, layers: 28, kvHeads: 2, headDim: 128, context: "项目已实测基线（llama.cpp）" },
  { id: "Qwen2.5-3B", paramsB: 3, layers: 36, kvHeads: 2, headDim: 128, context: "项目已实测（8GB 下 OOM，One 24G 可容纳）" },
  { id: "Qwen2.5-7B", paramsB: 7, layers: 28, kvHeads: 4, headDim: 128, context: "24G Q4 主力候选" },
  { id: "Qwen2.5-14B", paramsB: 14, layers: 48, kvHeads: 8, headDim: 128, context: "24G Q4 上限候选" },
  { id: "Qwen2.5-32B", paramsB: 32, layers: 64, kvHeads: 8, headDim: 128, context: "24G 装不下（反证用例）" },
];

interface BudgetRow {
  model: string;
  quant: string;
  weightGB: number;
  kvGB: number;
  overheadGB: number;
  totalGB: number;
  fits: boolean;
  context: string;
  formula: string;
}
function budget(m: ModelSpec, quant: string, ctx = MIN_CTX): BudgetRow {
  const bits = QUANT_BITS[quant]!;
  const weightGB = +(m.paramsB * bits / 8).toFixed(2);
  const kvGB = +(2 * m.layers * ctx * m.kvHeads * m.headDim * KV_BYTES / 1e9).toFixed(2);
  const totalGB = +(weightGB + kvGB + OVERHEAD_GB).toFixed(2);
  return {
    model: m.id, quant, weightGB, kvGB, overheadGB: OVERHEAD_GB, totalGB,
    fits: totalGB <= USABLE_GB, context: m.context,
    formula: `w=${m.paramsB}B×${bits}bit/8 + kv=2×${m.layers}×${ctx}×${m.kvHeads}×${m.headDim}×2B + oh=${OVERHEAD_GB}G`,
  };
}

// ── 生成两条后端路径的可复制配置 ──────────────────────────────────────────
interface PathPlan {
  backend: "mlx" | "llama.cpp-gguf";
  why: string;
  startCommand: string;
  providerConfig: Record<string, unknown>;
  toolCallPrecheck: string[];
  caveats: string[];
}

function mlxPlan(ctx: number): PathPlan {
  return {
    backend: "mlx",
    why: "Apple Silicon 原生 MLX，统一内存零拷贝；适合 24G Mac 上 Q4 量化推理。",
    startCommand:
      "# 需 pip install mlx-lm；模型用 mlx-community 的 4bit 转换版\n" +
      "python3.11 -m mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit " +
      `--port 11434 --ctx ${ctx} --temperature 0`,
    providerConfig: {
      type: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "mlx-community/Qwen2.5-7B-Instruct-4bit",
      apiKeyOptional: true,
      includeUsage: true,
      stream: true,
      timeoutMs: 120000,
      maxRetries: 2,
    },
    toolCallPrecheck: [
      "npm run preflight（或 provider.probe()）必须判 toolCalling=native",
      "若返回 text-json：换 chatml-function-calling 模板或在 system prompt 强引导后重测",
    ],
    caveats: [
      "mlx-lm server 的 tool_calls 支持取决于具体模型的 chat template；未在真机验证前不得当作 PASS",
      "tokens/s 与量化精度损失需真机 powermetrics + 基准回填（一手素材缺口）",
    ],
  };
}

function ggufPlan(ctx: number, maxTokens: number): PathPlan {
  return {
    backend: "llama.cpp-gguf",
    why: "llama.cpp 在 24G Mac 走 Metal；配置命令沿用项目已实测的 0.5B/1.5B 链路，仅放大 ctx/memory。",
    startCommand:
      "# 需 pip install llama-cpp-python sse-starlette starlette-context pydantic-settings\n" +
      "python3.11 -m llama_cpp.server " +
      "--model ${BRO2_LOCAL_GGUF:-$HOME/.cache/bro2-llm/qwen2.5-7b.Q4_K_M.gguf} " +
      "--model_alias qwen2.5:7b --host 127.0.0.1 --port 11434 " +
      `--n_ctx ${ctx} --n_threads 8 --n_batch 128 ` +
      "--chat_format chatml-function-calling --verbose false",
    providerConfig: {
      type: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
      apiKeyOptional: true,
      includeUsage: true,
      stream: false, // 一手教训：stream:true + tool_choice:auto 在 chatml-function-calling 下抛 ValueError
      maxTokens,
      timeoutMs: 180000,
      maxRetries: 2,
    },
    toolCallPrecheck: [
      "warmup：非流式 + tools 请求须返回规范 tool_calls（项目实测 10.3s @1.5B）",
      "probe() 必须判 toolCalling=native；text-json/unsupported 一律不得进入 live",
    ],
    caveats: [
      "stream 必须 false（ENDPOINT-HEALTH §7 已证 stream:true 工具调用零输出）",
      "n_ctx 必须 ≥ 4096；2048 撞 HTTP 400（system+tools≈3700 tokens）",
    ],
  };
}

// ── 从项目现有配置抽取已验证基线，作为对照锚点 ────────────────────────────
function readAnchors(): Array<{ name: string; baseUrl: string; model: string; stream: boolean | undefined }> {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "agentos.config.json"), "utf8")) as {
    model?: { providers?: Record<string, Record<string, unknown>> };
  };
  const providers = cfg.model?.providers ?? {};
  return Object.entries(providers)
    .filter(([name]) => name.startsWith("local-"))
    .map(([name, p]) => ({
      name,
      baseUrl: String(p.baseUrl ?? ""),
      model: String(p.model ?? ""),
      stream: p.stream as boolean | undefined,
    }));
}

// ── 契约校验：断网 + 无 key + 工具能力预检 + 流式陷阱 ──────────────────────
interface Contract {
  id: string;
  ok: boolean;
  detail: string;
}
const checks: Contract[] = [];
const check = (id: string, ok: boolean, detail: string): void => { checks.push({ id, ok, detail }); };

const plans = [mlxPlan(MIN_CTX), ggufPlan(MIN_CTX, 256)];
for (const p of plans) {
  const cfg = p.providerConfig;
  const base = String(cfg.baseUrl ?? "");
  check(`${p.backend}.loopback`, /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(base), `baseUrl=${base}`);
  check(`${p.backend}.nokey`, cfg.apiKeyOptional === true, "apiKeyOptional=true（断网/无 key 可跑）");
  check(`${p.backend}.precheck`, p.toolCallPrecheck.length >= 2, `${p.toolCallPrecheck.length} 条 tool_calls 预检`);
  if (p.backend === "llama.cpp-gguf") {
    check(`${p.backend}.nonstream`, cfg.stream === false, "stream=false（避开 chatml 流式工具陷阱）");
    check(`${p.backend}.ctx`, /--n_ctx 4096/.test(p.startCommand), "n_ctx=4096（≥3700 硬需求）");
  }
}
check("anchor.localProviders", (() => {
  const a = readAnchors();
  return a.length >= 3 && a.every((x) => /127\.0\.0\.1/.test(x.baseUrl));
})(), `${readAnchors().length} 个 local-* 锚点均为回环地址`);

// 可证伪自检：预算模型必须判出装不下的组合，否则是恒真废物
const allRows: BudgetRow[] = MODELS.flatMap((m) => Object.keys(QUANT_BITS).map((q) => budget(m, q)));
const refuted = allRows.filter((r) => !r.fits);
check("budget.falsifiable", refuted.length > 0,
  `${refuted.length} 组合判 not-fits（含 32B F16=${allRows.find((r) => r.model === "Qwen2.5-32B" && r.quant === "F16")!.totalGB}G>20G）`);
check("budget.recommends", allRows.some((r) => r.fits && r.model === "Qwen2.5-7B" && r.quant === "Q4_K_M"),
  "7B Q4_K_M fits（有可用主力候选）");

const passed = checks.filter((c) => c.ok).length;
const recommended = allRows.filter((r) => r.fits && r.quant === "Q4_K_M").sort((a, b) => b.weightGB - a.weightGB);
const report = {
  generatedAt: new Date().toISOString(),
  version: "p1-mac-local-adapter-v1",
  purpose: "24G 统一内存 Mac 本地推理：第一性原理内存预算 + 两条后端路径可复制配置 + 断网/无key契约校验",
  hardware: {
    unifiedGB: UNIFIED_GB, reservedGB: RESERVED_GB, usableGB: USABLE_GB,
    overheadGB: OVERHEAD_GB, kvBytes: KV_BYTES, minCtx: MIN_CTX,
    note: "统一内存为 CPU/GPU 共享；预留 4G 给系统，避免 swap 把 tokens/s 打崩。",
  },
  quantBits: QUANT_BITS,
  budgetTable: allRows,
  recommendedQ4: recommended,
  paths: plans,
  existingAnchors: readAnchors(),
  contracts: checks,
  summary: { total: checks.length, passed, failed: checks.length - passed },
  verdict: passed === checks.length ? "contract-green" : "contract-failed",
  honest: {
    scope: "预算可复算 + 配置自洽 + 契约满足；非真机性能证明",
    notMeasuredInSandbox: ["tokens/s", "峰值内存实测", "量化精度损失", "真机 tool_calls 通过率"],
    reason: "本沙箱 8GB Linux，无 Apple Silicon / MLX / GPU；真机基准是 REWRITE-BRIEF §3 一手素材缺口，须人工回填",
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

line("24G Mac 本地适配器 · 预算与契约校验");
line(`  可用内存 ${USABLE_GB}G（24G 统一内存 − ${RESERVED_GB}G 预留）`);
for (const r of allRows.filter((x) => x.quant === "Q4_K_M")) {
  line(`  ${r.fits ? "✓" : "✗"} ${r.model.padEnd(14)} Q4_K_M  ${String(r.totalGB).padStart(6)}G  ${r.fits ? "fits" : "not-fits"}`);
}
for (const c of checks) line(`  ${c.ok ? "✓" : "✗"} ${c.id.padEnd(28)} ${c.detail}`);
line(`  结论 ${report.verdict}  ${passed}/${checks.length}`);
line(`  ${OUT}`);
if (passed !== checks.length) process.exitCode = 1;
