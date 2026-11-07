/**
 * L2 工具层 · 运行时 JSON Schema 与参数校验
 *
 * TypeScript 类型擦除，工具 schema 必须显式声明；defineTool<T>() + satisfies
 * 把 handler 签名与 schema 对齐，validateArgs 保证所有边界输入都过校验。
 */
export interface JSONSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JSONSchemaProperty;
  minimum?: number;
  maximum?: number;
  minLength?: number;
}

export interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };

/** 温和 coerce：模型常把数字写成字符串，这里做受控转换而非直接拒绝。 */
function coerce(prop: JSONSchemaProperty, raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  switch (prop.type) {
    case "string":
      return typeof raw === "string" ? raw : String(raw);
    case "number":
    case "integer": {
      if (typeof raw === "number") return prop.type === "integer" ? Math.trunc(raw) : raw;
      if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
        const n = Number(raw);
        return prop.type === "integer" ? Math.trunc(n) : n;
      }
      return raw;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "1" || raw === 1) return true;
      if (raw === "false" || raw === "0" || raw === 0) return false;
      return raw;
    default:
      return raw;
  }
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** 严格校验：类型、必填、枚举、范围、长度、额外字段；填充默认值。 */
export function validateArgs(schema: JSONSchema, raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["参数必须是对象"] };
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const props = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    if (input[key] === undefined || input[key] === null) errors.push(`缺少必填参数: ${key}`);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in props)) errors.push(`不允许的额外参数: ${key}`);
    }
  }

  for (const [key, prop] of Object.entries(props)) {
    let v = input[key];
    if (v === undefined) {
      if (prop.default !== undefined) v = prop.default;
      else continue;
    }
    v = coerce(prop, v);
    const t = typeOf(v);
    if (prop.type === "integer") {
      // JS 没有独立整数类型，coerce 后是 number；需额外确认是整数值
      if (typeof v !== "number" || !Number.isInteger(v)) {
        errors.push(`参数 ${key} 类型应为 integer，实际 ${t}`);
        continue;
      }
    } else if (t !== prop.type) {
      errors.push(`参数 ${key} 类型应为 ${prop.type}，实际 ${t}`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(String(v))) {
      errors.push(`参数 ${key} 必须是以下之一: ${prop.enum.join(", ")}`);
    }
    if (prop.minimum !== undefined && typeof v === "number" && v < prop.minimum) {
      errors.push(`参数 ${key} 不能小于 ${prop.minimum}`);
    }
    if (prop.maximum !== undefined && typeof v === "number" && v > prop.maximum) {
      errors.push(`参数 ${key} 不能大于 ${prop.maximum}`);
    }
    if (prop.minLength !== undefined && typeof v === "string" && v.length < prop.minLength) {
      errors.push(`参数 ${key} 长度不能小于 ${prop.minLength}`);
    }
    if (prop.type === "array" && Array.isArray(v) && prop.items) {
      for (let i = 0; i < v.length; i += 1) {
        if (typeOf(v[i]) !== prop.items.type) errors.push(`参数 ${key}[${i}] 类型应为 ${prop.items.type}`);
      }
    }
    out[key] = v;
  }

  if (errors.length > 0) return { ok: false, errors };
  for (const [k, v] of Object.entries(input)) {
    if (!(k in out) && schema.additionalProperties !== false) out[k] = v;
  }
  return { ok: true, value: out };
}

/** 转成 OpenAI / Anthropic 兼容的 function calling schema。 */
export function toFunctionSchema(schema: ToolSchema): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    },
  };
}
