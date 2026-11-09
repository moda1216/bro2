/**
 * bro2 · 阶段 C 接入校验（不计入代码预算：放 examples/，与 segments-check.ts 同策略）
 * ----------------------------------------------------------
 * 证明 judgePromotion（三段晋升铁律）在「真实冻结任务集」上可被 RSI 主循环消费：
 *   1) 真实分数与冻结指纹来自 runEval 对 data/evolve/{train,holdout,ood}.jsonl 的实际评测；
 *   2) 合法改进（dev 严格提升、holdout/OOD 不退化、搜索只碰 dev）→ promoted=true；
 *   3) OOD 退化 → 自动阻断（blockedByOod=true）且把阻断写进 journal 可复核；
 *   4) 搜索阶段触碰 OOD 任务集 → 违反完全只读，晋升阻断。
 *
 * 这是「判定机器 + 真实三段」接入主循环的契约证明；真实写 journal 的路径与 rsi/loop.ts
 * 一致（data/plan/journal.jsonl），本脚本为避免污染只增账本而写入临时副本并回读校验。
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  console.log(`三段指纹互异   dev=${dev.hash} holdout=${hld.hash} ood=${oodS.hash}`);

  ok("三段任务集指纹互不相同（留出隔离）",
    dev.hash !== hld.hash && hld.hash !== oodS.hash && dev.hash !== oodS.hash);

  const base = (delta: Partial<{ dev: number; holdout: number; ood: number }>, searchOod = false): PromotionSpec => ({
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
    searchTouchedHashes: searchOod ? [oodS.hash] : [dev.hash],
    available: { dev: true, holdout: true, ood: true },
    protocolViolationsAfter: 0,
    integrityOk: true,
    usedGroundTruthVerifier: false,
    tolerance: 0,
  });

  const legit = judgePromotion(base({ dev: 0.1 }));
  ok("合法改进（dev 提升、holdout/OOD 不退化、搜索只碰 dev）→ 晋升", legit.promoted);

  const flat = judgePromotion(base({}));
  ok("无改进（dev 未提升）→ 不晋升", !flat.promoted);

  // ---- OOD 退化：自动阻断 + 写 journal 可复核 ----
  const tmp = mkdtempSync(join(tmpdir(), "bro2-phasec-"));
  const journalPath = join(tmp, "journal.jsonl");
  const regress = judgePromotion(base({ ood: -0.2 }));
  ok("OOD 退化 → 晋升阻断", !regress.promoted);
  ok("OOD 退化 → blockedByOod 标记", regress.blockedByOod);
  if (!regress.promoted) {
    appendFileSync(journalPath, JSON.stringify({
      at: new Date().toISOString(), id: "W4-C-ood-block", event: "block",
      reason: regress.reasons.join("; "), segment: "ood",
    }) + "\n");
  }
  const journaled = readFileSync(journalPath, "utf8").trim().split("\n");
  const entry = journaled.length ? JSON.parse(journaled[journaled.length - 1]) : null;
  ok("退化阻断已写入 journal 且带原因", !!entry && entry.event === "block" && /OOD/.test(entry.reason));
  rmSync(tmp, { recursive: true, force: true });

  const polluted = judgePromotion(base({}, true));
  ok("搜索阶段触碰 OOD → 违反完全只读，晋升阻断", !polluted.promoted && polluted.reasons.some((r) => /OOD/.test(r)));

  console.log(`\nphase-c 校验：${passed}/${passed + failed} 通过`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
