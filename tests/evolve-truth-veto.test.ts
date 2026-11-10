/**
 * bro2 · 外部真值段接入 evolve 晋升闭环的契约测试（v2.23.0）
 *
 * 目标：证明 truth 段不是「恒定绿灯的仪表盘」，而是能真正挡住错误晋升的独立约束。
 * 正反对照（同一隔离 root、同样候选序列，只换 truth 任务集）：
 *   - truth 全过 → 三段判据通过的候选正常晋升，truthCurve 全 1、truthVetoes=0；
 *   - truth 恒失败（reference 与脚本产出不可能匹配）→ 三段判据通过的候选被独立 veto，
 *     truthCurve 出现 <1、truthVetoes>=1、promoted=0、账本留下「外部真值 veto」证据。
 * 三段判据完全不看 truth，所以两组的 verdict.promoted 序列相同，唯一变量是外部真值通过率。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync,
  symlinkSync, readFileSync, existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runEvolve } from "../src/rsi/index.ts";

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 构造最小隔离 root：config/presets/skills 软链真实 ROOT（只读），复制三段任务集，注入指定 truth 集。 */
function makeRoot(truthTasks: string): string {
  const root = mkdtempSync(join(tmpdir(), "bro2-truth-veto-"));
  for (const d of ["presets", "skills"]) {
    const real = join(REAL_ROOT, d);
    if (existsSync(real)) symlinkSync(real, join(root, d), "dir");
  }
  symlinkSync(join(REAL_ROOT, "agentos.config.json"), join(root, "agentos.config.json"));
  mkdirSync(join(root, "data", "evolve"), { recursive: true });
  for (const f of ["train.jsonl", "holdout.jsonl", "ood.jsonl"]) {
    copyFileSync(join(REAL_ROOT, "data", "evolve", f), join(root, "data", "evolve", f));
  }
  writeFileSync(join(root, "data", "truth-tasks.jsonl"), truthTasks);
  return root;
}

// 恒失败 truth：脚本产出 "ACTUAL"，answer-equals-reference 要求一个永不匹配的哨兵值。
// 唯一失败来源就是外部 oracle（终答非空、无工具、无协议违规），保证 overall 稳定 <1。
const FAIL_TRUTH =
  '{"id":"truth-veto","category":"tool-use","input":"直接输出 ACTUAL","maxSteps":2,' +
  '"script":[{"content":"ACTUAL"}],"oracle":{"id":"answer-equals-reference","reference":"NEVER_MATCH_SENTINEL"}}\n';

const PASS_TRUTH = readFileSync(join(REAL_ROOT, "data", "truth-tasks.jsonl"), "utf8");

async function evolve(truthTasks: string) {
  const root = makeRoot(truthTasks);
  const scratch = mkdtempSync(join(tmpdir(), "bro2-truth-scratch-"));
  try {
    const report = await runEvolve({ root, reset: true, dryRun: true, scratchDir: scratch, generations: 8 });
    const ledger = readFileSync(join(scratch, "ledger.jsonl"), "utf8");
    return { report, ledger };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("外部真值全过：三段通过的候选正常晋升，truth 段被真实复核且零 veto", async () => {
  const { report } = await evolve(PASS_TRUTH);
  assert.ok(report.truthCurve.length >= 1, "至少有一次三段判据通过、触发了外部真值复核");
  assert.ok(report.truthCurve.every((r) => r === 1), `默认 state 下 truth 应全过，实际 ${report.truthCurve}`);
  assert.equal(report.truthVetoes, 0, "外部真值未退化，不应 veto");
  assert.ok(report.promoted >= 1, `三段通过 + 外部真值全过应能晋升，实际 ${report.promoted}`);
});

test("外部真值退化：三段判据通过的候选被独立 veto，零晋升且留下账本证据", async () => {
  const { report, ledger } = await evolve(FAIL_TRUTH);
  assert.ok(report.truthCurve.length >= 1, "三段判据通过的候选触发了外部真值复核");
  assert.ok(report.truthCurve.some((r) => r < 1), `外部真值必须出现退化，实际 ${report.truthCurve}`);
  assert.ok(report.truthVetoes >= 1, `外部真值退化必须产生 veto，实际 ${report.truthVetoes}`);
  assert.equal(report.promoted, 0, "外部真值恒失败时，任何三段通过的候选都不得晋升");
  assert.match(ledger, /外部真值 veto/, "账本必须留下可复核的 veto 原因");
});

test("正反对照：唯一变量是外部真值通过率，promoted 的差异由 veto 造成", async () => {
  const pass = await evolve(PASS_TRUTH);
  const fail = await evolve(FAIL_TRUTH);
  assert.ok(pass.report.promoted > fail.report.promoted, "全过组晋升数必须严格大于恒失败组");
  assert.equal(fail.report.promoted, 0);
  assert.ok(pass.report.truthVetoes === 0 && fail.report.truthVetoes >= 1);
});
