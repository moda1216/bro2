/**
 * bro2 · 复利闭环（Compound Loop）：把经验库 + 冻结速度度量 + 对比式改进串起来
 *
 * 这是设计目标 1「越使用改进速度越快」的可运行落点，也是 P2 的核心闭环。
 *
 * 关键设计判断：`contrast.ts` 的 `proposeProbeCompose` 是**全量判定**（遍历所有
 * 候选），所以「经验复用」不能靠改变判定结果来体现变快——那会变成 reward
 * hacking。复利只能体现在 **Propose 阶段裁剪探测集**：有经验时少探测几个候选
 * 就找到有效编辑，无经验时老实全探测。判定逻辑一字不改。
 *
 * 三条硬保证：
 *   1) 经验只影响**探测哪些候选**，接受仍走 `behavioralContrast` 全量行为对比；
 *      候选自报 `scoreGain` 依旧不参与判定（防 reward hacking 复用）。
 *   2) 经验不灵（首批无接受项）必须**回退探测 deferred**，绝不因"有经验"就
 *      跳过验证；回退本身记入速度账本，不许掩盖。
 *   3) 经验回写只由「行为对比成立且非 reward hacking」的接受项驱动，
 *      失败项同样留痕（只增账本），避免经验库只记好事而自我确认。
 *
 * 探索位：即使经验命中，也始终保留 EXPLORE_SLOTS 个探索候选，防止过早收敛到
 * 局部（对应 RRSI「鼓励探索未试轨迹」的正则思想）。
 */
import { ExperienceBank, failureSignature } from "./experience.ts";
import { VelocityLedger } from "./velocity.ts";
import { evaluateLiveCandidates } from "./live-contrast.ts";
import type { LiveCandidate, LiveDecision } from "./live-contrast.ts";
import type { RunSummary } from "./contrast.ts";

/** 经验命中时仍保留的探索候选数，避免经验库过早收敛。 */
export const EXPLORE_SLOTS = 1;

/**
 * 惰性候选项：只有 `probed` 尚未实跑的提案描述。
 * `probed` 必须由 `CompoundOptions.probe()` 在候选真正进入探测集时生成，
 * 绝不预先填好假摘要——否则「裁剪探测集」只是纸面省成本，属于变相 reward hacking。
 */
export type PendingCandidate = Omit<LiveCandidate, "probed">;

export interface CompoundOptions {
  /** 显式指定指纹；缺省由基线行为摘要计算。 */
  signature?: string;
  /** 显式指定本轮最多探测数；缺省按经验命中数自动裁剪。 */
  topK?: number;
  /** 经验来源标记，写入只增账本便于审计。 */
  source?: string;
  /**
   * 惰性探测钩子（v2.2.0）：仅当候选**真正被探测**时调用，返回带真实 `probed`
   * 行为摘要的候选。调用方在此实跑评测；被经验裁剪掉的候选不会触发回调，
   * 因而 `attempts` 等于真实计算成本，而不是纸面数字。
   *
   * 不传时与 v2.1.0 完全一致（要求候选自带 probed），保证既有演示/单测零改动。
   */
  probe?: (candidate: PendingCandidate) => LiveCandidate;
}

export interface CompoundResult {
  decisions: LiveDecision[];
  /** 本轮实际探测的候选数（复利的成本口径）。 */
  attempts: number;
  experienceHits: number;
  /** 因经验裁剪而未探测的候选数。 */
  probesAvoided: number;
  /** 经验不灵、回退探测了 deferred 候选。 */
  usedFallback: boolean;
  /** 首批探测即命中有效编辑。 */
  firstTryHit: boolean;
  /** 行为对比成立的接受数（非自报分数）。 */
  improvement: number;
  protocolViolations: number;
  rewardHackingBlocked: number;
  /** 本轮是否由经验自动裁剪了探测集（审计用）。 */
  autoPruned: boolean;
  effectiveTopK: number;
  signature: string;
}

