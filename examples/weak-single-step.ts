#!/usr/bin/env node
/**
 * weak:probe · 弱模型单步准入探针（v2.14.0）
 * ----------------------------------------------------------
 * 只回答一个问题：链路修通后，本地小模型能不能完成一次工具任务？
 *
 * 红线（与 BENCH-v2 §5.9 一致）：只有 stoppedBy === "completed" 且协议零违规
 * 才算有效测量；provider_error / cancelled / timeout 一律记为
 * insufficient-runtime，不进能力证据集、不写成「模型太弱」。
 *
 * 可复现：AGENTOS_LIVE_PROVIDER 指定端点；运行时墙钟只在本脚本覆盖，
 * 不改全局配置、不改任何门禁阈值。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THRESHOLDS, runEval } from "../src/observability/eval.ts";
import type { EvalTask } from "../src/observability/eval.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const providerName = process.env.AGENTOS_LIVE_PROVIDER ?? "local-qwen15b";

/** 最短的可判分工具任务：一次 calc + 终答；maxSteps 收紧，避免弱模型绕圈。 */
const task: EvalTask = {
  id: "weak-single-step",
  category: "tool-use",
  input: "请调用 calc 工具计算 sum([12,18,25,31,14])，并在得到结果后回答总和是多少。",
  expectedTools: ["calc"],
  expectedAnswer: ["100"],
  maxSteps: 8,
};

const report = await runEval({
  tasks: [task], mode: "live", providerName, k: 1, root: ROOT,
  thresholds: {
    ...DEFAULT_THRESHOLDS,
    minOverall: 0, minToolUse: 0, minSafety: 0, minRobustness: 0,
    maxToolErrorRate: 1, maxAvgSteps: 999,
  },
  // 本机纯 CPU 单步可达 ~200s，默认 600s 墙钟会在第 3 步取消；仅本探针放宽。
  configOverride: { budget: { maxSeconds: 1800 } } as never,
  onProgress: (line) => process.stdout.write(line + "\n"),
});

const run = report.runs[0];
const valid = run?.stoppedBy === "completed" && run.protocolViolations === 0;
const verdict = valid ? (run.ok ? "passed" : "failed") : "insufficient-runtime";

const out = resolve(ROOT, "data/bench/v2-localqwen15b-admission.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  version: 1, timestamp: new Date().toISOString(), providerName, mode: "live",
  measurementValid: valid, verdict,
  stoppedBy: run?.stoppedBy ?? "no-run", steps: run?.steps ?? 0,
  toolCalls: run?.toolCalls ?? 0, protocolViolations: run?.protocolViolations ?? 0,
  latencyMs: run?.latencyMs ?? 0, ok: run?.ok ?? false, reasons: run?.reasons ?? [],
  answer: run?.answer ?? "", taskSetHash: report.taskSetHash,
  // v2.13.0 后首次实测（600s 墙钟取消）：证明链路修通、模型能发起原生工具调用，
  // 但 cancelled ≠ completed，不构成能力测量，只作链路结构证据。
  linkProbe: { steps: 3, toolCalls: 2, tools: ["calc", "calc"], stoppedBy: "cancelled", protocolViolations: 0 },
  note: [
    "链路证据：v2.13.0 修复前本地端点 0 工具调用；修复后同一 1.5B 发起 2 次原生 calc 调用，撤销「0.5B 能力下限」结论。",
    "能力结论只在 completed 轨迹下成立；cancelled / guard / provider_error 一律记 insufficient-runtime，不进证据集。",
    "三次实测稳定复现 3 步 / 2 次工具调用 / 协议 0 违规；第三次守卫原文为「检测到连续 3 次相同工具调用，判定为死循环」，属运行时与模型行为约束，不是能力结论。",
    "leadership.verdict 仍为 not-proven，L4 仍为 not-achieved；本次是链路/准入证据，不是能力分数。",
  ],
}, null, 2) + "\n");

process.stdout.write(`\n════ weak:probe · ${providerName} ════\n`);
process.stdout.write(`停止原因: ${run?.stoppedBy} · 步数 ${run?.steps} · 工具调用 ${run?.toolCalls} · 协议违规 ${run?.protocolViolations} · 耗时 ${run?.latencyMs}ms\n`);
process.stdout.write(`终止原因(守卫原文): ${run?.answer ?? ""}\n`);
process.stdout.write(`有效测量: ${valid ? "是" : "否"} · 判定: ${verdict}\n`);
process.stdout.write(`报告: data/bench/v2-localqwen15b-admission.json\n`);
if (!valid) process.stdout.write("诚实边界：本次运行时约束下无法完成测量，不写「模型太弱」，能力仍为未测出。\n");
