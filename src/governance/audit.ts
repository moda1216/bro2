/**
 * L6 治理层 · 密钥隔离与日志脱敏
 *
 * 凭据只从环境变量读取，日志中只出现引用名（env:OPENAI_API_KEY），不出现明文。
 */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(sk|ak|rk)-[A-Za-z0-9_\-]{12,}/g, label: "API_KEY" },
  { re: /Bearer\s+[A-Za-z0-9._\-]{8,}/gi, label: "BEARER" },
  { re: /("?(?:api[_-]?key|password|secret|token|access[_-]?token)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi, label: "SECRET_FIELD" },
];

export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    if (p.label === "SECRET_FIELD") {
      out = out.replace(p.re, (_m, prefix: string) => `${prefix}***REDACTED***`);
    } else {
      out = out.replace(p.re, `***${p.label}_REDACTED***`);
    }
  }
  return out;
}

export function redactObject(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(api[_-]?key|password|secret|token|credential)/i.test(k)) out[k] = "***REDACTED***";
      else out[k] = redactObject(v);
    }
    return out;
  }
  return value;
}

/** 从环境变量取凭据，日志只返回引用名。 */
export function readSecret(envName: string): { value: string; ref: string } {
  return { value: process.env[envName] ?? "", ref: `env:${envName}` };
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(redactObject(value));
  } catch {
    return "[不可序列化]";
  }
}
