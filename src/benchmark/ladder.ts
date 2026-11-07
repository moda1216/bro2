/**
 * bro2 · 领先度证据阶梯（Evidence Ladder · 写保护尺子）
 *
 * 为什么需要它：「能力处于领先水平」是一个**外部比较命题**，
 * 内部评测的 100% 只能证明框架正确，不能证明领先。本模块把"领先"拆成
 * 5 级可证伪判据，并从**实际落盘的报告**自动判定当前到了哪一级，
 * 而不是由开发者口头宣称。
 *
 * 判定只读证据文件，评分逻辑在 scoring.ts，外部结果校验在 external.ts，
 * 三者同在 PROTECTED_FILES 写保护面内；任何 RSI / meta RSI 候选都无法修改自己的尺子
 * （对应 RSI 文献的 objective hacking）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalReport } from "../observability/eval.ts";
import type { EvolveReport, MetaState } from "../rsi/types.ts";
import type { MetaReport } from "../rsi/meta.ts";
import {
  loadExternalResults, EXTERNAL_REQUIRED, EXTERNAL_OPTIONAL, EXTERNAL_FORBIDDEN_FIELDS,
} from "./external.ts";
import type { ExternalRejection } from "./external.ts";

export type LevelStatus = "achieved" | "partial" | "not-achieved";

export interface EvidenceLevel {
  id: number;
  name: string;
  criterion: string;
  status: LevelStatus;
  evidence: string[];
  gap: string;
}

/** 外部证据校验摘要：让「为什么 L4 没升级」可逐条复核，而不是一句"未提供"。 */
export interface ExternalEvidenceSummary {
  source: string;
  submitted: number;
  accepted: number;
  rejected: ExternalRejection[];
  fileErrors: string[];
  /** 已采纳的基准名（去重） */
  benchmarks: string[];
}

export interface LeadershipClaim {
  /**
   * 行业领先是否被证明。当前恒为 not-proven。
   * 自动判定绝不产生「已证明」：即使导入了通过校验的外部基准结果，L4 也只到 partial，
   * 仍需与同期开源 harness 对照、给出置信区间并由第三方独立复核；
   * 该结论必须由人显式给出，不能由数据源自带或由程序自封。
   */
  verdict: "not-proven";
  headline: string;
  achievedLevels: number[];
  missingForIndustryLeading: string[];
  /** 如何证伪本声明：给出可执行的检验方式，而不是留一句口号 */
  falsification: string;
  /** 通过校验的外部结果数（不是提交数；被拒记录不计入） */
  externalBenchmarksImported: number;
}

export interface LadderAssessment {
  version: 1;
  agent: "bro2";
  timestamp: string;
  levels: EvidenceLevel[];
  claim: LeadershipClaim;
  /** 外部证据入口的校验结果，供报告与实证脚本复核 */
  externalValidation: ExternalEvidenceSummary;
  /** 已落盘的内部证据摘要，全部来自报告文件，不含主观评价 */
  internalEvidence: {
    deterministicOverall: number | null;
    deterministicGate: boolean | null;
    protocolViolations: number | null;
    evolveTrainCurve: number[] | null;
    evolveHoldoutCurve: number[] | null;
    evolveIntegrityOk: boolean | null;
    metaScoreBefore: number | null;
    metaScoreAfter: number | null;
    ablationVariants: number | null;
    externalBenchmarks: number;
  };
}

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

function monotone(curve: number[] | null): boolean {
  if (!curve || curve.length < 2) return false;
  for (let i = 1; i < curve.length; i += 1) if (curve[i]! < curve[i - 1]!) return false;
  return curve.at(-1)! > curve[0]!;
}

/**
 * 从实际报告文件判定证据等级。
 * 每一级都写明判据、读到的证据文件、以及尚未满足的缺口 —— 可复核、可证伪。
 *
 * 外部证据只认 data/benchmark/external-results.json 且必须通过 external.ts 校验：
 * bro2 自己生成的 benchmark-report.json 属于内部产物，不计入外部证据（防止自写自证）。
 */
