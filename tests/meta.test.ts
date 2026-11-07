/**
 * meta RSI · 单元测试（纯函数，不跑完整 evolve，避免与正式 meta 迭代并发）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkMetaPatch, applyMetaPatch, proposeMetaCandidates, metaPaths, loadMeta,
} from "../src/rsi/index.ts";
import { DEFAULT_META } from "../src/rsi/types.ts";
import type { MetaPatch } from "../src/rsi/index.ts";
import type { EvolveReport } from "../src/rsi/types.ts";
import { measureMetaFitness, metaPromotionOk } from "../src/benchmark/scoring.ts";

const mk = (key: string, to: unknown, from?: unknown): MetaPatch => ({
  id: "t", key: key as MetaPatch["key"], from: from ?? (DEFAULT_META as Record<string, unknown>)[key], to, reason: "t",
});

const synth = (curve: number[], runs: number, promoted: number): EvolveReport =>
  ({
    promoted, evalRuns: runs, trainCurve: curve, holdoutCurve: curve,
    integrity: { ok: true, files: 0, changed: [] },
  }) as unknown as EvolveReport;

test("元层写保护：放松 holdout 严格晋升的取值被 critical 拦截", () => {
  const r = checkMetaPatch(mk("promotionStrictness", "lenient"), DEFAULT_META);
  assert.equal(r.ok, false);
  assert.equal(r.severity, "critical");
  assert.match(r.reason, /白名单/);
});

test("元层写保护：验证面字段名被拒绝", () => {
  const r = checkMetaPatch(mk("evalThreshold", 0), DEFAULT_META);
  assert.equal(r.ok, false);
  assert.match(r.reason, /验证面|未知元维度/);
});

test("元层写保护：越界 / 陈旧 diff / 未知枚举", () => {
  assert.equal(checkMetaPatch(mk("plateauPatience", 99), DEFAULT_META).ok, false);
  assert.equal(checkMetaPatch(mk("evidenceLimit", 8, 999), DEFAULT_META).ok, false);
  assert.equal(checkMetaPatch(mk("candidateOrder", "bogus"), DEFAULT_META).ok, false);
});

test("合规元候选通过，且明确不触碰验证层级", () => {
  const r = checkMetaPatch(mk("plateauPatience", 1), DEFAULT_META);
  assert.equal(r.ok, true);
  assert.match(r.reason, /不触碰验证层级/);
});

test("applyMetaPatch 单原子 + 非法值回退白名单", () => {
  const next = applyMetaPatch(DEFAULT_META, mk("plateauPatience", 1));
  assert.equal(next.plateauPatience, 1);
  assert.equal(next.evidenceLimit, DEFAULT_META.evidenceLimit);
  assert.equal(applyMetaPatch(DEFAULT_META, mk("candidateOrder", "bogus")).candidateOrder, "weight");
});

test("元候选是单原子、白名单内、不指向验证面", () => {
  const cands = proposeMetaCandidates(DEFAULT_META);
  assert.ok(cands.length >= 5);
  for (const p of cands) {
    assert.ok(!/gate|threshold|eval|task|holdout|score/i.test(p.key));
    assert.equal(checkMetaPatch(p, DEFAULT_META).ok, true);
  }
  const next = applyMetaPatch(DEFAULT_META, mk("plateauPatience", 1));
  assert.ok(proposeMetaCandidates(next).every((p) => p.key !== "plateauPatience"));
});

test("冻结 fitness：可复现、效率提升可测、权重固定", () => {
  const a = measureMetaFitness(synth([0.5, 0.75, 1, 1], 22, 3));
  const b = measureMetaFitness(synth([0.5, 0.75, 1, 1], 22, 3));
  assert.equal(a.score, b.score);
  assert.equal(a.finalHoldout, 1);
  // score 与 efficiency 各自 4 位舍入，容差取 1e-3
  assert.ok(Math.abs(a.score - (0.6 * 1 + 0.4 * Math.min(1, a.efficiency))) < 1e-3);
  const faster = measureMetaFitness(synth([0.5, 0.75, 1], 18, 3));
  assert.ok(faster.score > a.score);
});

test("元晋升硬前提：能力退化 / 保护面破损一律拒绝", () => {
  const base = measureMetaFitness(synth([0.5, 0.75, 1, 1], 22, 3));
  const faster = measureMetaFitness(synth([0.5, 0.75, 1], 18, 3));
  const degraded = measureMetaFitness(synth([0.5, 0.75, 0.8], 10, 1));
  assert.equal(metaPromotionOk(base, faster, true), true);
  assert.equal(metaPromotionOk(base, degraded, true), false);
  assert.equal(metaPromotionOk(base, faster, false), false);
});

test("meta 状态持久化路径与默认值", () => {
  const p = metaPaths("/tmp/bro2-meta-test");
  assert.ok(p.state.endsWith("meta-state.json"));
  assert.ok(p.report.endsWith("meta-report.json"));
  assert.deepEqual(loadMeta("/tmp/bro2-meta-test-nonexistent"), DEFAULT_META);
});
