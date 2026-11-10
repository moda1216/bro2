/**
 * 三段晋升判据 judgePromotion 的行为契约（v2.11.0）：
 * 阶段 C「bro2 自提议自晋升」的前置闸门。判定只认三段真实行为分数 + 冻结任务集指纹，
 * 自报增益绝不参与。每个反例只破坏一条不变量，确保「判据改坏必红、退化即阻断」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgePromotion } from "../src/observability/eval-grade.ts";
import type { PromotionSpec } from "../src/observability/eval-grade.ts";

/** 合法晋升 spec：dev 提升、holdout/ood 不退化、三段 hash 互异、搜索只碰 dev、OOD 完全只读。 */
function legal(patch: Partial<PromotionSpec> = {}): PromotionSpec {
  return {
    id: "cand-1",
    before: { dev: 0.4, holdout: 0.8, ood: 0.7 },
    after: { dev: 0.7, holdout: 0.8, ood: 0.7 },
    hashes: { dev: ["D", "D"], holdout: ["H", "H"], ood: ["O", "O"] },
    searchTouchedHashes: ["D"],
    available: { dev: true, holdout: true, ood: true },
    protocolViolationsAfter: 0,
    integrityOk: true, usedGroundTruthVerifier: false,
    ...patch,
  };
}

test("合法晋升：dev 严格提升 + holdout/ood 不退化 + OOD 只读 → 接受", () => {
  const v = judgePromotion(legal());
  assert.equal(v.promoted, true, v.reasons.join("; "));
  assert.deepEqual(v.reasons, []);
  assert.equal(v.blockedByOod, false);
  assert.equal(v.rewardHackingBlocked, false);
  assert.ok(v.deltas.dev > 0 && v.deltas.holdout === 0 && v.deltas.ood === 0);
});

test("dev 未严格提升（持平 / 下降）→ 拒绝", () => {
  for (const dev of [0.4, 0.3]) {
    const v = judgePromotion(legal({ after: { dev, holdout: 0.8, ood: 0.7 } }));
    assert.equal(v.promoted, false);
    assert.ok(v.reasons.some((r) => r.includes("dev 未严格提升")));
  }
});

test("holdout 退化超过容差 → 拒绝", () => {
  const v = judgePromotion(legal({ after: { dev: 0.7, holdout: 0.6, ood: 0.7 } }));
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => r.includes("holdout 退化")));
});

test("OOD 退化 → 自动阻断，且 blockedByOod=true（供 journal 复核）", () => {
  const v = judgePromotion(legal({ after: { dev: 0.7, holdout: 0.8, ood: 0.5 } }));
  assert.equal(v.promoted, false);
  assert.equal(v.blockedByOod, true);
  assert.ok(v.reasons.some((r) => r.includes("OOD 退化") && r.includes("阻断")));
});

test("容差内的小幅退化允许（护栏口径 2pp）", () => {
  const s = legal({ after: { dev: 0.7, holdout: 0.79, ood: 0.69 }, tolerance: 0.02 });
  const v = judgePromotion(s);
  assert.equal(v.promoted, true, v.reasons.join("; "));
});

test("OOD 任务集出现在搜索轨迹 → 违反完全只读，拒绝", () => {
  const v = judgePromotion(legal({ searchTouchedHashes: ["D", "O"] }));
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => r.includes("只读")));
});

test("静默缺格 / 分数非 [0,1] → 拒绝（防 0 冒充缺失）", () => {
  const miss = judgePromotion(legal({ available: { dev: true, holdout: true, ood: false } }));
  assert.equal(miss.promoted, false);
  assert.ok(miss.reasons.some((r) => r.includes("缺格")));
  const oor = judgePromotion(legal({ after: { dev: 1.9, holdout: 0.8, ood: 0.7 } }));
  assert.equal(oor.promoted, false);
  assert.ok(oor.reasons.some((r) => r.includes("[0,1]")));
  const nan = judgePromotion(legal({ before: { dev: NaN, holdout: 0.8, ood: 0.7 } }));
  assert.equal(nan.promoted, false);
});

test("任务集在编辑前后被改动 → 对比失效，拒绝（防调难度刷分）", () => {
  const v = judgePromotion(legal({ hashes: { dev: ["D", "D2"], holdout: ["H", "H"], ood: ["O", "O"] } }));
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => r.includes("被改动")));
});

test("三段任务集指纹不互异 → 未真正留出，拒绝", () => {
  const v = judgePromotion(legal({ hashes: { dev: ["D", "D"], holdout: ["D", "D"], ood: ["O", "O"] } }));
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => r.includes("未真正留出")));
});

test("完整性 tripwire / 真值验证器 / 协议违规 → 治理不变量优先，拒绝", () => {
  const cases = [
    legal({ integrityOk: false }),
    legal({ usedGroundTruthVerifier: true }),
    legal({ protocolViolationsAfter: 2 }),
  ];
  for (const s of cases) {
    const v = judgePromotion(s);
    assert.equal(v.promoted, false);
    assert.ok(v.reasons.length > 0);
  }
});

test("自报增益绝不参与判定：塞大 selfReportedGain 不改变合法结论", () => {
  const clean = judgePromotion(legal());
  const withGain = judgePromotion(legal({ selfReportedGain: 999 }));
  assert.equal(withGain.promoted, clean.promoted);
  assert.deepEqual(withGain.reasons, clean.reasons);
});

test("自报增益 + 行为未过判据 → rewardHackingBlocked=true（仍拒绝）", () => {
  const v = judgePromotion(legal({ after: { dev: 0.4, holdout: 0.8, ood: 0.7 }, selfReportedGain: 0.9 }));
  assert.equal(v.promoted, false);
  assert.equal(v.rewardHackingBlocked, true);
});

test("外部真值 oracle 作独立佐证：不阻断晋升、只进审计", () => {
  const v = judgePromotion(legal({ usedExternalOracle: true }));
  assert.equal(v.promoted, true, v.reasons.join("; "));
  assert.equal(v.externalOracleCorroborated, true);
});

test("外部真值 oracle 与 harness 内部验证器互斥：后者仍拒绝晋升，前者仍标记佐证", () => {
  const v = judgePromotion(legal({ usedGroundTruthVerifier: true, usedExternalOracle: true }));
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => r.includes("真值验证器")));
  assert.equal(v.externalOracleCorroborated, true);
});

