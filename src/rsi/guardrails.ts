/**
 * bro2 · 写保护评测面 / tripwire / de-hardcoding
 *
 * 直接对应 RSI.md §4 的已观测失败：
 *  - DGM 的 objective hacking（删掉评估器依赖的 logging 拿满分）
 *  - STOP 生成代码关掉 sandbox flag（0.42%）
 * 因此：任务集、评分逻辑、门禁阈值、治理源码在写保护面内，运行期每代重算哈希；
 * 候选 patch 只能落在能力面白名单，且技能增量不得夹带留出集答案或评分逻辑。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask } from "../observability/eval.ts";
import type { Patch, PatchChange, EvolvableState } from "./types.ts";
import {
  ALLOWED_EXACT_PATHS, ALLOWED_PREFIXES, FORBIDDEN_PREFIXES,
  NUMERIC_RANGES, DEHARDCODE_BANNED, DEHARDCODE_REQUIRED,
  POLICY_KEYS, POLICY_VALUES, getByPath,
} from "./types.ts";

/** 静态保护面：源码 + 任务集。运行期产物（账本/报告）不在其中，避免自指悖论。 */
export const PROTECTED_FILES: readonly string[] = [
  "src/observability/eval.ts",
  "src/kernel/loop.ts",
  "src/kernel/events.ts",
  "src/governance/guards.ts",
  "src/governance/permissions.ts",
  "src/runtime/policy.ts",
  "src/tools/repair.ts",
  "src/tools/runtime.ts",
  "src/rsi/types.ts",
  "src/rsi/guardrails.ts",
  "src/rsi/miner.ts",
  "src/rsi/operators.ts",
  "src/rsi/loop.ts",
  "src/rsi/meta.ts",
  "src/benchmark/ladder.ts",
  "src/benchmark/external.ts",
  "src/benchmark/scoring.ts",
  "data/eval-tasks.jsonl",
  "data/evolve/train.jsonl",
  "data/evolve/holdout.jsonl",
];

export function computeIntegrity(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of PROTECTED_FILES) {
    const p = join(root, rel);
    out[rel] = existsSync(p)
      ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)
      : "MISSING";
  }
  return out;
}

export function diffIntegrity(
  baseline: Record<string, string>,
  current: Record<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [file, h] of Object.entries(baseline)) {
    if (current[file] !== h) changed.push(file);
  }
  for (const file of Object.keys(current)) {
    if (!(file in baseline)) changed.push(file);
  }
  return changed;
}

/** 从 holdout 任务抽取答案串，仅用于 de-hardcoding 拦截，绝不进入 miner / operators。 */
export function extractHoldoutAnswers(tasks: readonly EvalTask[]): string[] {
  const out = new Set<string>();
  for (const t of tasks) {
    for (const a of t.expectedAnswer ?? []) {
      if (a.length >= 4) out.add(a.toLowerCase());
    }
  }
  return [...out];
}

export interface CheckContext {
  state: EvolvableState;
  holdoutAnswers: string[];
  rejectedEdits: string[];
  drift: number;
  maxDrift: number;
}

export interface CheckResult {
  ok: boolean;
  reason: string;
  severity: "critical" | "warning";
}

function pathAllowed(path: string): boolean {
  if (FORBIDDEN_PREFIXES.some((p) => path === p || path.startsWith(p))) return false;
  if (ALLOWED_EXACT_PATHS.includes(path)) return true;
  return ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}

function numericRange(path: string): [number, number] | undefined {
  if (NUMERIC_RANGES[path]) return NUMERIC_RANGES[path];
  for (const [k, v] of Object.entries(NUMERIC_RANGES)) {
    if (k.endsWith(".") && path.startsWith(k)) return v;
  }
  return undefined;
}

