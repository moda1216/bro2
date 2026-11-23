/**
 * bro2 · P0 证据环 · 独立证据重算（inter-rater reliability）
 * ----------------------------------------------------------------
 * 目的：把「水位曲线」从「运行时自报」变成「独立可复核」。
 *
 * 关键设计——**裁判外置**：本脚本刻意不 import 任何运行时尺子
 * （velocitySnapshotFrom / buildWatermark / VelocityLedger 一律不引用），
 * 而是用零依赖 TypeScript 从原始只增账本 data/rsi/velocity.jsonl 独立重算：
 *   - 冻结判据常量在本脚本内**重新声明**（MIN_SAMPLES / TREND_EPSILON / IPA 公式），
 *     与 src/rsi/velocity.ts 口径一致但代码路径独立；
 *   - 对「运行时生成的 data/rsi/watermark.json」逐字段交叉对照。
 *
 * 可信逻辑：若运行时尺子被篡改（改松阈值 / 改 IPA 公式 / 采信自报分），
 * 独立重算值与 watermark.json 就会出现分歧 → 本脚本报 FAIL。
 * 这正是 REWRITE-BRIEF §6「进化曲线由独立脚本从原始数据重算」的落地。
 *
 * 只读：不写账本、不写 watermark.json，仅产出独立报告 data/evidence/recompute-report.json。
 * 零运行时依赖。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = resolve(ROOT, "data/rsi/velocity.jsonl");
const WATERMARK = resolve(ROOT, "data/rsi/watermark.json");
const OUT = resolve(ROOT, "data/evidence/recompute-report.json");

// —— 冻结判据（独立重声明；改动此处即视为改尺子，须与 src/rsi/velocity.ts 同步评审）——
const MIN_SAMPLES = 6;
const TREND_EPSILON = 0.05;

interface Attempt {
  seq: number; ts: string; attempts: number; experienceHits: number;
  firstTryHit: boolean; improvement: number; probesAvoided: number;
  usedFallback: boolean; protocolViolations: number;
}

type Trend = "accelerating" | "decelerating" | "flat" | "insufficient-data";

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const ipa = (rows: Attempt[]): number => {
  const attempts = rows.reduce((a, r) => a + r.attempts, 0);
  return attempts === 0 ? 0 : rows.reduce((a, r) => a + r.improvement, 0) / attempts;
};

/** 独立判定：输入原始账本，输出趋势（与运行时同判据、不同实现）。 */
function independentTrend(records: Attempt[]): Trend {
  const usable = records.filter((r) => r.protocolViolations === 0);
  if (usable.length < MIN_SAMPLES) return "insufficient-data";
  const half = Math.floor(usable.length / 2);
  const first = usable.slice(0, half);
  const second = usable.slice(half);
  const fIPA = ipa(first), sIPA = ipa(second);
  const fAtt = mean(first.map((r) => r.attempts)), sAtt = mean(second.map((r) => r.attempts));
  const fHit = mean(first.map((r) => (r.firstTryHit ? 1 : 0))), sHit = mean(second.map((r) => (r.firstTryHit ? 1 : 0)));
  const accelerating = sIPA > fIPA * (1 + TREND_EPSILON) && sAtt <= fAtt && sHit >= fHit;
  const decelerating = sIPA < fIPA * (1 - TREND_EPSILON) || sAtt > fAtt * (1 + TREND_EPSILON);
  return accelerating ? "accelerating" : decelerating ? "decelerating" : "flat";
}

/** 独立前缀投影：重算每一轮的累计 IPA / 累计探测 / 累计命中率 / 可用样本。 */
function independentPoints(records: Attempt[]) {
  return records.map((r, i) => {
    const prefix = records.slice(0, i + 1);
    const usable = prefix.filter((x) => x.protocolViolations === 0);
    return {
      seq: r.seq,
      cumulativeIPA: ipa(usable),
      cumulativeAttempts: mean(usable.map((x) => x.attempts)),
      cumulativeHitRate: mean(usable.map((x) => (x.firstTryHit ? 1 : 0))),
      cumulativeProbesAvoided: usable.reduce((a, x) => a + x.probesAvoided, 0),
      usableSamples: usable.length,
      trend: independentTrend(prefix),
    };
  });
}

// —— 读取原始账本（只读）——
const beforeHash = existsSync(LEDGER)
  ? createHash("sha256").update(readFileSync(LEDGER)).digest("hex")
  : "";
