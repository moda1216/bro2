/**
 * L2 工具层 · 插件（"一切皆插件"的可逆副作用演示）
 *
 * 每个插件只通过 runtime.onEvent / runtime.onHook / runtime.register 注册能力；
 * Runtime 会收集所有 disposer，卸载或加载失败时完整回滚，不残留监听器或 Hook。
 */
import { EventType } from "../kernel/events.ts";
import { HookPoint, HookAction } from "../kernel/hooks.ts";
import type { PluginDefinition } from "../kernel/runtime.ts";

export interface AuditRecord {
  ts: string;
  type: string;
  sessionId: string;
  summary: string;
}

export const BUILTIN_PLUGINS: Record<string, PluginDefinition> = {
  "tool-audit": {
    name: "tool-audit",
    setup(runtime) {
      const log: AuditRecord[] = [];
      runtime.register("plugin.tool-audit.log", log);
      runtime.onEvent(EventType.ToolCall, (e) => {
        const calls = e.payload.calls as Array<{ name: string }> | undefined;
        log.push({
          ts: e.ts,
          type: "tool.call",
          sessionId: e.sessionId,
          summary: (calls ?? []).map((c) => c.name).join(", "),
        });
        if (log.length > 500) log.shift();
      });
      runtime.onEvent(EventType.ToolResult, (e) => {
        const r = e.payload.result as { name?: string; ok?: boolean } | undefined;
        log.push({ ts: e.ts, type: "tool.result", sessionId: e.sessionId, summary: `${r?.name ?? "?"} ok=${r?.ok}` });
        if (log.length > 500) log.shift();
      });
    },
  },

  "danger-blocker": {
    name: "danger-blocker",
    setup(runtime) {
      runtime.register("plugin.danger-blocker.rules", ["drop table", "rm -rf /", "curl | sh"]);
      runtime.onHook(HookPoint.PreTool, (ctx) => {
        const args = (ctx.data.arguments ?? {}) as Record<string, unknown>;
        const text = JSON.stringify(args).toLowerCase();
        const blocked = ["drop table", "rm -rf /", "curl | sh"].some((p) => text.includes(p));
        if (blocked) {
          return { action: HookAction.Block, reason: "danger-blocker 插件拦截了高危参数" };
        }
        return { action: HookAction.Continue };
      });
    },
  },

  "context-banner": {
    name: "context-banner",
    setup(runtime) {
      runtime.register("plugin.context-banner.active", true);
      runtime.onHook(HookPoint.PreStep, () => ({
        action: HookAction.Modify,
        data: { inject: "（插件注入）所有工具结果必须基于真实执行，禁止推测。" },
      }));
    },
  },

  "step-logger": {
    name: "step-logger",
    setup(runtime) {
      const steps: number[] = [];
      runtime.register("plugin.step-logger.steps", steps);
      runtime.onHook(HookPoint.PostStep, (ctx) => {
        steps.push(ctx.step);
        return { action: HookAction.Continue };
      });
    },
  },
};

export function listPluginNames(): string[] {
  return Object.keys(BUILTIN_PLUGINS);
}
