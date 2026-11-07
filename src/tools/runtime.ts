/**
 * L2 工具层 · 执行运行时
 *
 * 负责：参数校验 → （可选）受控修复 → PRE_TOOL Hook → 超时/取消
 * → 输出截断 → POST_TOOL Hook → 结果归一。
 * 关键正确性：任何失败（未知工具 / 参数非法 / Hook 阻断 / 超时 / 异常）都必须
 * 写入一条 ToolResult 事件回喂模型，否则 assistant(tool_calls) 会缺少配对结果，
 * 真实 OpenAI 兼容端点会直接返回 400。
 *
 * 策略分支（BehaviorPolicy）：
 *  - malformedArgs=repair：拼错的工具名/参数名、JSON 字符串参数做受控规范化，
 *    每一步写入 tool.repair 事件；修复后仍必须重新过完整校验。
 *  - parallel=risk-first：同一步内高危工具优先调度，减少长尾阻塞。
 */
import { validateArgs } from "./schema.ts";
import { fuzzyToolName, repairArgs } from "./repair.ts";
import { truncate } from "../kernel/trajectory.ts";
import { EventType } from "../kernel/events.ts";
import { HookPoint } from "../kernel/hooks.ts";
import type { HookManager } from "../kernel/hooks.ts";
import type { EventBus } from "../kernel/events.ts";
import type { ToolContext, ToolRegistry } from "./registry.ts";
import type { ToolCall, ToolResult, EventDraft, Event } from "../kernel/events.ts";
import { RiskLevel } from "./registry.ts";
import type { MalformedArgsMode, ParallelMode } from "../runtime/policy.ts";

export interface ToolRuntimeOptions {
  registry: ToolRegistry;
  hooks: HookManager;
  bus: EventBus;
  defaultTimeoutMs: number;
  maxOutputChars: number;
  record: (draft: EventDraft) => Event;
  malformedArgs?: MalformedArgsMode;
  parallel?: ParallelMode;
}

const RISK_RANK: Record<string, number> = {
  [RiskLevel.Danger]: 3,
  [RiskLevel.Write]: 2,
  [RiskLevel.Safe]: 1,
};

export class ToolRuntime {
  private readonly registry: ToolRegistry;
  private readonly hooks: HookManager;
  private readonly bus: EventBus;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly record: (draft: EventDraft) => Event;
  private readonly repair: boolean;
  private readonly parallel: ParallelMode;

  constructor(options: ToolRuntimeOptions) {
    this.registry = options.registry;
    this.hooks = options.hooks;
    this.bus = options.bus;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.maxOutputChars = options.maxOutputChars;
    this.record = options.record;
    this.repair = options.malformedArgs === "repair";
    this.parallel = options.parallel ?? "fifo";
  }

