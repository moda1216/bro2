/**
 * bro2 · P5 独立第三方复核统计骨架（third-party review）
 * ----------------------------------------------------------------
 * 把 REWRITE-ARCHITECTURE §4 P5 的出口条件「inter-rater 一致、统计显著」如实落地。
 * 关键诚实前提：当前真实评测只有 9/267 条（partial），且无独立第三方标注——
 * 因此本工具**绝不宣称统计显著或能力领先**，而是提供可复跑的统计骨架 + 功效审计：
 *
 *  - inter-rater：Cohen's kappa 衡量两个评分器一致性。真实数据用 verifier 判定
 *    （verifyNote 的 rc=0 视为通过）与落盘 reward 的一致性；另注入两个合成评分器
 *    （全一致 / 全相反）验证 kappa 边界（防止一个恒返回正值的假 kappa）。
 *  - 配对显著性：McNemar 检验（精确二项）用于配对二分类前后对照，给出可复算 p 值。
 *  - 功效审计：按真实 n=9 计算「检出中等效应所需样本量」，如实声明当前功效不足。
 *
 * 可证伪对照：
 *  F1 两评分器完全一致 → kappa 必须 = 1；
 *  F2 两评分器完全相反（二分类）→ kappa 必须为负；
 *  F3 真实 n=9 < 所需样本 → 必须判「功效不足，不得宣称显著」。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/third-party-review.ts
 * 输出：data/evidence/third-party-review.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/evidence/third-party-review.json");
const RESULTS = resolve(ROOT, "data/bench/external/tb21-full-results.jsonl");

interface Check { name: string; pass: boolean; evidence: Record<string, unknown> }
const checks: Check[] = [];
const check = (name: string, pass: boolean, evidence: Record<string, unknown>): void => {
  checks.push({ name, pass, evidence });
};

/** Cohen's kappa（二分类）。两评分器对 n 个样本各判 0/1。 */
function cohensKappa(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return NaN;
  const n = a.length;
  let agree = 0;
  const aCount = [0, 0], bCount = [0, 0];
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    aCount[a[i]!]++; bCount[b[i]!]++;
  }
  const po = agree / n;
  const pe = (aCount[0] * bCount[0] + aCount[1] * bCount[1]) / (n * n);
  if (Math.abs(1 - pe) < 1e-12) return po === 1 ? 1 : 0; // 退化：全同侧
  return (po - pe) / (1 - pe);
}

/** McNemar 精确二项检验（配对 b vs c），返回双侧 p 值。 */
function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // 双侧 p = 2 * P(X <= k), X~Bin(n, 0.5)
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.pow(0.5, n) * binomial(n, i);
  return Math.min(1, 2 * tail);
}
function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i;
  return r;
}

// ---- 1) 读真实评测数据 ----
const allRows = readFileSync(RESULTS, "utf8").split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l) as {
    task: string; repeat: number; status: string; reward: number; verifyNote: string;
  });
// 只数 status=ok 的有效完成样本；error/prepare-fail 不计入统计口径，防止把失败当样本误报功效足够
const rows = allRows.filter((r) => r.status === "ok");
const n = rows.length;

// 评分器 A：verifier 判定（verifyNote 的 rc=0 → 通过=1）
const verifier = rows.map((r) => (/rc=0\b/.test(r.verifyNote) ? 1 : 0));
// 评分器 B：落盘 reward（二值化）
const rewardBits = rows.map((r) => (r.reward > 0 ? 1 : 0));
const kappaReal = cohensKappa(verifier, rewardBits);
const agreement = verifier.filter((v, i) => v === rewardBits[i]).length / (n || 1);

// ---- F1/F2 kappa 边界（可证伪）----
const kSame = cohensKappa([0, 1, 0, 1, 1, 0], [0, 1, 0, 1, 1, 0]);
const kOpposite = cohensKappa([0, 0, 1, 1, 0, 1], [1, 1, 0, 0, 1, 0]);
check("F1 完全一致评分器 kappa=1", Math.abs(kSame - 1) < 1e-9, { kappa: kSame });
check("F2 完全相反评分器 kappa<0", kOpposite < 0, { kappa: kOpposite });

