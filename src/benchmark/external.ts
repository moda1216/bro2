/**
 * bro2 · 外部基准结果导入验证器（写保护尺子的一部分）
 *
 * 为什么单独成文件并纳入 PROTECTED_FILES：
 * 「行业领先」是外部比较命题，唯一能把它往上推的输入就是这份外部结果文件。
 * 如果导入通道不校验，任何人写一行 {"results":[{}]} 就能把 L4 从
 * not-achieved 提到 partial —— 这正是本项目全程防范的 self-confirming loop。
 * 校验器因此必须与评分面同等保护：RSI / meta 候选不得修改它。
 *
 * 三条硬约束：
 *  1) 只认 data/benchmark/external-results.json；bro2 自己生成的报告不算外部证据；
 *  2) 每条记录过严格白名单 schema：缺字段 / 类型错 / 越界 / 夹带结论字段一律拒绝；
 *  3) 校验器只判定「这份证据的格式是否可信」，绝不据此宣布领先 —— verdict 恒由 ladder 给出。
 */
import { existsSync, readFileSync } from "node:fs";

/** 必填字段（EXTERNAL_RESULT_SCHEMA.required 与之同源，避免定义与实现漂移）。 */
export const EXTERNAL_REQUIRED = [
  "benchmark",
  "model",
  "date",
  "score",
  "metric",
  "reproducibleCommand",
] as const;

/** 可选字段（EXTERNAL_RESULT_SCHEMA.optional 与之同源）。 */
export const EXTERNAL_OPTIONAL = [
  "harness",
  "tasks",
  "repeat",
  "confidenceInterval",
  "notes",
] as const;

/**
 * 结论类字段禁止出现在外部结果里。
 * 数据源只能提供「测了什么、得了多少分」，不能自带「是否领先」的结论 ——
 * 否则等于绕过证据阶梯自封结论。
 */
export const EXTERNAL_FORBIDDEN_FIELDS = [
  "verdict",
  "proven",
  "leading",
  "leadership",
  "selfAssessed",
  "self_assessed",
  "winner",
  "rank",
  "claim",
] as const;

const PLACEHOLDER = /^(n\/?a|none|todo|tbd|见文档|待补充|无|-|null|undefined)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ExternalResult {
  benchmark: string;
  model: string;
  date: string;
  score: number;
  metric: string;
  reproducibleCommand: string;
  harness?: string;
  tasks?: number;
  repeat?: number;
  confidenceInterval?: [number, number];
  notes?: string;
}

export interface ExternalRejection {
  index: number;
  reason: string;
}