/**
 * 一轮「有经验的」Probe。纯编排、无网络；候选的 `probed` 由调用方在配对
 * 条件下实跑得到，本函数不伪造行为摘要。
 */
export function compoundProbe(
  baseline: RunSummary,
  candidates: Array<LiveCandidate | PendingCandidate>,
  bank: ExperienceBank,
  ledger: VelocityLedger,
  opts: CompoundOptions = {},
): CompoundResult {
  const signature = opts.signature ?? failureSignature(baseline);
  const source = opts.source ?? "compoundProbe";

  // 真实探测才生成行为摘要：resolved 只收录实际跑过的候选。
  const resolved = new Map<string, LiveCandidate>();
  const materialize = (batch: Array<LiveCandidate | PendingCandidate>): LiveCandidate[] =>
    batch.map((c) => {
      if ("probed" in c) {
        const full = c as LiveCandidate;
        resolved.set(full.id, full);
        return full;
      }
      if (!opts.probe) {
        throw new Error(`候选 ${c.id} 未提供 probed 且未配置惰性 probe()：拒绝伪造行为摘要`);
      }
      const full = opts.probe(c as PendingCandidate);
      resolved.set(full.id, full);
      return full;
    });

  const { prioritized, deferred, hits } = bank.prioritize(
    "harness-edit", signature, candidates, (c) => c.id,
  );

  // 自动裁剪：有经验就只探测命中的候选 + 探索位；无经验则全探测（冷启动不退化）
  const autoPruned = opts.topK === undefined && hits > 0;
  const effectiveTopK = opts.topK !== undefined
    ? Math.max(1, Math.min(opts.topK, candidates.length))
    : hits > 0
      ? Math.max(1, Math.min(hits + EXPLORE_SLOTS, candidates.length))
      : candidates.length;

  // prioritize 已按经验排序；这里按 effectiveTopK 重新切分（topK 可能更小）
  const firstBatch = prioritized.slice(0, effectiveTopK);
  const rest = [...prioritized.slice(effectiveTopK), ...deferred];

  const first = evaluateLiveCandidates(baseline, materialize(firstBatch));
  let decisions = [...first.decisions];
  const firstAccepted = first.decisions.filter((d) => d.accepted).length;
  let usedFallback = false;

  // 经验不灵：老实回退探测剩余候选，绝不硬信经验
  if (firstAccepted === 0 && rest.length > 0) {
    usedFallback = true;
    const second = evaluateLiveCandidates(baseline, materialize(rest));
    decisions = [...decisions, ...second.decisions];
  }

  // 经验回写：只由行为判定结果驱动，scoreGain 不参与；失败项同样留痕
  const byId = resolved;
  const probed = new Set(decisions.map((d) => d.id));
  for (const d of decisions) {
    const good = d.accepted && !d.rewardHackingBlocked;
    bank.observeOutcome(
      "harness-edit", signature, d.id,
      good ? "success" : "failure",
      {
        applicableTo: [`失败模式 ${d.focus}`, `指纹 ${signature}`],
        source: `${source}#${good ? "accepted" : "rejected"}`,
      },
    );
  }

  const attempts = probed.size;
  const improvement = decisions.filter((d) => d.accepted).length;
  const protocolViolations = decisions.reduce((sum, d) => {
    const c = byId.get(d.id);
    return sum + (c?.probed.protocolViolations ?? 0);
  }, 0);
  const rewardHackingBlocked = decisions.filter((d) => d.rewardHackingBlocked).length;

  const record = {
    attempts,
    experienceHits: hits,
    firstTryHit: firstAccepted > 0,
    improvement,
    probesAvoided: candidates.length - attempts,
    usedFallback,
    protocolViolations,
  };
  ledger.append(record);

  return {
    decisions,
    attempts,
    experienceHits: hits,
    probesAvoided: record.probesAvoided,
    usedFallback,
    firstTryHit: record.firstTryHit,
    improvement,
    protocolViolations,
    rewardHackingBlocked,
    autoPruned,
    effectiveTopK,
    signature,
  };
}