function checkDehardcode(text: string, answers: string[]): string | null {
  if (typeof text !== "string") return "技能增量必须是字符串";
  if (text.length === 0) return "技能增量为空";
  if (text.length > 240) return `技能增量过长（${text.length} > 240），疑似夹带答案`;
  const lower = text.toLowerCase();
  for (const a of answers) {
    if (a.length >= 4 && lower.includes(a)) return `技能增量包含 holdout 答案片段「${a}」`;
  }
  if (/\b[eht]\d+\b/i.test(text)) return "技能增量包含任务 id（禁止记忆具体用例）";
  const hit = DEHARDCODE_BANNED.find((w) => lower.includes(w));
  if (hit) return `技能增量包含评分/权限相关禁用词「${hit}」`;
  if (!DEHARDCODE_REQUIRED.test(text)) return "技能增量不是可迁移的操作级指导（缺少先/再/若/不要等）";
  return null;
}

function checkChange(c: PatchChange, ctx: CheckContext): CheckResult {
  const path = c.path;
  if (!pathAllowed(path)) {
    return { ok: false, severity: "critical", reason: `路径 ${path} 不在能力面白名单（触碰治理/验证器）` };
  }
  if (path.startsWith("skillOverlays.")) {
    const bad = checkDehardcode(String(c.to), ctx.holdoutAnswers);
    if (bad) return { ok: false, severity: "critical", reason: bad };
    return { ok: true, severity: "warning", reason: "技能增量合规（操作级、无硬编码）" };
  }
  // 策略面：只允许切到声明过的枚举值，防止注入任意字符串绕过内核解析
  if (path.startsWith("policy.")) {
    const key = path.slice("policy.".length) as (typeof POLICY_KEYS)[number];
    if (!(POLICY_KEYS as readonly string[]).includes(key)) {
      return { ok: false, severity: "critical", reason: `未知策略维度 ${key}` };
    }
    const allowed = POLICY_VALUES[key];
    if (!allowed.includes(String(c.to))) {
      return { ok: false, severity: "critical", reason: `策略 ${key} 值 ${String(c.to)} 不在白名单 [${allowed.join(", ")}]` };
    }
    if (String(c.to) === String(c.from)) {
      return { ok: false, severity: "warning", reason: `策略 ${key} 未产生实际变化` };
    }
    return { ok: true, severity: "warning", reason: `策略 ${key} → ${String(c.to)}（代码分支切换）` };
  }
  const range = numericRange(path);
  if (range) {
    const n = Number(c.to);
    if (!Number.isFinite(n)) return { ok: false, severity: "critical", reason: `${path} 不是有限数值` };
    if (n < range[0] || n > range[1]) {
      return { ok: false, severity: "critical", reason: `${path}=${n} 越界 [${range[0]}, ${range[1]}]` };
    }
    if (n === Number(c.from)) return { ok: false, severity: "warning", reason: `${path} 未产生实际变化` };
  }
  return { ok: true, severity: "warning", reason: "合规" };
}

export function checkPatch(patch: Patch, ctx: CheckContext): CheckResult {
  if (ctx.rejectedEdits.includes(patch.id)) {
    return { ok: false, severity: "warning", reason: `候选 ${patch.id} 已在拒绝缓冲中（防振荡）` };
  }
  if (ctx.drift + patch.changes.length > ctx.maxDrift) {
    return { ok: false, severity: "critical", reason: `累计改动 ${ctx.drift} 超过漂移上限 ${ctx.maxDrift}，需人工复核` };
  }
  if (patch.changes.length === 0 || patch.changes.length > 1) {
    return { ok: false, severity: "critical", reason: `单次编辑必须恰好 1 处（textual learning rate），实际 ${patch.changes.length}` };
  }
  for (const c of patch.changes) {
    // diff 的 from 必须与当前状态一致，防止候选基于陈旧状态或伪造 diff
    const actual = getByPath(ctx.state, c.path);
    if (actual !== undefined && JSON.stringify(actual) !== JSON.stringify(c.from)) {
      return {
        ok: false,
        severity: "critical",
        reason: `候选 diff 的 from 与当前状态不一致（${c.path}）`,
      };
    }
    const r = checkChange(c, ctx);
    if (!r.ok) return r;
  }
  return { ok: true, severity: "warning", reason: "合规" };
}