const records: Attempt[] = existsSync(LEDGER)
  ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const wellFormed = records.every((r, i) =>
  r.seq === i && typeof r.ts === "string" && Number.isFinite(r.attempts)
  && Number.isFinite(r.improvement) && Number.isFinite(r.probesAvoided)
  && Number.isFinite(r.protocolViolations) && typeof r.firstTryHit === "boolean");

// —— 独立重算结果 ——
const usable = records.filter((r) => r.protocolViolations === 0);
const snap = {
  samples: records.length,
  usableSamples: usable.length,
  firstTryHitRate: mean(usable.map((r) => (r.firstTryHit ? 1 : 0))),
  avgAttempts: mean(usable.map((r) => r.attempts)),
  avgProbesAvoided: mean(usable.map((r) => r.probesAvoided)),
  improvementPerAttempt: ipa(usable),
  reuseRate: mean(usable.map((r) => (r.experienceHits > 0 ? 1 : 0))),
  trend: independentTrend(records),
};
const points = independentPoints(records);

// —— 与运行时 watermark.json 交叉对照（inter-rater）——
const wm = existsSync(WATERMARK) ? JSON.parse(readFileSync(WATERMARK, "utf8")) : null;
const EPS = 1e-9;
const near = (a: unknown, b: unknown): boolean =>
  typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= EPS;

const comparisons: Array<{ field: string; independent: unknown; runtime: unknown; match: boolean }> = [];
if (wm && wm.current) {
  for (const field of ["samples", "usableSamples", "firstTryHitRate", "avgAttempts",
                       "avgProbesAvoided", "improvementPerAttempt", "reuseRate", "trend"] as const) {
    comparisons.push({
      field,
      independent: (snap as Record<string, unknown>)[field],
      runtime: wm.current[field],
      match: (snap as Record<string, unknown>)[field] === wm.current[field]
        || near((snap as Record<string, unknown>)[field], wm.current[field]),
    });
  }
}
// 逐点交叉：累计 IPA（最核心的能力代理）
let pointMismatches = 0;
if (wm && Array.isArray(wm.points)) {
  for (const p of points) {
    const rp = wm.points[p.seq];
    if (!rp || !near(p.cumulativeIPA, rp.cumulativeIPA) || p.trend !== rp.trend) pointMismatches++;
  }
}

// 只读性：报告生成前后账本字节不变
const afterHash = existsSync(LEDGER)
  ? createHash("sha256").update(readFileSync(LEDGER)).digest("hex")
  : "";

const allMatch = comparisons.length > 0 && comparisons.every((c) => c.match)
  && pointMismatches === 0 && wellFormed && beforeHash === afterHash;
const emptyLedger = records.length === 0;

const report = {
  generatedAt: new Date().toISOString(),
  version: "p0-evidence-recompute-v1",
  purpose: "独立实现从原始账本重算曲线，与运行时 watermark 交叉对照（inter-rater reliability）",
  independence: {
    importsRuntimeRuler: false,
    declaredConstants: { MIN_SAMPLES, TREND_EPSILON, ipaFormula: "sum(improvement)/sum(attempts)" },
    ledgerSha256: beforeHash,
    readOnly: beforeHash === afterHash,
  },
  ledger: { records: records.length, wellFormed },
  independentSnapshot: snap,
  runtimeSnapshot: wm ? wm.current : null,
  comparisons,
  pointCrossCheck: { compared: points.length, mismatches: pointMismatches },
  verdict: emptyLedger
    ? "insufficient-data-empty-ledger"
    : allMatch ? "independent-agrees-with-runtime" : "DIVERGENCE-DETECTED",
  honest: {
    scope: "只验证『运行时水位报告 == 冻结尺子对原始账本的独立重算』，不构成能力分数或领先证据",
    verdictBoundary: "not-proven",
    l4: "not-achieved",
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

console.log(`P0 独立证据重算：${report.verdict}`);
console.log(`  账本 ${records.length} 条（结构 ${wellFormed ? "完整" : "异常"}），冻结常量 MIN_SAMPLES=${MIN_SAMPLES} EPS=${TREND_EPSILON}`);
console.log(`  独立趋势=${snap.trend}  运行时趋势=${wm?.current?.trend ?? "N/A"}`);
console.log(`  字段对照 ${comparisons.filter((c) => c.match).length}/${comparisons.length}，逐点一致性 ${points.length - pointMismatches}/${points.length}`);
console.log(`  报告写入 ${OUT}`);
if (!emptyLedger && !allMatch) process.exitCode = 1;
