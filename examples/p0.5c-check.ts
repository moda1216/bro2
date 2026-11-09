/**
 * bro2 · P0.5-c 成本晋升目标校验（不计入代码预算：放 examples/，与 phase-c-check.ts 同策略）
 * ----------------------------------------------------------
 * 证明 judgePromotion 的成本目标（P0.5-c：remoteAvoided↑ 且分数不降，才把成本纳入晋升目标）：
 *   1) 真实分数与冻结指纹来自 runEval 对 data/evolve/{train,holdout,ood}.jsonl 的实际评测；
 *   2) 能力晋升 + 远程调用不升 → promoted（成本目标满足，不阻断）；
 *   3) 能力晋升 + 远程调用反升 → 晋升阻断（成本退化不得借能力增益蒙混过关）；
 *   4) 能力未晋升（dev 未提升）+ 远程调用下降 → 仍不晋升（成本目标不越权覆盖能力判据）；
 *   5) 能力晋升 + 远程调用下降 → promoted（remoteAvoided↑ 正是 P0.5-c 想要的方向）。
 *
 * 注：确定性评测域本身没有成本信号（mock 无远程/本地之分），故成本数在此为合成输入——
 * 与 promotion:check / phasec:check 同口径（用真实任务集指纹 + 合成分数喂判定机器）。
 * 真实成本信号由 hybrid 评测（remoteAvoided）接入后自动生效，判定机器已就位。
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval, loadTasks } from "../src/observability/eval.ts";
import type { EvalTask, EvalThresholds } from "../src/observability/eval.ts";
import { judgePromotion } from "../src/observability/eval-grade.ts";
import type { PromotionSpec } from "../src/observability/eval-grade.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLDS: EvalThresholds = {
  minOverall: 0, minToolUse: 0, minSafety: 0, minRobustness: 0,
  maxToolErrorRate: 0.35, maxProtocolViolations: 0, maxAvgSteps: 999, maxRegression: 0.08,
};

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name} ${extra}`); }
}

async function score(tasks: EvalTask[]): Promise<{ overall: number; hash: string }> {
  const r = await runEval({ tasks, mode: "deterministic", k: 1, root: ROOT, baseline: null, thresholds: THRESHOLDS });
  return { overall: r.summary.overall, hash: r.taskSetHash };
}

async function main(): Promise<void> {
  const train = loadTasks(join(ROOT, "data/evolve/train.jsonl"));
  const holdout = loadTasks(join(ROOT, "data/evolve/holdout.jsonl"));
  const ood = loadTasks(join(ROOT, "data/evolve/ood.jsonl"));
  const dev = await score(train);
  const hld = await score(holdout);
  const oodS = await score(ood);
  console.log(`真实三段分数  dev=${dev.overall.toFixed(3)} holdout=${hld.overall.toFixed(3)} ood=${oodS.overall.toFixed(3)}`);

  const base = (
    delta: Partial<{ dev: number; holdout: number; ood: number }>,
    cost?: { remoteBefore: number; remoteAfter: number },
  ): PromotionSpec => ({
    id: "candidate",
    before: { dev: dev.overall, holdout: hld.overall, ood: oodS.overall },
    after: {
      dev: dev.overall + (delta.dev ?? 0),
      holdout: hld.overall + (delta.holdout ?? 0),
      ood: oodS.overall + (delta.ood ?? 0),
    },
    hashes: {
      dev: [dev.hash, dev.hash],
      holdout: [hld.hash, hld.hash],
      ood: [oodS.hash, oodS.hash],
    },
    searchTouchedHashes: [dev.hash],
    available: { dev: true, holdout: true, ood: true },
    protocolViolationsAfter: 0,
    integrityOk: true,
    usedGroundTruthVerifier: false,
    tolerance: 0,
    ...(cost ? { cost } : {}),
  });

  // 1) 能力晋升 + 成本不升 → 晋升（成本目标满足）
  const promotedFlat = judgePromotion(base({ dev: 0.1 }, { remoteBefore: 100, remoteAfter: 100 }));
  ok("能力晋升 + 远程调用不升 → 晋升（成本目标满足）", promotedFlat.promoted);

  // 2) 能力晋升 + 成本反升 → 阻断（成本退化不得蒙混过关）
  const regressed = judgePromotion(base({ dev: 0.1 }, { remoteBefore: 100, remoteAfter: 130 }));
  ok("能力晋升 + 远程调用反升 → 晋升阻断", !regressed.promoted);
  ok("成本退化被明确记为拒绝原因", regressed.reasons.some((r) => /成本退化/.test(r)));

  // 3) 能力未晋升 + 远程调用下降 → 仍不晋升（成本目标不越权覆盖能力判据）
  const noCapSaved = judgePromotion(base({}, { remoteBefore: 100, remoteAfter: 40 }));
  ok("能力未晋升 + 远程调用下降 → 仍不晋升（成本不越权）", !noCapSaved.promoted);

  // 4) 能力晋升 + 远程调用下降 → 晋升（remoteAvoided↑ 正是 P0.5-c 要的方向）
  const saved = judgePromotion(base({ dev: 0.1 }, { remoteBefore: 100, remoteAfter: 40 }));
  ok("能力晋升 + 远程调用下降 → 晋升（remoteAvoided↑ 受鼓励）", saved.promoted);

  // 5) 未提供成本目标时行为不变（向后兼容，不影响既有判定）
  const noCost = judgePromotion(base({ dev: 0.1 }));
  ok("未提供成本目标 → 行为不变（向后兼容）", noCost.promoted);

  console.log(`\np0.5c 校验：${passed}/${passed + failed} 通过`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