// ---- 2) McNemar：verifier 与 reward 不一致的配对方向 ----
let b = 0, c = 0; // b=verifier通过但reward=0, c=verifier失败但reward=1
for (let i = 0; i < n; i++) {
  if (verifier[i] === 1 && rewardBits[i] === 0) b++;
  if (verifier[i] === 0 && rewardBits[i] === 1) c++;
}
const pMcNemar = mcnemarExact(b, c);
check("McNemar p 值可复算（0..1）", pMcNemar >= 0 && pMcNemar <= 1, {
  b, c, p: Number(pMcNemar.toFixed(4)),
});

// ---- 3) 功效审计：真实 n 远小于检出中等效应所需 ----
// 检出 p1=0.5 vs p2=0.75（中等效应 h≈0.5）双侧 α=0.05, power=0.8 约需 n≈64/组
const requiredNPerGroup = 64;
const sufficient = n >= requiredNPerGroup;
check("F3 真实 n 不足必须声明功效不足", !sufficient && n < requiredNPerGroup, {
  actualN: n, requiredNPerGroup: 64, sufficient,
  conclusion: sufficient ? "可评估显著性" : "功效不足，不得宣称显著",
});

const pass = checks.every((c) => c.pass);
const report = {
  generatedAt: new Date().toISOString(),
  version: "2.36.0",
  purpose: "P5 统计骨架：inter-rater kappa + McNemar + 功效审计（可证伪，如实声明 partial）",
  data: {
    source: "data/bench/external/tb21-full-results.jsonl",
    totalRows: allRows.length, excludedNonOk: allRows.length - n,
    actualRows: n, plannedRows: 267, coverage: Number((n / 267).toFixed(4)),
    counting: "只数 status=ok；error/prepare-fail 不计入样本，防止误报功效足够",
  },
  interRater: {
    raterA: "verifier 判定（verifyNote rc=0→通过）",
    raterB: "落盘 reward（>0→通过）",
    kappa: Number.isNaN(kappaReal) ? null : Number(kappaReal.toFixed(4)),
    rawAgreement: Number(agreement.toFixed(4)),
    boundary: { identicalKappa: kSame, oppositeKappa: kOpposite },
  },
  significance: {
    test: "McNemar 精确二项（配对）", discordant: { b, c },
    p: Number(pMcNemar.toFixed(4)),
    alpha: 0.05,
    significant: pMcNemar < 0.05 && sufficient,
    guard: "即使 p<0.05，样本不足时也不宣称显著",
  },
  power: {
    actualN: n, requiredNPerGroup: 64, sufficient,
    effectAssumption: "p1=0.5 vs p2=0.75（中等效应），双侧 α=0.05, power=0.8",
  },
  checks,
  summary: { total: checks.length, passed: checks.filter((c) => c.pass).length, verdict: pass ? "stats-skeleton-green" : "FAIL" },
  honest: {
    scope: "统计原语正确性 + 真实 partial 数据的功效审计；kappa/p 值均为可复算数字，不是能力结论",
    noThirdParty: "无独立第三方标注；verifier 与 reward 非真正独立评分者，kappa 仅作一致性体检",
    coverage: `有效完成 ${n}/267（总行 ${allRows.length}，剔除 ${allRows.length - n} 条非 ok；partial），任何榜单分数/显著性均不成立`,
    notProven: ["独立第三方复核一致", "统计显著性", "89×3 全量完成", "能力领先或 L4"],
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`统计骨架：${report.summary.passed}/${report.summary.total} 通过 → ${report.summary.verdict}`);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
console.log(`  有效样本 ${n}/267（总行 ${allRows.length}，剔除 ${allRows.length - n} 条非 ok），kappa=${report.interRater.kappa}，功效=${sufficient ? "足够" : "不足"}`);
process.exit(pass ? 0 : 1);
