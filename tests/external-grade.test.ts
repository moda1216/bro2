/**
 * v2.20.0 · 外部真值 oracle 评测（把「自指评分」变成「外部可证伪评分」）
 *
 * 这是 bro2 朝向「诚实可验证自演进」迈出的关键一步：在此之前，grade() 只能断言
 * harness 自身的**行为分支是否触发**（expectedTools / expectRepair / expectGroundingReject …），
 * 属于「自指评分」——agent 让框架内部行为「看起来对了」就能通过，而未必真的产出了正确结果。
 *
 * 外部 oracle 改变了这一点：grading 只读 agent 的**实际产出**（终答 / 工作区文件）与一份
 * agent 不可见的 reference 比对，绝不读 harness 内部行为指标。agent 只能靠「真正产出正确
 * 结果」通过 oracle。这正是 RSI 闭环「能力提升」应当对照的独立真值。
 *
 * 注意：runEval 的 runOne 直接调用 grade()，因此 oracle 判定自然汇入 summary.overall——
 * 一个带 oracle 的评测任务集会据此计算通过率，使 evolve 的晋升判定相对独立真值而非自我确认。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grade, extract, listOracles } from "../src/observability/eval-grade.ts";
import type { RunResult } from "../src/kernel/loop.ts";
import type { EvalTask } from "../src/observability/eval.ts";

const ws = mkdtempSync(join(tmpdir(), "bro2-ext-grade-"));

/** 一个「行为全绿」的运行：没有协议违规、终答非空、停止原因正常。 */
const cleanRun = (answer: string): RunResult =>
  ({ stoppedBy: "completed", answer, toolCallCount: 1, steps: 0 }) as unknown as RunResult;

/** 只带 oracle、不带任何其它 expected* 断言的任务，隔离验证 oracle 的判定。 */
const oracleTask = (oracle: EvalTask["oracle"]): EvalTask =>
  ({ id: "ext", category: "robustness", input: "x", oracle }) as unknown as EvalTask;

test("oracle 注册表内置 answer / file 两类真值判分", () => {
  const ids = listOracles();
  assert.ok(ids.includes("answer-matches-reference"));
  assert.ok(ids.includes("answer-equals-reference"));
  assert.ok(ids.includes("file-contains-reference"));
});

test("answer-matches-reference：终答命中真值 → 通过；未命中 → 明确失败", () => {
  const task = oracleTask({ id: "answer-matches-reference", reference: "SECRET-42" });
  const good = grade(task, cleanRun("过程略，结论 SECRET-42 已达成"), extract([]), ws);
  assert.equal(good.length, 0, `命中时不应有任何 reason：${good}`);
  const bad = grade(task, cleanRun("过程略，结论未达成"), extract([]), ws);
  assert.ok(bad.some((r) => r.includes("外部 oracle answer-matches-reference")), `未命中应被 oracle 拦截：${bad}`);
  // 大小写不敏感
  const ci = grade(task, cleanRun("secret-42 ok"), extract([]), ws);
  assert.equal(ci.length, 0);
});

test("answer-equals-reference：精确相等才通过（trim 后）", () => {
  const task = oracleTask({ id: "answer-equals-reference", reference: "EXACT" });
  assert.equal(grade(task, cleanRun("EXACT"), extract([]), ws).length, 0);
  assert.ok(grade(task, cleanRun("EXACTX"), extract([]), ws).some((r) => r.includes("oracle")));
});

test("file-contains-reference：真实工作区文件含真值才通过", () => {
  const task = oracleTask({ id: "file-contains-reference", reference: "BUILD-OK", expect: "out.txt" });
  const missing = grade(task, cleanRun("x"), extract([]), ws);
  assert.ok(missing.some((r) => r.includes("期望文件未生成")), `文件不存在应被拦截：${missing}`);
  // 写出真实文件再判
  writeFileSync(join(ws, "out.txt"), "step1\ndone: BUILD-OK\nstep3");
  const ok = grade(task, cleanRun("x"), extract([]), ws);
  assert.equal(ok.length, 0, `文件含真值时应通过：${ok}`);
});

test("未知 oracle id → 明确报错，不静默放行", () => {
  const task = oracleTask({ id: "no-such-oracle", reference: "x" });
  const r = grade(task, cleanRun("anything"), extract([]), ws);
  assert.ok(r.includes("未知 oracle: no-such-oracle"));
});

test("独立性：oracle 只看产出、不读 harness 行为指标", () => {
  // 即便 harness 行为全绿（extract([]) 零违规）、工具也调了，只要终答不对，oracle 仍判失败。
  const task = oracleTask({ id: "answer-matches-reference", reference: "TARGET" });
  const wrong = grade(task, cleanRun("行为与治理都完美，但答案错"), extract([]), ws);
  assert.ok(wrong.some((r) => r.includes("oracle")), `产出错误时不应因行为全绿而蒙混：${wrong}`);
  // 反向：产出正确时 oracle 通过，且不受无关行为指标影响（extract([]) 为干净摘要）。
  const ok = grade(task, cleanRun("TARGET reached"), extract([]), ws);
  assert.equal(ok.length, 0, `产出正确时 oracle 应通过，且不受无关行为指标影响：${ok}`);
});
