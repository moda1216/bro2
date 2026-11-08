/**
 * v2.2.0 · 迭代水位 + 惰性真实探测 的回归门禁
 * 覆盖：冻结尺子唯一性、前缀投影、只读性、协议违规排除、惰性探测成本真实性。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VelocityLedger, velocitySnapshotFrom, MIN_SAMPLES,
} from "../src/rsi/velocity.ts";
import type { AttemptRecord } from "../src/rsi/velocity.ts";
import { ExperienceBank, failureSignature } from "../src/rsi/experience.ts";
import { compoundProbe } from "../src/rsi/compound.ts";
import type { PendingCandidate } from "../src/rsi/compound.ts";
import {
  buildWatermark, formatWatermark, renderWatermarkHtml, WATERMARK_VERSION,
} from "../src/rsi/watermark.ts";
import { markdownWatermark } from "../scripts/watermark-doc.ts";
import type { RunSummary } from "../src/rsi/contrast.ts";

function tmp(): string { return mkdtempSync(join(tmpdir(), "bro2-watermark-test-")); }
const rec = (over: Partial<AttemptRecord> = {}): Omit<AttemptRecord, "seq" | "ts"> => ({
  attempts: 3, experienceHits: 0, firstTryHit: true, improvement: 1,
  probesAvoided: 0, usedFallback: false, protocolViolations: 0, ...over,
});

const baseline: RunSummary = {
  steps: 10, toolCalls: 3, toolErrors: 4, loopAdvisories: 2,
  groundingRejects: 0, protocolViolations: 0, missingTool: false, answerMatches: false,
};
const realFix: RunSummary = {
  ...baseline, toolErrors: 0, loopAdvisories: 0, toolCalls: 4, steps: 8,
};
const pending: PendingCandidate[] = [
  { id: "fix-real", description: "真修复", focus: "tool-error" },
  { id: "no-op", description: "空调整", focus: "loop" },
  { id: "fake-gain", description: "只抬自报分数", focus: "tool-error", scoreGain: 0.8 },
];
const probedOf = (id: string): RunSummary => id === "fix-real" ? realFix : baseline;

test("冻结尺子唯一：Ledger.snapshot 与模块级纯函数完全一致", () => {
  const dir = tmp();
  try {
    const p = join(dir, "v.jsonl");
    const ledger = new VelocityLedger(p);
    for (let i = 0; i < 9; i += 1) {
      ledger.append(rec({ attempts: i === 0 ? 3 : 2, probesAvoided: i === 0 ? 0 : 1, experienceHits: i === 0 ? 0 : 1 }));
    }
    const records = ledger.records();
    assert.deepEqual(ledger.snapshot(), velocitySnapshotFrom(records));
    assert.equal(ledger.snapshot().trend, "accelerating");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("样本不足一律 insufficient-data，达到阈值才允许判定", () => {
  const dir = tmp();
  try {
    const p = join(dir, "v.jsonl");
    const ledger = new VelocityLedger(p);
    for (let i = 0; i < MIN_SAMPLES - 1; i += 1) ledger.append(rec());
    assert.equal(ledger.snapshot().trend, "insufficient-data");
    assert.match(ledger.snapshot().honesty.reason, /禁止宣称加速或减速/);
    ledger.append(rec());
    assert.notEqual(ledger.snapshot().trend, "insufficient-data");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("协议违规轮不计入趋势，但仍留在只增账本里", () => {
  const dir = tmp();
  try {
    const p = join(dir, "v.jsonl");
    const ledger = new VelocityLedger(p);
    for (let i = 0; i < 8; i += 1) ledger.append(rec({ attempts: i < 4 ? 3 : 2 }));
    ledger.append(rec({ protocolViolations: 2, improvement: 0, attempts: 9 }));
    const s = ledger.snapshot();
    assert.equal(s.samples, 9);
    assert.equal(s.usableSamples, 8);
    assert.ok(s.avgAttempts < 3, "违规轮的高 attempts 不得污染趋势");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("水位报告是只读投影：不改账本、逐轮趋势由同一把尺子前缀计算", () => {
  const dir = tmp();
  try {
    const vp = join(dir, "v.jsonl"), ep = join(dir, "e.jsonl");
    const ledger = new VelocityLedger(vp);
    for (let i = 0; i < 8; i += 1) {
      ledger.append(rec({ attempts: i === 0 ? 3 : 2, probesAvoided: i === 0 ? 0 : 1, experienceHits: i === 0 ? 0 : 1 }));
    }
    const before = readFileSync(vp, "utf8");
    const report = buildWatermark(ledger, new ExperienceBank(ep));
    assert.equal(readFileSync(vp, "utf8"), before, "buildWatermark 不得 append 或改写账本");
    assert.equal(report.points.length, 8);
    assert.equal(report.version, WATERMARK_VERSION);
    assert.equal(report.current.trend, "accelerating");
    assert.equal(report.firstAcceleratingAt, 5);
    // 每个前缀点必须等于「用同一把尺子对该前缀单独计算」的结果
    const records = ledger.records();
    for (const p of report.points) {
      assert.equal(p.trend, velocitySnapshotFrom(records.slice(0, p.seq + 1)).trend);
      assert.equal(p.cumulativeIPA, velocitySnapshotFrom(records.slice(0, p.seq + 1)).improvementPerAttempt);
    }
    assert.equal(report.honesty.frozenMetric, true);
    assert.equal(report.honesty.selfReported, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("空账本：水位明确为 insufficient-data 且提示如何启动", () => {
  const dir = tmp();
  try {
    const report = buildWatermark(
      new VelocityLedger(join(dir, "v.jsonl")),
      new ExperienceBank(join(dir, "e.jsonl")),
    );
    assert.equal(report.points.length, 0);
    assert.equal(report.current.trend, "insufficient-data");
    assert.equal(report.firstAcceleratingAt, null);
    assert.match(formatWatermark(report), /尚未启动进化/);
    assert.match(renderWatermarkHtml(report), /账本为空/);
    assert.match(markdownWatermark(report), /账本为空/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTML / Markdown 视图含诚实边界且无异常数值", () => {
  const dir = tmp();
  try {
    const vp = join(dir, "v.jsonl"), ep = join(dir, "e.jsonl");
    const ledger = new VelocityLedger(vp);
    for (let i = 0; i < 8; i += 1) ledger.append(rec({ attempts: i === 0 ? 3 : 2 }));
    const report = buildWatermark(ledger, new ExperienceBank(ep));
    const html = renderWatermarkHtml(report);
    const md = markdownWatermark(report);
    assert.match(html, /迭代水位看板/);
    assert.match(html, /frozenMetric/);
    assert.match(html, /leadership.verdict=not-proven/);
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
    assert.equal((html.match(/<path d=/g) ?? []).length, 4, "四条曲线都要渲染");
    assert.match(md, /data\/rsi\/watermark\.html/);
    assert.match(md, /evolve:tick/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("惰性探测：被经验裁剪的候选不触发 probe，attempts 等于真实探测次数", () => {
  const dir = tmp();
  try {
    const ep = join(dir, "e.jsonl"), vp = join(dir, "v.jsonl");
    const sig = failureSignature(baseline);
    const results = [];
    for (let round = 1; round <= 3; round += 1) {
      let probeCalls = 0;
      const r = compoundProbe(baseline, pending, new ExperienceBank(ep), new VelocityLedger(vp), {
        signature: sig,
        probe: (c) => {
          probeCalls += 1;
          return { ...c, probed: probedOf(c.id) };
        },
      });
      assert.equal(probeCalls, r.attempts, `第 ${round} 轮真实探测次数必须等于 attempts`);
      results.push(r);
    }
    assert.equal(results[0].attempts, 3, "冷启动全量探测");
    assert.equal(results[1].attempts, 2, "有经验后裁剪到命中 + 1 探索位");
    assert.equal(results[2].probesAvoided, 1);
    assert.ok(results.every((r) => r.improvement === 1), "裁剪不能牺牲正确性");
    assert.ok(results.every((r) => r.rewardHackingBlocked >= 0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("未提供 probed 且未配置 probe 时必须拒绝，绝不伪造行为摘要", () => {
  const dir = tmp();
  try {
    assert.throws(
      () => compoundProbe(
        baseline, pending,
        new ExperienceBank(join(dir, "e.jsonl")),
        new VelocityLedger(join(dir, "v.jsonl")),
        { signature: failureSignature(baseline) },
      ),
      /拒绝伪造行为摘要/,
    );
    assert.equal(existsSync(join(dir, "v.jsonl")), false, "抛错时不得写入账本");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
