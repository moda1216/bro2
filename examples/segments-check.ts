#!/usr/bin/env node
/**
 * segments:check · W1-06 三段任务集分层门禁（第 21 道）
 * ----------------------------------------------------------
 * 0pp 负结果后 W1-06 重定口径：不再「L2 扩到 60 个任务」，而是把**现有真实任务集**
 * 按确定性规则切成 dev / holdout / ood 三堆并冻结指纹。
 *
 * 验证：任务集可复核、三段互不相交、指纹互异、OOD 完全只读，且这三段指纹
 * 能作为 judgePromotion 的合法输入（阶段 C 前置的「输入契约」）。
 *
 * 诚实边界：这是输入契约门禁，**不是** promote.ts 接入 RSI 主循环；
 * 阶段 C 仍停在 B，不产生能力分数、不推动 leadership.verdict。
 *
 * 用法：
 *   npm run segments:check              # 只读校验（CI / 发布门禁）
 *   npm run segments:check -- --freeze  # 任务集变更后显式重冻结 manifest
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLayers } from "../src/bench/loader.ts";
import { judgePromotion } from "../src/observability/eval-grade.ts";
import type { PromotionSpec } from "../src/observability/eval-grade.ts";
import type { EvalTask } from "../src/observability/eval.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = resolve(ROOT, "data/tasks/v2/segments.json");
const REPORT = resolve(ROOT, "data/bench/segments-check.json");
const SEGMENTS = ["dev", "holdout", "ood"] as const;
type Segment = (typeof SEGMENTS)[number];

/** 与 runEval.taskSetHash / loadLayer.hash 完全同口径，分段指纹可直接喂判定机器。 */
const fp = (tasks: readonly EvalTask[]): string =>
  createHash("sha1").update(JSON.stringify(tasks)).digest("hex").slice(0, 12);

/** sha1(id) 首字节取模 3：同一 id 恒定同段，三段天然互不相交；改任务内容不改归属。 */
const segmentOf = (id: string): Segment =>
  SEGMENTS[createHash("sha1").update(id).digest()[0]! % 3]!;

// ---- 从真实任务集重算（单一事实源：不复制任务定义） ----
const loaded = loadLayers(ROOT, ["l1", "l2"]);
assert.equal(loaded.problems.length, 0, `任务集装载失败：${loaded.problems.join("; ")}`);
const all = loaded.tasks;
const groups: Record<Segment, EvalTask[]> = { dev: [], holdout: [], ood: [] };
for (const t of all) groups[segmentOf(t.id)].push(t);
const hashes = Object.fromEntries(SEGMENTS.map((s) => [s, fp(groups[s])])) as Record<Segment, string>;
const sourceHash = fp(all);

const buildManifest = () => ({
  version: 1,
  frozenAt: new Date().toISOString(),
  rule: "segmentOf(id) = sha1(id)[0] mod 3 → dev/holdout/ood；三段覆盖全部真实任务且互不相交",
  sources: ["data/eval-tasks.jsonl", "data/tasks/v2/l2.jsonl"],
  sourceHash,
  sourceTaskCount: all.length,
  segments: Object.fromEntries(SEGMENTS.map((s) => [s, {
    ids: groups[s].map((t) => t.id),
    hash: hashes[s],
    count: groups[s].length,
    searchAccessible: s === "dev",
  }])),
  note: "OOD 完全只读、holdout 仅发布前验证、dev 允许搜索；任务集一旦冻结，任何改动必须由 segments:check 检出。",
});

if (process.argv.includes("--freeze")) {
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(buildManifest(), null, 2) + "\n");
  console.log(`已重冻结三段任务集：${all.length} 个任务 → dev ${groups.dev.length} / holdout ${groups.holdout.length} / ood ${groups.ood.length}`);
  process.exit(0);
}

// ---- 只读校验 ----
const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as ReturnType<typeof buildManifest>;
let checks = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  assert.ok(cond, `${label}${detail ? `：${detail}` : ""}`);
  checks += 1;
};

ok("manifest 版本为 1", m.version === 1);
ok("源任务集指纹一致（冻结：任何任务改动都需 --freeze）", m.sourceHash === sourceHash, `${m.sourceHash} vs ${sourceHash}`);
ok("源任务数一致", m.sourceTaskCount === all.length, `${m.sourceTaskCount} vs ${all.length}`);

const declaredIds = SEGMENTS.flatMap((s) => m.segments[s].ids);
ok("manifest 声明的 id 无重复", new Set(declaredIds).size === declaredIds.length);
ok("三段 ids 并集等于全部真实任务",
  new Set(declaredIds).size === all.length && declaredIds.every((id) => all.some((t) => t.id === id)));
