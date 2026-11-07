/**
 * bro2 · meta RSI 实证
 *
 * 验证三件事：
 *  1) 元层写保护：任何试图放松 holdout 严格晋升 / 改验证面 / 越界的候选被 critical 拦截；
 *  2) 冻结 fitness：公式可复现，且「能力退化」一定被拒（防止用效率换正确性）；
 *  3) 正式报告：若已跑过 meta，验证单调提升、能力不退化、保护面未变更。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkMetaPatch, applyMetaPatch, proposeMetaCandidates, metaPaths,
} from "../src/rsi/index.ts";
import { DEFAULT_META } from "../src/rsi/types.ts";
import type { MetaPatch, MetaReport } from "../src/rsi/index.ts";
import { measureMetaFitness, metaPromotionOk } from "../src/benchmark/scoring.ts";
import type { EvolveReport } from "../src/rsi/types.ts";

const ROOT = join(import.meta.dirname ?? "", "..");
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${detail}`); }
};

const mk = (key: keyof typeof DEFAULT_META, to: unknown, from?: unknown): MetaPatch => ({
  id: `test-${String(key)}`,
  key: key as MetaPatch["key"],
  from: from ?? DEFAULT_META[key as keyof typeof DEFAULT_META],
  to,
  reason: "测试",
});

const synth = (curve: number[], evalRuns: number, promoted: number): EvolveReport =>
  ({
    version: 1, agent: "bro2", timestamp: "", dryRun: true, level: "", taskSetHash: "",
    integrity: { ok: true, files: 0, changed: [] }, generations: [],
    promoted, rejected: 0, blocked: 0, incidents: 0, evalRuns,
    trainCurve: curve, holdoutCurve: curve,
    finalState: { version: 1, budget: { compactTokens: 0, loopDetectionThreshold: 0, maxSteps: 0, maxConcurrentTools: 0, toolTimeoutMs: 0 }, policy: { loopDetection: "exact", malformedArgs: "fail", grounding: "off", compaction: "truncate", parallel: "fifo" }, skillOverlays: {} },
    finalStrategy: { version: 1, operatorWeights: {}, editBudget: 3, maxGenerations: 6, plateauPatience: 2, maxEvalRuns: 40, maxDrift: 8, rejectedEdits: [] },
    meta: DEFAULT_META, ledgerPath: "", stoppedBy: "",
  }) as EvolveReport;

console.log("=".repeat(84));
console.log("  bro2 · meta RSI 实证（写保护 / 冻结 fitness / 单调晋升）");
console.log("=".repeat(84));

// ---- 1) 元层写保护 ----
console.log("\n【1】元层 tripwire");
const dangers: Array<[string, MetaPatch, string]> = [
  ["放松 holdout 严格晋升（lenient）", mk("promotionStrictness", "lenient"), "白名单"],
  ["伪造验证面字段", { id: "x", key: "evalThreshold" as MetaPatch["key"], from: 1, to: 0, reason: "作弊" }, "验证面"],
  ["数值越界", mk("plateauPatience", 99), "越界"],
  ["from 与当前状态不一致", mk("evidenceLimit", 8, 999), "不一致"],
  ["未知枚举值", mk("candidateOrder", "whatever"), "白名单"],
];
for (const [name, p, expect] of dangers) {
  const r = checkMetaPatch(p, DEFAULT_META);
  check(`拦截 ${name}`, !r.ok && r.severity === "critical" && r.reason.includes(expect), r.reason);
}
const legal = checkMetaPatch(mk("plateauPatience", 1), DEFAULT_META);
check("合规元候选通过", legal.ok);
check("合规候选明确标注不触碰验证层级", legal.reason.includes("不触碰验证层级"));

// ---- 2) apply + 候选生成 ----
console.log("\n【2】元状态与候选");
const next = applyMetaPatch(DEFAULT_META, mk("plateauPatience", 1));
check("单原子改动生效", next.plateauPatience === 1 && next.evidenceLimit === DEFAULT_META.evidenceLimit);
check("白名单解析回退非法值", applyMetaPatch(DEFAULT_META, mk("candidateOrder", "bogus" as never)).candidateOrder === "weight");
const cands = proposeMetaCandidates(DEFAULT_META);
check(`生成 ${cands.length} 个单原子元候选`, cands.length >= 5);
check("已生效维度不再重复提议", proposeMetaCandidates(next).every((p) => p.key !== "plateauPatience"));
check("所有候选都不指向验证面", cands.every((p) => !/gate|threshold|eval|task|holdout|score/i.test(p.key)));

// ---- 3) 冻结 fitness ----
console.log("\n【3】冻结 fitness");
const base = measureMetaFitness(synth([0.5, 0.75, 1, 1], 22, 3));
const faster = measureMetaFitness(synth([0.5, 0.75, 1], 18, 3));
const degraded = measureMetaFitness(synth([0.5, 0.75, 0.8], 10, 1));
check("fitness 可复现", measureMetaFitness(synth([0.5, 0.75, 1, 1], 22, 3)).score === base.score);
check("更少 eval 达到同样终点 → 效率更高", faster.score > base.score, `${faster.score} vs ${base.score}`);
check("能力退化被硬拒", !metaPromotionOk(base, degraded, true), `finalHoldout ${degraded.finalHoldout}`);
check("保护面破损被硬拒", !metaPromotionOk(base, faster, false));
check("效率提升且能力不退化 → 允许晋升", metaPromotionOk(base, faster, true));
check("fitness 权重固定（60% 能力 + 40% 效率）", Math.abs(base.score - (0.6 * 1 + 0.4 * Math.min(1, base.efficiency))) < 1e-3);

// ---- 4) 正式报告 ----
console.log("\n【4】正式 meta 报告");
const reportPath = metaPaths(ROOT).report;
if (!existsSync(reportPath)) {
  console.log("  · 尚未运行正式 meta（npm run meta），跳过报告断言");
} else {
  const r = JSON.parse(readFileSync(reportPath, "utf8")) as MetaReport;
  check("保护面未变更", r.integrity.ok);
  check("至少 1 次元晋升", r.promoted >= 1);
  check("fitness 单调提升", r.finalFitness.score > r.baselineFitness.score, `${r.baselineFitness.score} → ${r.finalFitness.score}`);
  check("能力不退化", r.finalFitness.finalHoldout >= r.baselineFitness.finalHoldout);
  const ledger = metaPaths(ROOT).ledger;
  check("元账本只增且含 genesis", existsSync(ledger) && readFileSync(ledger, "utf8").includes('"genesis"'));
  check("声明为可证伪而非自封领先", r.claim.includes("不是模型变聪明"));
  check("最终元状态已落盘", existsSync(metaPaths(ROOT).state));
}

console.log("\n" + "=".repeat(84));
console.log(`  结果: ${pass} / ${pass + fail} 通过`);
console.log("=".repeat(84));
if (fail > 0) process.exitCode = 1;
