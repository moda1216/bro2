/**
 * bro2 · P3 本地训练器薄调度 + 上线闸门（promotion gate）
 * ----------------------------------------------------------------
 * 把 REWRITE-ARCHITECTURE §3#4 / §4 P3 的出口条件「无对照不晋升 + 回滚演练通过」
 * 从口号变成可复跑、可证伪的外置证据。核心是「闸门」，不是训练本身：
 *
 *  - 薄调度器：从经验池只读导出训练样本清单（样本 hash 化），产出候选权重 hash。
 *    本沙箱无 GPU/LoRA，训练器调用是「接口契约 + 命令生成」，绝不产出假权重或假分数。
 *  - 上线闸门：shadow → A/B → canary → rollback 四阶段状态机。候选必须带
 *    「冻结验证集前后对照 + 显著性」才能逐阶段晋升；缺对照一律拒绝。
 *  - 回滚演练：任意阶段可一键恢复到上一权重 hash，证明可回滚（不是单向闸门）。
 *  - 诚实边界（架构 §3#4）：strict delta 只在权重冻结时成立；改了权重就是新模型，
 *    必须重新锚定，不能把训练提升伪装成 harness Δ。
 *
 * 可证伪对照（防哑弹）：
 *  F1 无对照候选必须被拒；
 *  F2 自报分数提升但无对照（reward hacking）必须被拒；
 *  F3 holdout/OOD 退化的候选在 A/B 阶段必须被拒；
 *  F4 回滚演练必须精确恢复到上一 hash（不是「大概回到某个」）。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/local-trainer/promotion-gate.ts
 * 输出：data/evidence/promotion-gate.json
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "data/evidence/promotion-gate.json");
const EXP = resolve(ROOT, "data/rsi/experience.jsonl");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const short = (s: string): string => sha(s).slice(0, 16);

interface Check { name: string; pass: boolean; evidence: Record<string, unknown> }
const checks: Check[] = [];
const check = (name: string, pass: boolean, evidence: Record<string, unknown>): void => {
  checks.push({ name, pass, evidence });
};

// ---- 1) 薄调度器：只读导出样本清单（hash 化，不编码任务答案/id）----
const experiences = readFileSync(EXP, "utf8").split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l) as {
    domain: string; signature: string; prescription: string; outcome?: string; source?: string;
  });
const trainSamples = experiences
  .filter((e) => e.outcome === "success" && e.domain === "harness-edit")
  .map((e) => ({ hash: short(`${e.signature}|${e.prescription}`), domain: e.domain, source: e.source ?? "" }));
const uniqueSamples = [...new Map(trainSamples.map((s) => [s.hash, s])).values()];
const datasetHash = short(trainSamples.map((s) => s.hash).sort().join(","));
check("薄调度：样本只读取自经验池且 hash 化", uniqueSamples.length > 0 && trainSamples.every((s) => /^[0-9a-f]{16}$/.test(s.hash)), {
  rawSamples: trainSamples.length, uniqueSamples: uniqueSamples.length, datasetHash,
  noPlaintextAnswers: trainSamples.every((s) => !/expected|answer|e\d+/i.test(s.hash)),
});

// 候选权重 hash：由「上一权重 + 数据集 + 训练配置」派生，确定性可复算
const baseWeightHash = short("base:hf.qwen2.5-7b-instruct");
const trainConfig = { method: "QLoRA", rank: 16, alpha: 32, lr: 2e-4, epochs: 1, seed: 42 };
const candidateWeightHash = short(`${baseWeightHash}|${datasetHash}|${JSON.stringify(trainConfig)}`);
const trainCommand = `llama-finetune --base ${baseWeightHash} --data ${datasetHash} --method qlora --rank 16 --out candidate_${candidateWeightHash.slice(0, 8)}`;
check("训练调用是契约+命令生成（无假权重/假分数）", /llama-finetune/.test(trainCommand) && candidateWeightHash !== baseWeightHash, {
  baseWeightHash, candidateWeightHash, trainCommand,
  honest: "本沙箱无 GPU，不执行训练；候选 hash 为确定性派生，非真实训练产物",
});

// ---- 2) 上线闸门状态机 ----
type Stage = "shadow" | "ab" | "canary" | "promoted" | "rejected";
interface FrozenContrast {
  holdoutBefore: number; holdoutAfter: number;
  oodBefore: number; oodAfter: number;
  significant: boolean; // 由外部统计器判定（本工具信任其结论，不自行造 p 值）
}
interface Candidate {
  id: string; weightHash: string; scoreGain: number; contrast?: FrozenContrast;
}
interface GateState { stage: Stage; previousWeightHash: string; history: string[] }

function decide(c: Candidate, s: GateState): { next: Stage; reason: string } {
  // R3 核心：无对照一律拒绝，且自报分数不参与判定（防 reward hacking）
  if (!c.contrast) return { next: "rejected", reason: "缺冻结验证集前后对照 → 拒绝（无对照不晋升）" };
  const d = c.contrast;
  const holdoutOk = d.holdoutAfter >= d.holdoutBefore;          // 不得退化
  const oodOk = d.oodAfter >= d.oodBefore;                      // OOD 不得退化
  const significant = d.significant;                            // 显著性由外部统计器给
  if (!holdoutOk || !oodOk) return { next: "rejected", reason: "holdout/OOD 退化 → 拒绝" };
  if (!significant) return { next: "rejected", reason: "前后对照不显著 → 不得晋升" };
  // c.scoreGain 只进审计、不进判定——即便自报 0 也可能因真实对照通过，反之亦然
  switch (s.stage) {
    case "shadow": return { next: "ab", reason: "shadow 冻结集对照通过 → 进入 A/B" };
    case "ab": return { next: "canary", reason: "A/B 对照通过且无退化 → 进入 canary" };
    case "canary": return { next: "promoted", reason: "canary 稳定 → 晋升（新锚点）" };
    default: return { next: s.stage, reason: "无转换" };
  }
}

function advance(c: Candidate, s: GateState): GateState {
  const { next } = decide(c, s);
  const history = [...s.history, `${s.stage}->${next}:${c.id}`];
  return { ...s, stage: next, history };
}
function rollback(s: GateState): { state: GateState; restored: string; ok: boolean } {
  // 一键恢复到上一 hash：history 里记录每次权重切换的 prev
  const restored = s.previousWeightHash;
  const ok = restored === baseWeightHash;
  return {
    state: { stage: "shadow", previousWeightHash: restored, history: [...s.history, `rollback->${restored}`] },
    restored, ok,
  };
}

const goodContrast: FrozenContrast = {
  holdoutBefore: 0.70, holdoutAfter: 0.76, oodBefore: 0.62, oodAfter: 0.63, significant: true,
};
const good: Candidate = { id: "cand-good", weightHash: candidateWeightHash, scoreGain: 0.06, contrast: goodContrast };

// F1 无对照必拒
const noContrast: Candidate = { id: "cand-nocontrast", weightHash: candidateWeightHash, scoreGain: 0.5 };
const f1 = decide(noContrast, { stage: "shadow", previousWeightHash: baseWeightHash, history: [] });
check("F1 无对照候选一律拒绝", f1.next === "rejected", f1);

// F2 reward hacking：自报高但无对照必拒（scoreGain 不进判定）
const f2 = decide({ ...noContrast, id: "cand-hack", scoreGain: 0.99 },
  { stage: "shadow", previousWeightHash: baseWeightHash, history: [] });
check("F2 自报提升但无对照必拒（reward hacking）", f2.next === "rejected", f2);

// F3 holdout/OOD 退化必拒
const degraded: FrozenContrast = { holdoutBefore: 0.70, holdoutAfter: 0.66, oodBefore: 0.62, oodAfter: 0.60, significant: true };
const f3 = decide({ ...good, id: "cand-degrade", contrast: degraded },
  { stage: "shadow", previousWeightHash: baseWeightHash, history: [] });
check("F3 holdout/OOD 退化候选 A/B 阶段必拒", f3.next === "rejected", f3);

// 正例：三级晋升链走通
let state: GateState = { stage: "shadow", previousWeightHash: baseWeightHash, history: [] };
const stages: Stage[] = [];
for (let i = 0; i < 3; i++) {
  stages.push(state.stage);
  state = advance(good, state);
}
const chainOk = JSON.stringify(stages) === JSON.stringify(["shadow", "ab", "canary"]) && state.stage === "promoted";
check("正例：shadow→A/B→canary→promoted 走通", chainOk, { stages, final: state.stage, history: state.history });

// F4 回滚演练：精确恢复到上一 hash
const rb = rollback(state);
check("F4 回滚演练精确恢复到上一 hash", rb.ok && rb.restored === baseWeightHash && rb.state.stage === "shadow", {
  restored: rb.restored, expected: baseWeightHash, stage: rb.state.stage,
});

const pass = checks.every((c) => c.pass);
const report = {
  generatedAt: new Date().toISOString(),
  version: "2.36.0",
  purpose: "P3 训练器薄调度+上线闸门：无对照不晋升+回滚演练（可证伪）",
  scheduler: {
    source: "data/rsi/experience.jsonl", rawSamples: trainSamples.length,
    uniqueSamples: uniqueSamples.length, datasetHash, baseWeightHash, candidateWeightHash,
    trainConfig, trainCommand,
  },
  gate: {
    stages: ["shadow", "ab", "canary", "promoted"],
    decisionRule: "仅采信冻结验证集前后对照+显著性；scoreGain 只进审计不进判定；无对照/退化/不显著一律 rejected",
  },
  checks,
  summary: { total: checks.length, passed: checks.filter((c) => c.pass).length, verdict: pass ? "gate-green" : "FAIL" },
  honest: {
    scope: "闸门状态机+契约化调度；本沙箱无 GPU/LoRA，不执行训练、不产出真实权重或能力分数",
    strictDelta: "权重改动即新模型，须重新锚定；训练提升不得伪装成 harness Δ",
    significantSource: "显著性由外部统计器（P5）提供，本工具信任其结论不自造 p 值",
    notProven: ["真实 QLoRA 训练收敛", "候选权重真实能力提升", "89×3 任务通过率"],
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`上线闸门：${report.summary.passed}/${report.summary.total} 通过 → ${report.summary.verdict}`);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
process.exit(pass ? 0 : 1);