for (const s of SEGMENTS) {
  ok(`${s} 段 ids 与重算一致`, JSON.stringify(m.segments[s].ids) === JSON.stringify(groups[s].map((t) => t.id)));
  ok(`${s} 段指纹与重算一致`, m.segments[s].hash === hashes[s], `${m.segments[s].hash} vs ${hashes[s]}`);
  ok(`${s} 段非空`, groups[s].length > 0);
}
for (let i = 0; i < SEGMENTS.length; i += 1) {
  for (let j = i + 1; j < SEGMENTS.length; j += 1) {
    const a = new Set(m.segments[SEGMENTS[i]!].ids);
    ok(`${SEGMENTS[i]} 与 ${SEGMENTS[j]} 互不相交`, m.segments[SEGMENTS[j]!].ids.every((id) => !a.has(id)));
  }
}
ok("三段指纹互异", new Set(Object.values(hashes)).size === 3);
ok("OOD 完全只读", m.segments.ood.searchAccessible === false);
ok("holdout 不参与搜索", m.segments.holdout.searchAccessible === false);
ok("dev 允许搜索", m.segments.dev.searchAccessible === true);
ok("每个 id 的归属与规则一致", SEGMENTS.every((s) => m.segments[s].ids.every((id) => segmentOf(id) === s)));
ok("规则确定性", all.every((t) => segmentOf(t.id) === segmentOf(t.id)));

// ---- 接线：真实三段指纹作为 judgePromotion 的合法输入 ----
const legal: PromotionSpec = {
  id: "segments-input-contract",
  before: { dev: 0, holdout: 1, ood: 1 },
  after: { dev: 1, holdout: 1, ood: 1 },
  hashes: {
    dev: [hashes.dev, hashes.dev],
    holdout: [hashes.holdout, hashes.holdout],
    ood: [hashes.ood, hashes.ood],
  },
  searchTouchedHashes: [hashes.dev],
  available: { dev: true, holdout: true, ood: true },
  protocolViolationsAfter: 0, integrityOk: true, usedGroundTruthVerifier: false,
};
ok("真实三段指纹喂判定机器：合法晋升接受", judgePromotion(legal).promoted);
ok("自报增益不参与判定", judgePromotion({ ...legal, selfReportedGain: 999 }).promoted);

// ---- 改坏必红：每个反例只叠加一个受控违规信号 ----
const mutate = (f: (s: PromotionSpec) => void): PromotionSpec => {
  const s: PromotionSpec = JSON.parse(JSON.stringify(legal));
  f(s);
  return s;
};
const rejects = (label: string, f: (s: PromotionSpec) => void, kw: string) => {
  const v = judgePromotion(mutate(f));
  ok(label, !v.promoted && v.reasons.some((r) => r.includes(kw)), v.reasons.join("; "));
};
rejects("OOD 混入搜索轨迹即阻断", (s) => { s.searchTouchedHashes.push(hashes.ood); }, "只读");
rejects("三段不互异即拒绝", (s) => { s.hashes.holdout = [hashes.dev, hashes.dev]; }, "未真正留出");
rejects("静默缺格即拒绝", (s) => { s.available.ood = false; }, "缺格");
rejects("段内任务漂移即拒绝", (s) => { s.hashes.dev[1] = "tampered"; }, "被改动");
rejects("dev 未提升即拒绝", (s) => { s.after.dev = s.before.dev; }, "dev 未严格提升");
rejects("OOD 退化即阻断", (s) => { s.after.ood = 0; }, "退化即阻断");

// ---- 幂等报告 ----
const payload = {
  version: 1, sourceHash, sourceTaskCount: all.length,
  counts: Object.fromEntries(SEGMENTS.map((s) => [s, groups[s].length])),
  hashes, checks, verdict: "pass",
  note: [
    "真实任务集三段冻结的输入契约门禁；不是 promote.ts 接入 RSI 主循环，阶段 C 仍停在 B。",
    "leadership.verdict 仍为 not-proven，L4 仍为 not-achieved；不产生能力分数。",
  ],
};
mkdirSync(dirname(REPORT), { recursive: true });
const body = JSON.stringify(payload, null, 2) + "\n";
try { if (readFileSync(REPORT, "utf8") !== body) writeFileSync(REPORT, body); }
catch { writeFileSync(REPORT, body); }

console.log(`真实任务 ${all.length} 个 → dev ${groups.dev.length} / holdout ${groups.holdout.length} / ood ${groups.ood.length}`);
console.log(`三段指纹 dev=${hashes.dev} holdout=${hashes.holdout} ood=${hashes.ood}`);
console.log(`✓ 三段分层门禁：${checks}/${checks} 项断言通过（含真实分段→判定机器接线、改坏必红）`);
