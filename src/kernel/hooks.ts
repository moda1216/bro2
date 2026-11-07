/**
 * L0 内核 · 生命周期拦截点
 *
 * 7 个 Hook 点覆盖 step 前、step 后、工具执行前后、错误与 run 首尾。
 * Hook 可 approve / rewrite / log / block —— 插件无需修改内核即可改变行为。
 */
import type { EventType } from "./events.ts";

export const HookPoint = {
  PreRun: "pre_run",
  PreStep: "pre_step",
  PostStep: "post_step",
  PreTool: "pre_tool",
  PostTool: "post_tool",
  OnError: "on_error",
  PostRun: "post_run",
} as const;
export type HookPoint = (typeof HookPoint)[keyof typeof HookPoint];

export const HOOK_POINTS: readonly HookPoint[] = [
  HookPoint.PreRun,
  HookPoint.PreStep,
  HookPoint.PostStep,
  HookPoint.PreTool,
  HookPoint.PostTool,
  HookPoint.OnError,
  HookPoint.PostRun,
];

export interface HookContext {
  point: HookPoint;
  sessionId: string;
  turn: number;
  step: number;
  data: Record<string, unknown>;
  signal?: AbortSignal;
}

export const HookAction = {
  Continue: "continue",
  Block: "block",
  Modify: "modify",
} as const;
export type HookAction = (typeof HookAction)[keyof typeof HookAction];

export interface HookResult {
  action: HookAction;
  data?: Record<string, unknown>;
  reason?: string;
}

export type HookFn = (ctx: HookContext) => HookResult | Promise<HookResult>;

export interface HookFireResult {
  blocked: boolean;
  data: Record<string, unknown>;
  fired: Array<{ id: string; action: HookAction; reason?: string }>;
  type?: EventType;
}

interface RegisteredHook {
  id: string;
  fn: HookFn;
}

/** 串行执行，modify 累积生效，任一 block 立即中断后续 Hook。 */
export class HookManager {
  private readonly hooks = new Map<HookPoint, RegisteredHook[]>();

  register(point: HookPoint, fn: HookFn, id?: string): () => void {
    const item: RegisteredHook = { id: id ?? `hook_${this.hooks.size}_${Math.random().toString(36).slice(2, 8)}`, fn };
    const list = this.hooks.get(point) ?? [];
    list.push(item);
    this.hooks.set(point, list);
    return () => {
      const cur = this.hooks.get(point);
      if (!cur) return;
      const i = cur.findIndex((h) => h.id === item.id);
      if (i >= 0) cur.splice(i, 1);
      if (cur.length === 0) this.hooks.delete(point);
    };
  }

  async fire(ctx: HookContext): Promise<HookFireResult> {
    let data = { ...ctx.data };
    const fired: HookFireResult["fired"] = [];
    for (const h of this.hooks.get(ctx.point) ?? []) {
      try {
        const r = await h.fn({ ...ctx, data });
        fired.push({ id: h.id, action: r.action, ...(r.reason ? { reason: r.reason } : {}) });
        if (r.data) data = { ...data, ...r.data };
        if (r.action === HookAction.Block) {
          return { blocked: true, data, fired };
        }
      } catch (err) {
        // Hook 自身异常按 OnError 语义降级为继续，不让插件拖垮主循环
        fired.push({ id: h.id, action: HookAction.Continue, reason: `hook error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return { blocked: false, data, fired };
  }

  count(point?: HookPoint): number {
    if (point) return this.hooks.get(point)?.length ?? 0;
    let n = 0;
    for (const l of this.hooks.values()) n += l.length;
    return n;
  }

  clear(): void {
    this.hooks.clear();
  }
}
