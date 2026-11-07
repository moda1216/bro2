/**
 * bro2 · 外部证据导入通道防伪造实证（离线、确定性、无需任何 API Key）
 *
 * 核心断言不是「能导入文件」，而是：
 *  1) 伪造 / 畸形 / 自封结论 / 未来日期的记录全部被校验器拒绝；
 *  2) 这些记录不能把 L4 从 not-achieved 提上去；
 *  3) 合法外部结果最多把 L4 提到 partial，verdict 仍恒为 not-proven；
 *  4) bro2 自己生成的 benchmark-report.json 不算外部证据；
 *  5) 全程只在临时目录写文件，绝不污染真实的 data/benchmark/external-results.json。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateExternalResult, loadExternalResults,
  EXTERNAL_REQUIRED, EXTERNAL_OPTIONAL, EXTERNAL_FORBIDDEN_FIELDS,
} from "../src/benchmark/external.ts";
import { assessEvidenceLadder, EXTERNAL_RESULT_SCHEMA } from "../src/benchmark/ladder.ts";
import { PROTECTED_FILES } from "../src/rsi/guardrails.ts";

const ROOT = join(import.meta.dirname ?? "", "..");
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ""}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ""}`); }
};

const VALID: Record<string, unknown> = {
  benchmark: "BFCL-v3",
  model: "qwen3:8b",
  date: "2026-11-07",
  score: 0.87,
  metric: "overall_accuracy",
  tasks: 200,
  repeat: 3,
  confidenceInterval: [0.84, 0.9],
  harness: "bro2",
  reproducibleCommand: "npm run eval:live -- --tasks data/benchmark/bfcl.jsonl --k 3",
  notes: "需注明模型版本与评分脚本",
};

const scratch: string[] = [];
const tmpRoot = (): string => {
  const r = mkdtempSync(join(tmpdir(), "bro2-excheck-"));
  scratch.push(r);
  return r;
};
const extPath = (root: string): string => join(root, "data", "benchmark", "external-results.json");
const writeExternal = (root: string, content: unknown): void => {
  mkdirSync(join(root, "data", "benchmark"), { recursive: true });
  writeFileSync(extPath(root), JSON.stringify(content));
};
const reasonOf = (raw: unknown): string => {
  const r = validateExternalResult(raw);
  return r.ok ? "" : r.reason;
};
const l4Status = (root: string): string =>
  assessEvidenceLadder(root).levels.find((l) => l.id === 4)!.status;

console.log("\n" + "=".repeat(84));
console.log("  bro2 · 外部证据导入通道防伪造实证");
console.log("=".repeat(84));

try {
  // ---- 0) schema 与写保护 ----
  console.log("\n【0】schema 定义与写保护面");
  check("必填字段 6 项 / 可选字段 5 项", EXTERNAL_REQUIRED.length === 6 && EXTERNAL_OPTIONAL.length === 5);
  check("schema 与校验器同源（required）", JSON.stringify([...EXTERNAL_RESULT_SCHEMA.required]) === JSON.stringify([...EXTERNAL_REQUIRED]));
  check("schema 与校验器同源（forbidden）", JSON.stringify([...EXTERNAL_RESULT_SCHEMA.forbidden]) === JSON.stringify([...EXTERNAL_FORBIDDEN_FIELDS]));
  check("禁止结论字段包含 verdict / proven", EXTERNAL_FORBIDDEN_FIELDS.includes("verdict") && EXTERNAL_FORBIDDEN_FIELDS.includes("proven"));
  check("校验器在 PROTECTED_FILES 内", PROTECTED_FILES.includes("src/benchmark/external.ts"));
  check("评分面 / 阶梯 / 校验器三者同受保护",
    ["src/benchmark/scoring.ts", "src/benchmark/ladder.ts", "src/benchmark/external.ts"]
      .every((f) => PROTECTED_FILES.includes(f)),
    `保护面 ${PROTECTED_FILES.length} 文件`);

  // ---- 1) 单条记录：伪造与畸形 ----
  console.log("\n【1】单条记录校验（伪造 / 畸形 / 自封结论）");
  check("完整的合法示例通过", validateExternalResult(VALID).ok);
  check("空对象被拒", /缺少必填字段/.test(reasonOf({})));
  const { reproducibleCommand: _ignored, ...noCmd } = VALID;
  check("缺复现命令被拒", /reproducibleCommand/.test(reasonOf(noCmd)));
  check("score 越界被拒", /score/.test(reasonOf({ ...VALID, score: 1.5 })));
  check("score 字符串被拒", /score/.test(reasonOf({ ...VALID, score: "0.87" })));
  check("不存在的日历日期被拒", /date/.test(reasonOf({ ...VALID, date: "2026-02-30" })));
  check("未来日期被拒", /晚于今天/.test(reasonOf({ ...VALID, date: "2099-01-01" })));
  check("未知字段被拒", /未知字段/.test(reasonOf({ ...VALID, extra: 1 })));
  check("自带 verdict 被拒且归因精确", /结论字段/.test(reasonOf({ ...VALID, verdict: "proven" })));
  check("占位复现命令被拒", /复现命令/.test(reasonOf({ ...VALID, reproducibleCommand: "N/A" })));
  check("置信区间倒序被拒", /下界/.test(reasonOf({ ...VALID, confidenceInterval: [0.9, 0.8] })));
  check("tasks 非正整数被拒", /tasks/.test(reasonOf({ ...VALID, tasks: -1 })));

  // ---- 2) 文件级校验 ----
  console.log("\n【2】文件级校验");
  const r0 = tmpRoot();
  const v0 = loadExternalResults(extPath(r0));
  check("文件不存在 = 未导入且不算错误", v0.ok && v0.submitted === 0 && v0.fileErrors.length === 0);
  const r1 = tmpRoot();
  mkdirSync(join(r1, "data", "benchmark"), { recursive: true });
  writeFileSync(extPath(r1), JSON.stringify({ result: [] }));
  check("顶层格式错记为文件错误", /顶层/.test(loadExternalResults(extPath(r1)).fileErrors.join(" ")));
  writeFileSync(extPath(r1), "{not json");
  check("非法 JSON 记为文件错误", /JSON 解析失败/.test(loadExternalResults(extPath(r1)).fileErrors.join(" ")));
  const r2 = tmpRoot();
  writeExternal(r2, { results: [VALID, {}, VALID] });
  const v2 = loadExternalResults(extPath(r2));
  check("混合记录只采纳合法项且被拒项带索引",
    v2.submitted === 3 && v2.accepted.length === 2 && v2.rejected.length === 1 && v2.rejected[0]!.index === 1,
    `采纳 ${v2.accepted.length} / 拒绝 ${v2.rejected.length}`);

  // ---- 3) 证据阶梯不被伪造撼动 ----
  console.log("\n【3】伪造证据不能提升 L4");
  const f1 = tmpRoot();
  writeExternal(f1, { results: [{}] });
  const a1 = assessEvidenceLadder(f1);
  check("一条空记录：L4 仍 not-achieved", a1.levels.find((l) => l.id === 4)!.status === "not-achieved");
  check("一条空记录：拒绝数被如实记录", a1.externalValidation.rejected.length === 1);
  check("一条空记录：verdict 仍 not-proven", a1.claim.verdict === "not-proven");

  const f2 = tmpRoot();
  writeExternal(f2, { results: [
    { ...VALID, verdict: "proven" },
    { ...VALID, date: "2099-01-01" },
    { ...VALID, reproducibleCommand: "TODO" },
  ] });
  const a2 = assessEvidenceLadder(f2);
  check("结论字段 / 未来日期 / 占位命令全部被拒", a2.externalValidation.rejected.length === 3,
    `拒绝 ${a2.externalValidation.rejected.length}/3`);
  check("三条伪造记录：L4 仍 not-achieved", a2.levels.find((l) => l.id === 4)!.status === "not-achieved");

  const f3 = tmpRoot();
  mkdirSync(join(f3, "data"), { recursive: true });
  writeFileSync(join(f3, "data", "benchmark-report.json"), JSON.stringify({
    ablation: [], external: [{ ...VALID, verdict: "proven" }],
  }));
  const a3 = assessEvidenceLadder(f3);
  check("benchmark-report.json 手塞 external 不算外部证据",
    a3.levels.find((l) => l.id === 4)!.status === "not-achieved" && a3.claim.externalBenchmarksImported === 0);

  // ---- 4) 合法结果只到 partial ----
  console.log("\n【4】合法外部结果：只到 partial，绝不自动宣布领先");
  const g = tmpRoot();
  writeExternal(g, { results: [VALID, { ...VALID, benchmark: "tau-bench", score: 0.79 }] });
  const ag = assessEvidenceLadder(g);
  check("合法记录全部被采纳", ag.externalValidation.accepted === 2 && ag.externalValidation.rejected.length === 0);
  check("L4 升为 partial（不是 achieved）", ag.levels.find((l) => l.id === 4)!.status === "partial");
  check("verdict 仍恒为 not-proven", ag.claim.verdict === "not-proven");
  check("externalBenchmarksImported = 采纳数而非提交数", ag.claim.externalBenchmarksImported === 2);
  check("已采纳基准名进入摘要", ag.externalValidation.benchmarks.sort().join(",") === "BFCL-v3,tau-bench");
  check("L4 缺口明确要求第三方复核", /第三方/.test(ag.levels.find((l) => l.id === 4)!.gap));

  // ---- 5) 真实项目状态不被污染 ----
  console.log("\n【5】真实项目状态");
  const realExternal = join(ROOT, "data", "benchmark", "external-results.json");
  check("未创建真实外部结果文件", !existsSync(realExternal), "实证全程只在临时目录写入");
  const ar = assessEvidenceLadder(ROOT);
  check("真实项目 L4 仍 not-achieved", ar.levels.find((l) => l.id === 4)!.status === "not-achieved");
  check("真实项目 verdict = not-proven", ar.claim.verdict === "not-proven");
  check("真实项目无外部证据提交记录", ar.externalValidation.submitted === 0);
} finally {
  for (const r of scratch) rmSync(r, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(84));
console.log(`  结果: ${pass} / ${pass + fail} 通过` + (fail ? `  ✗ ${fail} 项失败` : "  ✓ ALL PASS"));
console.log("=".repeat(84) + "\n");
if (fail > 0) process.exitCode = 1;