export function assessEvidenceLadder(root: string): LadderAssessment {
  const ev = readJson<EvalReport>(join(root, "data/eval-report.json"));
  const evo = readJson<EvolveReport>(join(root, "data/evolve-report.json"));
  const meta = readJson<MetaReport>(join(root, "data/meta-report.json"));
  const bench = readJson<{ ablation?: unknown[] }>(join(root, "data/benchmark-report.json"));

  const externalValidation = loadExternalResults(join(root, "data/benchmark/external-results.json"));
  const externalCount = externalValidation.accepted.length;
  const ablationVariants = bench?.ablation?.length ?? null;

  const deterministicOverall = ev?.summary.overall ?? null;
  const deterministicGate = ev?.gate.pass ?? null;
  const protocolViolations = ev?.summary.protocolViolations ?? null;

  const validationSummary: ExternalEvidenceSummary = {
    source: "data/benchmark/external-results.json",
    submitted: externalValidation.submitted,
    accepted: externalValidation.accepted.length,
    rejected: externalValidation.rejected,
    fileErrors: externalValidation.fileErrors,
    benchmarks: [...new Set(externalValidation.accepted.map((r) => r.benchmark))],
  };

  // ---- L0 结构连通 ----
  const l0: EvidenceLevel = {
    id: 0,
    name: "结构连通 / 无空接口",
    criterion: "各层模块存在且可运行；确定性评测报告已落盘并通过门禁",
    status: ev ? "achieved" : "not-achieved",
    evidence: ev ? ["data/eval-report.json（19 任务全链路真实执行）", "tests/*.test.ts", "examples/verify.ts 结构自检"] : [],
    gap: ev ? "无" : "缺少评测报告",
  };

  // ---- L1 确定性行为回归 ----
  const l1Ok = !!ev && ev.mode === "deterministic" && ev.gate.pass &&
    ev.summary.overall >= 0.85 && ev.summary.protocolViolations === 0;
  const l1: EvidenceLevel = {
    id: 1,
    name: "确定性行为回归（框架能力）",
    criterion: "脚本化模型下 overall ≥ 0.85、门禁 PASS、未配对 tool_call = 0",
    status: l1Ok ? "achieved" : "partial",
    evidence: ev ? [`overall=${ev.summary.overall}`, `gate=${ev.gate.pass}`, `协议违规=${ev.summary.protocolViolations}`] : [],
    gap: "这一级只证明 Harness 调度/治理/协议正确，模型智能不参与评分",
  };

  // ---- L2 有界自我改进 ----
  const l2Ok = !!evo && evo.integrity.ok && monotone(evo.trainCurve) && monotone(evo.holdoutCurve) && evo.promoted > 0;
  const l2: EvidenceLevel = {
    id: 2,
    name: "有界可验证自我改进（L3 RSI）",
    criterion: "train 与 holdout 曲线单调提升、保护面未变更、至少 1 次晋升、有害候选被拒",
    status: l2Ok ? "achieved" : "partial",
    evidence: evo ? [
      `train ${evo.trainCurve.join("→")}`,
      `holdout ${evo.holdoutCurve.join("→")}`,
      `晋升 ${evo.promoted} / 拒绝 ${evo.rejected} / 拦截 ${evo.blocked}`,
      `保护面 ${evo.integrity.ok ? "未变更" : "被修改"}`,
    ] : [],
    gap: "收益只在该自建评测域内成立；基座模型冻结，不等于模型变强",
  };

  // ---- L3 meta RSI + ablation 对照 ----
  const metaOk = !!meta && meta.promoted > 0 && meta.integrity.ok &&
    meta.finalFitness.score > meta.baselineFitness.score;
  const ablationOk = ablationVariants !== null && ablationVariants >= 3;
  const l3: EvidenceLevel = {
    id: 3,
    name: "meta RSI + Harness 贡献分离",
    criterion: "改进机制自身在冻结 fitness 上单调提升；ablation 量化各组件贡献；跨 provider 对比接口就绪",
    // 即使内部证据齐备，只要没有真实模型矩阵就只能是 partial —— 不给自己发满级
    status: metaOk && ablationOk ? "partial" : ablationOk ? "partial" : "not-achieved",
    evidence: [
      ...(meta ? [`meta score ${meta.baselineFitness.score} → ${meta.finalFitness.score}（能力不退化）`] : []),
      ...(ablationVariants ? [`ablation 变体 ${ablationVariants} 个`] : []),
      "Ollama / OpenAI 兼容端点协议级实证 examples/ollama-check.ts",
    ],
    gap: "跨 provider 对比只有协议级仿真，尚无真实模型矩阵；ablation 是内部对照而非外部基准",
  };

  // ---- L4 公开基准对齐 ----
  const l4: EvidenceLevel = {
    id: 4,
    name: "公开基准对齐 / 行业领先",
    criterion: "在 BFCL / τ-bench / GAIA / SWE-bench 类公开基准上，与同期开源 harness 做第三方可复现对比并胜出",
    status: externalCount > 0 ? "partial" : "not-achieved",
    evidence: [
      `外部结果校验：提交 ${validationSummary.submitted} / 采纳 ${validationSummary.accepted} / 拒绝 ${validationSummary.rejected.length} / 文件错误 ${validationSummary.fileErrors.length}`,
      ...(validationSummary.benchmarks.length ? [`已采纳基准：${validationSummary.benchmarks.join(" / ")}`] : []),
      ...validationSummary.fileErrors.map((e) => `文件级错误：${e}`),
    ],
    gap: externalCount > 0
      ? "通过格式校验的外部结果只能把 L4 提到 partial；仍需注明模型版本与评分脚本、与同期开源 harness 对照、并由第三方独立复核。verdict 不会因导入而自动改变"
      : "沙箱无 GPU / 无 Ollama / 无 API Key，未跑任何公开基准；未提供通过校验的外部结果文件",
  };

  const levels = [l0, l1, l2, l3, l4];
  const achieved = levels.filter((l) => l.status === "achieved").map((l) => l.id);

  const claim: LeadershipClaim = {
    verdict: "not-proven",
    headline:
      "bro2 在自建确定性域内实现了可验证的多轮自我改进与 meta 改进，" +
      "并在内部 ablation 中量化了各 Harness 组件的贡献；" +
      "但『行业领先』是外部比较命题，在缺少公开基准与真实模型对比的前提下未被证明。" +
      "外部结果导入通道已做严格校验，伪造或格式不完整的记录不能提升证据等级。",
    achievedLevels: achieved,
    missingForIndustryLeading: [
      "接入 BFCL / τ-bench / GAIA / SWE-bench 类公开基准并取得可复现分数",
      "≥3 个真实模型（本地 Ollama + 至少 2 个云端）的跨 provider 对比矩阵",
      "与同期开源 harness 在同一任务、同一模型、同一预算下的对照实验",
      "第三方独立复现与置信区间 / 多次重复，排除对自建任务集过拟合",
    ],
    falsification:
      "本声明可被以下任一结果证伪：① 在上述公开基准上 bro2 未超过同期开源 harness；" +
      "② 换用 holdout 之外的真实模型后能力增益消失；③ 去掉 RSI 后分数不变（说明改进来自任务集过拟合而非机制）。" +
      "对应命令：npm run benchmark（内部对照）、npm run eval:live（真实模型）、导入 data/benchmark/external-results.json（外部基准）。",
    externalBenchmarksImported: externalCount,
  };

  return {
    version: 1,
    agent: "bro2",
    timestamp: new Date().toISOString(),
    levels,
    claim,
    externalValidation: validationSummary,
    internalEvidence: {
      deterministicOverall,
      deterministicGate,
      protocolViolations,
      evolveTrainCurve: evo?.trainCurve ?? null,
      evolveHoldoutCurve: evo?.holdoutCurve ?? null,
      evolveIntegrityOk: evo?.integrity.ok ?? null,
      metaScoreBefore: meta?.baselineFitness.score ?? null,
      metaScoreAfter: meta?.finalFitness.score ?? null,
      ablationVariants,
      externalBenchmarks: externalCount,
    },
  };
}

/**
 * 供外部基准结果导入的 schema 说明。
 * required / optional / forbidden 与 external.ts 的校验器**同源**，
 * 避免"文档承诺校验、实现却不校验"的漂移（上一版的真实缺陷）。
 */
export const EXTERNAL_RESULT_SCHEMA = {
  required: [...EXTERNAL_REQUIRED],
  optional: [...EXTERNAL_OPTIONAL],
  forbidden: [...EXTERNAL_FORBIDDEN_FIELDS],
  constraints: {
    date: "YYYY-MM-DD 真实日历日期，且不得晚于今天",
    score: "[0,1] 内的有限数值",
    reproducibleCommand: "非空可执行命令，不接受 N/A / TODO 等占位符",
    confidenceInterval: "[lo,hi]，两端 ∈ [0,1] 且 lo ≤ hi",
    unknownFields: "拒绝：字段必须严格落在 required ∪ optional 白名单内",
  },
  note: "写入 data/benchmark/external-results.json 的 { results: [...] }；未提供即视为未导入。",
} as const;

export { validateExternalResult, loadExternalResults } from "./external.ts";
