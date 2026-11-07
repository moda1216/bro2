/**
 * L2 工具层 · 注册表（可逆注册 + 显式 JSON Schema）
 */
import type { JSONSchema } from "./schema.ts";
import type { Runtime } from "../kernel/runtime.ts";
import type { Session } from "../kernel/session.ts";
import type { ToolCall } from "../kernel/events.ts";

export const RiskLevel = {
  Safe: "safe",
  Write: "write",
  Danger: "danger",
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export interface ToolOutput {
  content: string;
  meta?: Record<string, unknown>;
}

export interface ToolContext {
  runtime: Runtime;
  session: Session;
  callId: string;
  signal?: AbortSignal;
  turn: number;
  step: number;
  /** 子 Agent 内部为 true，用于限制递归派生。 */
  nested?: boolean;
}

export type ToolHandler<TArgs extends Record<string, unknown> = Record<string, unknown>> = (
  args: TArgs,
  ctx: ToolContext,
) => string | ToolOutput | Promise<string | ToolOutput>;

export interface ToolDef<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  handler: ToolHandler<TArgs>;
  risk: RiskLevel;
  /** 声明哪些参数是文件路径，供权限层做沙箱校验。 */
  pathArgs?: string[];
  timeoutMs?: number;
  hidden?: boolean;
  /** 所属插件/连接器，用于可逆卸载。 */
  source?: string;
}

/** 泛型辅助：让 handler 的参数类型与 schema 在同一处声明，由测试防止漂移。 */
export function defineTool<TArgs extends Record<string, unknown>>(def: ToolDef<TArgs>): ToolDef<TArgs> {
  return def;
}

export interface ToolInfo {
  name: string;
  description: string;
  risk: RiskLevel;
  source?: string;
  pathArgs: string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  /** 返回 disposer，插件卸载时撤销注册（可逆副作用）。 */
  register<TArgs extends Record<string, unknown>>(def: ToolDef<TArgs>): () => void {
    if (this.tools.has(def.name)) throw new Error(`工具重复注册: ${def.name}`);
    this.tools.set(def.name, def as ToolDef);
    return () => this.tools.delete(def.name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolInfo[] {
    return [...this.tools.values()]
      .filter((t) => !t.hidden)
      .map((t) => ({
        name: t.name,
        description: t.description,
        risk: t.risk,
        ...(t.source ? { source: t.source } : {}),
        pathArgs: t.pathArgs ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  schemas(allowed?: readonly string[]): Array<{ name: string; description: string; parameters: JSONSchema }> {
    return [...this.tools.values()]
      .filter((t) => (allowed ? allowed.includes(t.name) || allowed.includes("*") : true))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  get size(): number {
    return this.tools.size;
  }
}

export type { ToolCall };
