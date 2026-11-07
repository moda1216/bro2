/**
 * bro2 · 能力基准与领先度评估实证
 *
 * 核心断言不是「分数高」，而是「测量机器诚实」：
 *   - ablation 任务集已剥离配置断言，差异来自行为；
 *   - 完整 bro2 严格优于保守基线与朴素单轮；
 *   - 证据阶梯不给自己发满级：L4 未达成、领先 verdict = not-proven；
 *   - 领先声明带可证伪条件，而不是一句口号。
 */
import { join } from "node:path";
import { runAblation, stripConfigAssertions } from "../src/benchmark/ablation.ts";
import { assessEvidenceLadder } from "../src/benchmark/ladder.ts";
import { capabilityProfile, profileDelta } from "../src/benchmark/scoring.ts";
import { loadTasks } from "../src/observability/eval.ts";
import type { EvalReport } from "../src/observability/eval.ts";

const ROOT = join(import.meta.dirname ?? "", "..");
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${detail}`); }
};

console.log("=".repeat(84));
console.log("  bro2 · 能力基准实证（可证伪的领先度测量）");
console.log("=".repeat(84));

// ---- 1) 防循环论证 ----
console.log("\n【1】ablation 行为断言隔离");
const raw = loadTasks(join(ROOT, "data/evolve/train.jsonl"));
check("原始任务集含 expectedPolicy 配置断言", raw.some((t) => !!t.expectedPolicy));
const stripped = stripConfigAssertions(raw);
check("剥离后不含任何配置断言", stripped.every((t) => !("expectedPolicy" in t)));
check("剥离后行为断言完整保留", stripped.some((t) => !!t.expectRepair) && stripped.some((t) => !!t.expectGroundingReject));

// ---- 2) ablation 实测 ----
console.log("\n【2】Harness 贡献分离（真实跑 7 个变体）");
const ab = await runAblation({ root: ROOT, extraTasksPaths: [join(ROOT, "data/eval-tasks.jsonl")] });
const get = (id: string) => ab.results.find((r) => r.id === id)!;
const full = get("full");
const conservative = get("conservative");
const naive = get("naive-single-step");
check(`任务数为纯行为断言（${ab.taskCount}）`, ab.behaviorOnly && ab.taskCount >= 10);
check("完整 bro2 严格优于保守基线", full.overall > conservative.overall, `${full.overall} vs ${conservative.overall}`);
check("完整 bro2 严格优于朴素单轮", full.overall > naive.overall, `${full.overall} vs ${naive.overall}`);
check("多步工具循环是最大贡献项", (ab.fullOverall - naive.overall) > (ab.fullOverall - conservative.overall));
const positiveLoss = ab.contribution.filter((c) => c.loss > 0);
check(`至少 3 个组件有可量化贡献（实际 ${positiveLoss.length}）`, positiveLoss.length >= 3);
check("协议违规零容忍在完整配置下成立", full.profile.protocolViolations === 0);
check("消融变体覆盖完整 / 保守 / 朴素 / 4 个单策略", ab.results.length >= 7);
check("报告明确声明不是外部基准", ab.note.includes("不是外部基准"));

// ---- 3) 证据阶梯诚实性 ----
console.log("\n【3】证据阶梯与领先度声明");
const ladder = assessEvidenceLadder(ROOT);
check("共 5 级判据", ladder.levels.length === 5);
const l4 = ladder.levels.find((l) => l.id === 4)!;
check("L4 公开基准未达成（不给自己发满级）", l4.status === "not-achieved");
check("领先 verdict = not-proven", ladder.claim.verdict === "not-proven");
check("领先声明含可证伪条件", ladder.claim.falsification.includes("证伪"));
check("明确列出 ≥3 项缺口", ladder.claim.missingForIndustryLeading.length >= 3);
check("L1 由实际评测报告判定", ladder.internalEvidence.deterministicOverall !== null);
check("L2 曲线来自实际演进报告", (ladder.internalEvidence.evolveHoldoutCurve?.length ?? 0) >= 2);

// ---- 4) 评分面 ----
console.log("\n【4】能力剖面与差值");
const fake = (overall: number, steps: number): EvalReport =>
  ({ summary: { overall, byCategory: { "tool-use": overall, safety: 1 }, protocolViolations: 0, toolErrorRate: 0, avgSteps: steps } }) as unknown as EvalReport;
const p1 = capabilityProfile(fake(0.9, 3));
const p2 = capabilityProfile(fake(0.6, 5));
const d = profileDelta(p1, p2);
check("profileDelta 总体差为正", d.overall === 0.3, String(d.overall));
check("profileDelta 步数收益取反（越多越好）", d.avgSteps === 2, String(d.avgSteps));
check("imbalance 可计算", Number.isFinite(p1.imbalance));

console.log("\n" + "=".repeat(84));
console.log(`  结果: ${pass} / ${pass + fail} 通过`);
console.log("=".repeat(84));
if (fail > 0) process.exitCode = 1;