  /** 并发上限 + 背压：同一步内的多个 tool_call 并行执行，但不超过阈值。 */
  async executeBatch(calls: readonly ToolCall[], ctx: Omit<ToolContext, "callId">, maxConcurrent: number): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length);
    // risk-first：高危工具先进入 worker，降低被长任务挡住的概率；结果仍按原索引回填。
    const order = calls.map((_c, i) => i);
    if (this.parallel === "risk-first" && calls.length > 1) {
      order.sort((a, b) => {
        const ra = RISK_RANK[this.registry.get(calls[a]!.name)?.risk ?? RiskLevel.Safe] ?? 1;
        const rb = RISK_RANK[this.registry.get(calls[b]!.name)?.risk ?? RiskLevel.Safe] ?? 1;
        return rb - ra;
      });
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxConcurrent, calls.length) }, async () => {
      while (true) {
        const slot = cursor;
        cursor += 1;
        if (slot >= order.length) break;
        const i = order[slot]!;
        results[i] = await this.execute(calls[i]!, { ...ctx, callId: calls[i]!.id });
      }
    });
    await Promise.all(workers);
    return results;
  }

  async execute(original: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    let call = original;
    let def = this.registry.get(call.name);
    const repairs: string[] = [];

    // ---- 策略分支 1：受控修复拼错的工具名 ----
    if (!def && this.repair) {
      const guess = fuzzyToolName(call.name, this.registry.names());
      if (guess) {
        repairs.push(`工具名 ${call.name} → ${guess}`);
        call = { ...call, name: guess };
        def = this.registry.get(guess);
      }
    }
    if (!def) {
      return this.fail(call, ctx, `未知工具: ${call.name}。可用工具: ${this.registry.names().join(", ")}`, started);
    }

    let validated = validateArgs(def.parameters, call.arguments);
    // ---- 策略分支 2：受控规范化畸形参数，且必须重新过完整校验 ----
    if (!validated.ok && this.repair) {
      const r = repairArgs(def.parameters, call.arguments);
      if (r.changes.length > 0) {
        const re = validateArgs(def.parameters, r.value);
        if (re.ok) {
          validated = re;
          call = { ...call, arguments: r.value };
          repairs.push(...r.changes);
        }
      }
    }
    if (!validated.ok) {
      return this.fail(call, ctx, `参数校验失败: ${validated.errors.join("; ")}`, started);
    }
    if (repairs.length > 0) await this.emitRepairEvent(call, ctx, repairs);

    const pre = await this.hooks.fire({
      point: HookPoint.PreTool,
      sessionId: ctx.session.id,
      turn: ctx.turn,
      step: ctx.step,
      data: { tool: call.name, arguments: validated.value, callId: call.id },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (pre.blocked) {
      const reason = pre.fired.map((f) => f.reason ?? "").filter(Boolean).join("; ") || "无理由";
      return this.fail(call, ctx, `工具调用被 Hook 阻断: ${reason}`, started);
    }
    const args = (pre.data.arguments as Record<string, unknown> | undefined) ?? validated.value;

    const timeoutMs = def.timeoutMs ?? this.defaultTimeoutMs;
    let content: string;
    let meta: Record<string, unknown> | undefined;
    try {
      const raw = await withTimeout(
        Promise.resolve(def.handler(args, { ...ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) })),
        timeoutMs,
        ctx.signal,
        `工具 ${call.name} 执行超时 (${timeoutMs}ms)`,
      );
      if (typeof raw === "string") content = raw;
      else {
        content = raw.content;
        meta = raw.meta;
      }
    } catch (err) {
      return this.fail(call, ctx, err instanceof Error ? err.message : String(err), started);
    }

    const clipped = truncate(content || "(空输出)", this.maxOutputChars);
    const result: ToolResult = {
      callId: call.id,
      name: call.name,
      ok: true,
      output: clipped.text,
      elapsedMs: Date.now() - started,
      ...(clipped.truncated ? { truncated: true } : {}),
    };
    await this.emitToolEvent(call, ctx, true, clipped.text, undefined, result.elapsedMs, meta);
    await this.hooks.fire({
      point: HookPoint.PostTool,
      sessionId: ctx.session.id,
      turn: ctx.turn,
      step: ctx.step,
      data: { tool: call.name, ok: true, chars: clipped.text.length, ...(meta ?? {}) },
    });
    return result;
  }

  /** 修复是可审计事实：写入只增日志，评测据此断言策略确实生效。 */
  private async emitRepairEvent(call: ToolCall, ctx: ToolContext, changes: string[]): Promise<void> {
    const draft: EventDraft = {
      sessionId: ctx.session.id,
      turn: ctx.turn,
      step: ctx.step,
      type: EventType.ToolRepair,
      payload: { callId: call.id, tool: call.name, changes },
    };
    await this.bus.emit(this.record(draft));
  }

  /** 统一的失败出口：写事件 + 触发 POST_TOOL + 返回结构化结果。 */
  private async fail(call: ToolCall, ctx: ToolContext, error: string, started: number): Promise<ToolResult> {
    const elapsedMs = Date.now() - started;
    await this.emitToolEvent(call, ctx, false, undefined, error, elapsedMs);
    await this.hooks.fire({
      point: HookPoint.PostTool,
      sessionId: ctx.session.id,
      turn: ctx.turn,
      step: ctx.step,
      data: { tool: call.name, ok: false, error },
    });
    return { callId: call.id, name: call.name, ok: false, error, elapsedMs };
  }

  private async emitToolEvent(
    call: ToolCall,
    ctx: ToolContext,
    ok: boolean,
    output: string | undefined,
    error: string | undefined,
    elapsedMs: number,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const draft: EventDraft = {
      sessionId: ctx.session.id,
      turn: ctx.turn,
      step: ctx.step,
      type: EventType.ToolResult,
      payload: {
        result: {
          callId: call.id,
          name: call.name,
          ok,
          elapsedMs,
          ...(output !== undefined ? { output } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(meta ?? {}),
        },
        risk: this.registry.get(call.name)?.risk ?? RiskLevel.Safe,
      },
    };
    const event = this.record(draft);
    await this.bus.emit(event);
  }
}

/** 超时 + 外部取消，取先到者；不响应 signal 的 handler 也会被强制短路。 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, external?: AbortSignal, message = "超时"): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), ms);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error(message)), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onAbort);
  }
}
