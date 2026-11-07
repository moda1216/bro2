/**
 * bro2 · 受控参数/工具名修复（malformedArgs=repair 策略的真实代码分支）
 *
 * 有文献依据的 self-repair：模型常把工具名拼错、把对象写成 JSON 字符串、
 * 或写错参数名。这里只做**有限、可审计、不放松语义**的规范化：
 *  - 绝不为缺失的必填参数凭空造值（那会伪造执行结果）；
 *  - 每一步修复都记录进 changes，并写入 Trajectory 的 tool.repair 事件；
 *  - 修复后必须重新过完整的 validateArgs，失败则照常回报错误。
 * 因此 t15（空参数）/ t16（无关工具名）在 repair 模式下依然失败，安全语义不变。
 */
import type { JSONSchema } from "./schema.ts";

/** Levenshtein 编辑距离，用于保守的模糊匹配。 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_v, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * 唯一的近似工具名。要求：距离 ≤ 阈值、且严格优于次优候选（避免歧义误改）。
 * 找不到唯一匹配时返回 null，调用方照常回报「未知工具」。
 */
export function fuzzyToolName(name: string, candidates: readonly string[]): string | null {
  const scored = candidates
    .map((c) => ({ c, d: editDistance(name.toLowerCase(), c.toLowerCase()) }))
    .sort((x, y) => x.d - y.d);
  const best = scored[0];
  if (!best) return null;
  const threshold = Math.max(1, Math.floor(name.length * 0.34));
  if (best.d > threshold) return null;
  if (scored[1] && scored[1]!.d === best.d) return null; // 歧义：不猜
  return best.c;
}

export interface RepairResult {
  value: Record<string, unknown>;
  changes: string[];
}

/**
 * 受控规范化。返回 changes 为空表示「无可安全修复项」，调用方应直接失败。
 */
export function repairArgs(schema: JSONSchema, raw: unknown): RepairResult {
  const changes: string[] = [];
  let obj: Record<string, unknown> = {};

  // 1) 整个参数被写成 JSON 字符串
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
        changes.push("参数整体由 JSON 字符串解析为对象");
      }
    } catch { /* 解析失败则保持原样，交给 validateArgs 报错 */ }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = { ...(raw as Record<string, unknown>) };
  }

  const props = schema.properties ?? {};

  // 2) 参数名拼写修正：只对「不在 schema 中的键」做唯一近似匹配
  for (const key of Object.keys(obj)) {
    if (key in props) continue;
    const match = fuzzyToolName(key, Object.keys(props));
    if (match && !(match in obj)) {
      obj[match] = obj[key];
      delete obj[key];
      changes.push(`参数名 ${key} → ${match}`);
    }
  }

  // 3) 类型形态规范化：array/object 字段若收到 JSON 字符串则解析
  for (const [key, prop] of Object.entries(props)) {
    const v = obj[key];
    if (typeof v !== "string") continue;
    if ((prop.type === "array" || prop.type === "object") && /^[\[{]/.test(v.trim())) {
      try {
        obj[key] = JSON.parse(v) as unknown;
        changes.push(`参数 ${key} 由 JSON 字符串解析为 ${prop.type}`);
      } catch { /* 保持原样 */ }
    }
  }

  // 4) enum 大小写归一（仅限明确唯一命中）
  for (const [key, prop] of Object.entries(props)) {
    if (!prop.enum) continue;
    const v = obj[key];
    if (typeof v !== "string") continue;
    const hit = prop.enum.find((e) => e.toLowerCase() === v.toLowerCase());
    if (hit && hit !== v) {
      obj[key] = hit;
      changes.push(`参数 ${key} 枚举值归一 ${v} → ${hit}`);
    }
  }

  // 5) additionalProperties=false 时剔除确实无用的额外字段（仅当它无法被近似匹配）
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in props)) {
        delete obj[key];
        changes.push(`剔除额外参数 ${key}`);
      }
    }
  }

  return { value: obj, changes };
}
