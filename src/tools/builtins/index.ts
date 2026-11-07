/**
 * 内置工具集统一注册入口（返回 disposer，支持可逆卸载）。
 */
import type { Runtime } from "../../kernel/runtime.ts";
import type { ToolRegistry, ToolDef } from "../registry.ts";
import { FILE_TOOLS } from "./files.ts";
import { SYSTEM_TOOLS } from "./system.ts";
import { COGNITION_TOOLS } from "./cognition.ts";
import { ORCHESTRATION_TOOLS } from "./orchestration.ts";

export const ALL_BUILTIN_TOOLS: readonly ToolDef[] = [
  ...FILE_TOOLS,
  ...SYSTEM_TOOLS,
  ...COGNITION_TOOLS,
  ...ORCHESTRATION_TOOLS,
];

export function registerBuiltinTools(_runtime: Runtime, registry: ToolRegistry): () => void {
  const disposers = ALL_BUILTIN_TOOLS.map((t) => registry.register(t));
  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch { /* ignore */ }
    }
  };
}

export { FILE_TOOLS, SYSTEM_TOOLS, COGNITION_TOOLS, ORCHESTRATION_TOOLS };
