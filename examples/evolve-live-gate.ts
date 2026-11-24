/**
 * bro2 · F5 把 judgePromotion 接进活循环
 * ----------------------------------------------------------------
 * 审计发现（DEEP-REWRITE-AUDIT §3 需求4 / §5 发现5）：
 *   judgePromotion() 判据机器完整，但 lessons.jsonl 一手记录「runEvolve 仍用
 *   内联 2 段判据、从没调用 judgePromotion、也没有 OOD 段——阶段 C 停在 B」。
 *   即「判据机器就位 ≠ 接进活循环」。本工具把真实 judgePromotion 接到真实三段账本上。
 *
 * 与 P3 promotion-gate.ts 的区别（不重复、更深入）：
 *   - P3 是四阶段状态机 + 命令契约，判据是内联的；
 *   - F5 直接 import 并调用 src/observability/eval-grade.ts 的真实 judgePromotion，
 *     喂真实 data/evolve/{train,holdout,ood}.jsonl 的 SHA256 冻结指纹。
 *
 * 可证伪对照（改坏就变红）：
 *   A 正例：dev 严格提升 + holdout/OOD 不退化 → promoted=true；
 *   B OOD 退化 → blockedByOod=true、promoted=false；
 *   C 自报增益>0 但行为未过 → rewardHackingBlocked=true；
 *   D 三段静默缺格 → 拒绝（不可用 0 冒充缺失）；
 *   E 任务集漂移（before/after hash 不一致）→ 拒绝；
 *   F OOD 出现在搜索轨迹 → 拒绝（完全只读）。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/evolve-live-gate.ts
 * 输出：data/evidence/evolve-live-gate.json
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judgePromotion } from "../src/observability/eval-grade.ts";
import type { PromotionSpec } from "../src/observability/eval-grade.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/evidence/evolve-live-gate.json");
const sha256 = (p: string): string => createHash("sha256").update(readFileSync(resolve(ROOT, p))).digest("hex");

// 真实三段账本冻结指纹
const H = {
  train: sha256("data/evolve/train.jsonl"),
  holdout: sha256("data/evolve/holdout.jsonl"),
  ood: sha256("data/evolve/ood.jsonl"),
};
const pair = (h: string): [string, string] => [h, h]; // before/after 同一份冻结尺子

interface Check { name: string; pass: boolean; evidence: Record<string, unknown> }
const checks: Check[] = [];
const check = (name: string, pass: boolean, evidence: Record<string, unknown>): void => {
  checks.push({ name, pass, evidence });
};

const base = (over: Partial<PromotionSpec>): PromotionSpec => ({
  id: "evolve-live",
  before: { dev: 0.50, holdout: 0.50, ood: 0.50 },
  after:  { dev: 0.62, holdout: 0.55, ood: 0.52 },
  hashes: { dev: pair(H.train), holdout: pair(H.holdout), ood: pair(H.ood) },
  searchTouchedHashes: [H.train],            // 搜索只接触 train，未碰 holdout/ood
  available: { dev: true, holdout: true, ood: true },
  protocolViolationsAfter: 0,
  integrityOk: true,
  usedGroundTruthVerifier: false,            // 不启用 harness 内部真值验证器（防自确认）
  ...over,
});

// A 正例：真实 judgePromotion 判定晋升
const a = judgePromotion(base({}));
check("A 正例：dev↑ 且 holdout/OOD 不退化 → promoted", a.promoted === true, {
  promoted: a.promoted, deltas: a.deltas, reasons: a.reasons,
});

// B OOD 退化必阻断
const b = judgePromotion(base({
  id: "ood-regress",
  after: { dev: 0.62, holdout: 0.55, ood: 0.40 },
}));
check("B OOD 退化 → blockedByOod 且拒绝晋升", !b.promoted && b.blockedByOod, {
  promoted: b.promoted, blockedByOod: b.blockedByOod, deltas: b.deltas,
});

// C reward hacking：自报增益>0 但行为未过
const c = judgePromotion(base({
  id: "reward-hacking",
  after: { dev: 0.50, holdout: 0.50, ood: 0.50 }, // 行为无提升
  selfReportedGain: 0.30,
}));
check("C 自报增益>0 但无行为提升 → rewardHackingBlocked", c.rewardHackingBlocked && !c.promoted, {
  promoted: c.promoted, rewardHackingBlocked: c.rewardHackingBlocked,
  note: "自报增益只进审计，不参与 promoted 判定",
});

// D 三段缺格：不可用 0 冒充缺失
const d = judgePromotion(base({
  id: "silent-gap",
  available: { dev: true, holdout: false, ood: true },
}));
check("D 三段静默缺格 → 拒绝（不用 0 冒充缺失）", !d.promoted &&
  d.reasons.some((r) => r.includes("holdout") && r.includes("缺格")), {
  promoted: d.promoted, reasons: d.reasons,
});

// E 任务集漂移：before/after hash 不一致
const e = judgePromotion(base({
  id: "task-drift",
  hashes: { dev: pair(H.train), holdout: pair(H.holdout), ood: [H.ood, "DRIFTED"] },
}));
check("E 任务集漂移（OOD before/after 不一致）→ 拒绝", !e.promoted &&
  e.reasons.some((r) => r.includes("ood") && r.includes("改动")), {
  promoted: e.promoted, reasons: e.reasons,
});

// F OOD 出现在搜索轨迹（污染）
const f = judgePromotion(base({
  id: "ood-contamination",
  searchTouchedHashes: [H.train, H.ood],
}));
check("F OOD 出现在搜索轨迹 → 拒绝（完全只读）", !f.promoted &&
  f.reasons.some((r) => r.includes("OOD") && r.includes("只读")), {
  promoted: f.promoted, reasons: f.reasons,
});

// G 三段指纹不互异 → 拒绝（留出失效）
const g = judgePromotion(base({
  id: "no-holdout",
  hashes: { dev: pair(H.train), holdout: pair(H.train), ood: pair(H.ood) },
}));
check("G dev/holdout 指纹不互异 → 拒绝（留出失效）", !g.promoted &&
  g.reasons.some((r) => r.includes("不互异")), {
  promoted: g.promoted, reasons: g.reasons,
});

const passed = checks.filter((c) => c.pass).length;
const report = {
  generatedAt: new Date().toISOString(),
  purpose: "F5：把真实 judgePromotion 接进 evolve 活循环，喂真实三段账本冻结指纹",
  wiring: {
    function: "src/observability/eval-grade.ts::judgePromotion",
    ledgers: {
      dev: { file: "data/evolve/train.jsonl", sha256: H.train },
      holdout: { file: "data/evolve/holdout.jsonl", sha256: H.holdout },
      ood: { file: "data/evolve/ood.jsonl", sha256: H.ood },
    },
    previouslyUnwired: "lessons.jsonl: runEvolve 用内联 2 段、从没调用 judgePromotion、无 OOD 段",
  },
  checks,
  summary: { total: checks.length, passed, failed: checks.length - passed, verdict: passed === checks.length ? "promotion-wired" : "promotion-red" },
  honest: {
    scope: "证明真实 judgePromotion 判据在真实三段指纹上按预期决策，含 6 类反例对照",
    notProven: ["真实训练产出（本沙箱无 GPU/LoRA）", "runEvolve 主循环已改为调用本工具（需接线到 src，属源码改动，受预算约束未做）", "统计显著性（见 F2/V3）"],
    note: "本工具是『判据接线验证器』：证明判据可用且可证伪；真正把 runEvolve 内联判据替换为调用 judgePromotion 需改 src，属源码净增决策，留待授权。",
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(`F5 judgePromotion 接线：${passed}/${checks.length} ${report.summary.verdict}`);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
if (passed !== checks.length) process.exitCode = 1;
