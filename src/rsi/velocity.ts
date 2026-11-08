/**
 * bro2 · 复利速度度量（把「越用越快」变成一等公民、可证伪的量）
 *
 * 现状缺口：bro2 已能证明「改进有效」（holdout 严格提升 + 行为对比），
 * 但从未把「达到改进花了多少次探测」当作被优化、被冻结尺子测量的量。
 * 于是「越使用改进速度越快」既无法证实也无法证伪——这正是设计目标 1 的核心。
 *
 * 四个只读指标：
 *   firstTryHitRate        首轮即命中有效编辑的比例（经验直接复用的效果）
 *   avgAttempts            平均探测次数（应随使用递减）
 *   avgProbesAvoided       平均因经验裁剪而跳过的探测数（应随使用递增）
 *   improvementPerAttempt  单位探测的改进量（应随使用递增）
 *
 * 诚实边界（防自确认循环，与 meta-RSI 的冻结 fitness 同源）：
 *   1) 尺子定义固定在本模块，经验库 / MetaState 都不得改动它；
 *   2) `improvement` 只数「行为对比成立」的接受项，绝不采信自报 scoreGain；
 *   3) 样本不足（< MIN_SAMPLES）一律返回 insufficient-data，
 *      **绝不**因为数据好看就宣称 accelerating；
 *   4) 出现协议违规的轮次不计入趋势（治理不变量优先于效率叙事）。
 *
 * 明确不做：不产出能力分数、不修改 verdict、不把速度当成「领先」证据。
 */
import {
  existsSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync,
} from "node:fs";
import { dirname } from "node:path";

/** 判定加速所需的最少可用轮数。低于此值一律 insufficient-data。 */
export const MIN_SAMPLES = 6;
/** 前后半比较的最小相对变化，抑制噪声被当成趋势。 */
export const TREND_EPSILON = 0.05;

export interface AttemptRecord {
  seq: number;
  ts: string;
  /** 本轮实际探测的候选数（复利的直接成本）。 */
  attempts: number;
  /** 本轮命中的经验条数。 */
  experienceHits: number;
  /** 是否首批探测即命中有效编辑。 */
  firstTryHit: boolean;
  /** 行为对比成立的接受数（非自报分数）。 */
  improvement: number;
  /** 因经验裁剪而未探测的候选数。 */
  probesAvoided: number;
  /** 经验不灵、回退探测了 deferred 候选。 */
  usedFallback: boolean;
  /** 本轮协议违规数；>0 则本轮不计入趋势。 */
  protocolViolations: number;
}

export type VelocityTrend = "accelerating" | "flat" | "decelerating" | "insufficient-data";

export interface VelocitySnapshot {
  samples: number;
  usableSamples: number;
  firstTryHitRate: number;
  avgAttempts: number;
  avgProbesAvoided: number;
  improvementPerAttempt: number;
  reuseRate: number;
  /** 前半 vs 后半的单位探测改进量，供人工复核趋势是否真实。 */
  firstHalfIPA: number;
  secondHalfIPA: number;
  trend: VelocityTrend;
  honesty: {
    frozenMetric: true;
    selfReported: false;
    reason: string;
  };
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (text.length > 0 && !text.endsWith("\n") && lines.length > 0) lines.pop();
  return lines;
}

function atomicAppend(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const mean = (xs: number[]): number => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** 加权单位探测改进量：Σimprovement / Σattempts，避免空轮除零。 */
function improvementPerAttempt(rows: AttemptRecord[]): number {
  const attempts = rows.reduce((a, r) => a + r.attempts, 0);
  if (attempts === 0) return 0;
  return rows.reduce((a, r) => a + r.improvement, 0) / attempts;
}

/** 复利速度只增账本。跨会话累积，快照由本模块的冻结尺子计算。 */
export class VelocityLedger {
  readonly path: string;
  private seq = 0;

  constructor(path: string) {
    this.path = path;
    this.seq = readLines(path).length;
  }

  append(rec: Omit<AttemptRecord, "seq" | "ts">): AttemptRecord {
    const full: AttemptRecord = { seq: this.seq, ts: new Date().toISOString(), ...rec };
    this.seq += 1;
    atomicAppend(this.path, JSON.stringify(full));
    return full;
  }

  records(): AttemptRecord[] {
    const out: AttemptRecord[] = [];
    for (const line of readLines(this.path)) {
      try {
        out.push(JSON.parse(line) as AttemptRecord);
      } catch {
        // 单条损坏不影响账本整体可读
      }
    }
    return out;
  }

  snapshot(): VelocitySnapshot {
    const all = this.records();
    const usable = all.filter((r) => r.protocolViolations === 0);
    const base: Omit<VelocitySnapshot, "trend" | "honesty" | "firstHalfIPA" | "secondHalfIPA"> = {
      samples: all.length,
      usableSamples: usable.length,
      firstTryHitRate: mean(usable.map((r) => (r.firstTryHit ? 1 : 0))),
      avgAttempts: mean(usable.map((r) => r.attempts)),
      avgProbesAvoided: mean(usable.map((r) => r.probesAvoided)),
      improvementPerAttempt: improvementPerAttempt(usable),
      reuseRate: mean(usable.map((r) => (r.experienceHits > 0 ? 1 : 0))),
    };

    if (usable.length < MIN_SAMPLES) {
      return {
        ...base, firstHalfIPA: 0, secondHalfIPA: 0,
        trend: "insufficient-data",
        honesty: {
          frozenMetric: true, selfReported: false,
          reason: `可用样本 ${usable.length} < ${MIN_SAMPLES}，禁止宣称加速或减速`,
        },
      };
    }

    const half = Math.floor(usable.length / 2);
    const first = usable.slice(0, half);
    const second = usable.slice(half);
    const firstIPA = improvementPerAttempt(first);
    const secondIPA = improvementPerAttempt(second);
    const firstAttempts = mean(first.map((r) => r.attempts));
    const secondAttempts = mean(second.map((r) => r.attempts));
    const firstHit = mean(first.map((r) => (r.firstTryHit ? 1 : 0)));
    const secondHit = mean(second.map((r) => (r.firstTryHit ? 1 : 0)));

    // 加速需同时满足：单位探测改进量上升、探测次数不上升、首轮命中率不下降
    const accelerating =
      secondIPA > firstIPA * (1 + TREND_EPSILON)
      && secondAttempts <= firstAttempts
      && secondHit >= firstHit;
    const decelerating =
      secondIPA < firstIPA * (1 - TREND_EPSILON)
      || secondAttempts > firstAttempts * (1 + TREND_EPSILON);

    const trend: VelocityTrend = accelerating ? "accelerating" : decelerating ? "decelerating" : "flat";
    return {
      ...base,
      firstHalfIPA: firstIPA,
      secondHalfIPA: secondIPA,
      trend,
      honesty: {
        frozenMetric: true,
        selfReported: false,
        reason: `样本 ${usable.length}（前半 ${half} / 后半 ${usable.length - half}）；`
          + `IPA ${firstIPA.toFixed(3)}→${secondIPA.toFixed(3)}，`
          + `探测 ${firstAttempts.toFixed(2)}→${secondAttempts.toFixed(2)}，`
          + `首轮命中 ${firstHit.toFixed(2)}→${secondHit.toFixed(2)}；`
          + `协议违规 ${all.length - usable.length} 轮已排除`,
      },
    };
  }
}

/** 默认路径：与经验库同目录。 */
export function velocityPath(root: string): string {
  return `${root.replace(/\/$/, "")}/data/rsi/velocity.jsonl`;
}