export interface ExternalValidation {
  /** 文件级错误（解析失败 / 顶层格式错）。文件不存在不算错误，属于「未导入」。 */
  fileErrors: string[];
  /** 提交的记录总数 */
  submitted: number;
  /** 通过全部校验的合法记录 */
  accepted: ExternalResult[];
  /** 被拒记录，含索引与具体原因，便于逐条复核 */
  rejected: ExternalRejection[];
  /** 无文件级错误且无被拒记录 */
  ok: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function positiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function ciNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** 本地「今天」，避免 UTC 日期在凌晨时区把当天误判为未来。 */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** YYYY-MM-DD 且必须是真实存在的日历日期（JS 会自动把 02-30 滚到 3 月，需显式挡住）。 */
function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * 校验单条外部结果。返回判别联合，调用方无法「忽略失败继续用」。
 */
export function validateExternalResult(raw: unknown):
  | { ok: true; value: ExternalResult }
  | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: "记录不是对象" };

  // 1) 结论类字段不得由数据源自带（给出精确归因，而非笼统的「未知字段」）
  for (const f of EXTERNAL_FORBIDDEN_FIELDS) {
    if (f in raw) return { ok: false, reason: `外部结果不得自带结论字段 ${f}（结论只能由证据阶梯给出）` };
  }

  // 2) 严格字段白名单：未知字段一律拒绝，防止夹带
  const allowed = new Set<string>([...EXTERNAL_REQUIRED, ...EXTERNAL_OPTIONAL]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return { ok: false, reason: `未知字段 ${k} 不在 schema 白名单内` };
  }

  // 3) 必填字段
  for (const k of EXTERNAL_REQUIRED) {
    if (!(k in raw)) return { ok: false, reason: `缺少必填字段 ${k}` };
  }
  if (!nonEmptyString(raw.benchmark)) return { ok: false, reason: "benchmark 必须是非空字符串" };
  if (!nonEmptyString(raw.model)) return { ok: false, reason: "model 必须是非空字符串" };
  if (!nonEmptyString(raw.metric)) return { ok: false, reason: "metric 必须是非空字符串" };
  if (typeof raw.date !== "string" || !isRealDate(raw.date)) {
    return { ok: false, reason: "date 必须是真实存在的 YYYY-MM-DD 日期" };
  }
  if (raw.date > todayLocal()) {
    return { ok: false, reason: "date 不得晚于今天（不接受尚未发生的结果）" };
  }
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 1) {
    return { ok: false, reason: "score 必须是 [0,1] 内的有限数值" };
  }
  if (!nonEmptyString(raw.reproducibleCommand) || PLACEHOLDER.test(raw.reproducibleCommand.trim())) {
    return { ok: false, reason: "reproducibleCommand 必须是可执行的复现命令，不能是占位符" };
  }

  // 4) 可选字段：提供即校验类型
  if ("harness" in raw && !nonEmptyString(raw.harness)) return { ok: false, reason: "harness 必须是非空字符串" };
  if ("tasks" in raw && !positiveInt(raw.tasks)) return { ok: false, reason: "tasks 必须是正整数" };
  if ("repeat" in raw && !positiveInt(raw.repeat)) return { ok: false, reason: "repeat 必须是正整数" };
  if ("notes" in raw && typeof raw.notes !== "string") return { ok: false, reason: "notes 必须是字符串" };
  let ci: [number, number] | undefined;
  if ("confidenceInterval" in raw) {
    const c = raw.confidenceInterval;
    if (!Array.isArray(c) || c.length !== 2 || !ciNumber(c[0]) || !ciNumber(c[1])) {
      return { ok: false, reason: "confidenceInterval 必须是 [lo,hi] 且两端为 [0,1] 内数值" };
    }
    const lo = c[0] as number;
    const hi = c[1] as number;
    if (lo > hi) return { ok: false, reason: "confidenceInterval 下界不得大于上界" };
    ci = [lo, hi];
  }

  const value: ExternalResult = {
    benchmark: raw.benchmark.trim(),
    model: raw.model.trim(),
    date: raw.date,
    score: raw.score,
    metric: raw.metric.trim(),
    reproducibleCommand: raw.reproducibleCommand.trim(),
  };
  if (nonEmptyString(raw.harness)) value.harness = raw.harness.trim();
  if (positiveInt(raw.tasks)) value.tasks = raw.tasks;
  if (positiveInt(raw.repeat)) value.repeat = raw.repeat;
  if (ci) value.confidenceInterval = ci;
  if (typeof raw.notes === "string") value.notes = raw.notes;
  return { ok: true, value };
}

/**
 * 从专门的外部导入文件读取并校验。
 * 文件不存在 = 未导入（正常状态，不是错误）；存在但格式错 = 记录 fileErrors。
 * 被拒记录不会连坐其它合法记录，但会完整留在 rejected 里供复核。
 */
export function loadExternalResults(path: string): ExternalValidation {
  const empty: ExternalValidation = {
    fileErrors: [], submitted: 0, accepted: [], rejected: [], ok: true,
  };
  if (!existsSync(path)) return empty;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ...empty, fileErrors: [`读取失败: ${String(e)}`], ok: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ...empty, fileErrors: ["JSON 解析失败"], ok: false };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) {
    return {
      ...empty,
      fileErrors: ["顶层必须是 { results: [...] } 且 results 为数组"],
      ok: false,
    };
  }

  const accepted: ExternalResult[] = [];
  const rejected: ExternalRejection[] = [];
  parsed.results.forEach((r, i) => {
    const v = validateExternalResult(r);
    if (v.ok) accepted.push(v.value);
    else rejected.push({ index: i, reason: v.reason });
  });
  return {
    fileErrors: [],
    submitted: parsed.results.length,
    accepted,
    rejected,
    ok: rejected.length === 0,
  };
}
