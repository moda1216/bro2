/**
 * bro2 · 代码预算阈值完整性契约（v2.25.0）
 *
 * 堵住的漏洞：scripts/loc-budget.ts 直接把 data/plan/budget.json 的 limits 当判据，
 * 而该文件不受任何哈希/契约保护——把 sourceLines 16500 改成 20000，所有预算门禁
 * 立刻「通过」，前面所有版本「预算纪律守住」的结论可被一行 JSON 静默抹掉。
 * 这是「判据随可操纵输入浮动」的最底层放大版（同 v2.24.0 否决的相对基线放水）。
 *
 * 修法（不硬禁、留合法通道）：冻结一份 FLOOR（= 发布时的 limits），断言运行时
 * limits 只能 ≤ FLOOR 且 runtimeDependencies 恒 0。于是：
 *   - 下调阈值（更严格）：随时允许，测试不拦；
 *   - 上调阈值（放水）：必须先显式改本测试的 FLOOR + 在 docs/BENCH-v2.md 记理由，
 *     否则 npm test 挂 → project:status 的 budget/test 门禁挂 → 发布被阻断。
 * 把「静默暗调」变成「显式、可见、需留痕」的动作，杜绝 reward hacking 捷径。
 *
 * 前提已核实：budget.json 是纯只读输入（全仓无 writeFile/stringify 回写），
 * autopilot 只读 battles 字段，冻结 limits 不影响运行期。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Budget {
  baseline?: Record<string, number>;
  limits: {
    sourceFiles: number; sourceLines: number;
    maxFileLines: number; minTestToSourceRatio: number;
  };
  runtimeDependencies: number;
  battles?: Record<string, number>;
  note?: string;
}

function loadBudget(): Budget {
  return JSON.parse(readFileSync(join(ROOT, "data", "plan", "budget.json"), "utf8")) as Budget;
}

// 冻结下限：v2.25.0 发布时的 limits。上调任一数值都必须同步改这里并写明理由。
const FLOOR = {
  sourceFiles: 90,
  sourceLines: 16500,
  maxFileLines: 700,
  minTestToSourceRatio: 0.15,
} as const;

const LIMIT_KEYS = ["sourceFiles", "sourceLines", "maxFileLines", "minTestToSourceRatio"] as const;
type Limits = Budget["limits"];

/** 返回所有「被上调」的阈值名；空数组 = 合规。与 loc-budget.ts 的判据解耦，独立可测。 */
function raisedLimits(limits: Limits): string[] {
  return LIMIT_KEYS.filter((k) => typeof limits[k] !== "number" || limits[k]! > FLOOR[k]);
}

test("预算 limits 不得被静默上调（≤ 冻结 FLOOR）", () => {
  const raised = raisedLimits(loadBudget().limits);
  assert.deepEqual(raised, [],
    `代码预算阈值被上调：${raised.join(", ")}。上调须先改本测试 FLOOR 并在 docs/BENCH-v2.md 记录理由，不允许静默改 budget.json 放行。`);
});

test("运行时依赖恒为 0（不受 budget.json 数值放宽）", () => {
  assert.equal(loadBudget().runtimeDependencies, 0, "运行时第三方依赖必须恒为 0");
});

test("可证伪：合规/下调放行，任一阈值上调都被 raisedLimits 抓下", () => {
  const clean: Limits = { ...FLOOR };
  assert.deepEqual(raisedLimits(clean), [], "冻结值本身必须合规（契约不能恒真报警）");
  const stricter: Limits = { ...FLOOR, sourceLines: FLOOR.sourceLines - 1000 };
  assert.deepEqual(raisedLimits(stricter), [], "下调阈值（更严格）应放行");
  for (const k of LIMIT_KEYS) {
    const tampered: Limits = { ...FLOOR, [k]: FLOOR[k] + 1 };
    assert.deepEqual(raisedLimits(tampered), [k], `上调 ${k} 必须被精确检出`);
  }
});

test("note 约定仍在：上调须留痕（防止连治理说明一起被删）", () => {
  assert.match(loadBudget().note ?? "", /上调.*理由|记录理由/, "budget.json 必须保留『上调需记录理由』的约定");
});
