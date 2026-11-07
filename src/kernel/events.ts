/**
 * L0 内核 · 统一事件协议与事件总线
 *
 * 设计要点：整个系统只有一种"事实"——Event。模型的输入、工具的结果、
 * 审批、上下文压缩、子 agent 调度，全部是只增不改的事件流。
 */

export const Role = {
  System: "system",
  User: "user",
  Assistant: "assistant",
  Tool: "tool",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const EventType = {
  RunStart: "run.start",
  RunEnd: "run.end",
  UserMessage: "message.user",
  AssistantMessage: "message.assistant",
  Thinking: "thinking",
  ToolCall: "tool.call",
  ToolResult: "tool.result",
  /** 策略层受控修复了畸形工具名/参数（malformedArgs=repair） */
  ToolRepair: "tool.repair",
  /** 终答因缺少工具证据被打回（grounding=require-evidence） */
  GroundingReject: "grounding.reject",
  /** 死循环软警告而非硬终止（loopDetection=advisory） */
  LoopAdvisory: "guard.advisory",
  ContextInject: "context.inject",
  Compaction: "context.compaction",
  ApprovalRequest: "approval.request",
  ApprovalResolved: "approval.resolved",
  HookFired: "hook.fired",
  Guard: "guard",
  Error: "error",
  SubAgentStart: "subagent.start",
  SubAgentEnd: "subagent.end",
  Automation: "automation",
  Metrics: "metrics",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  output?: string;
  error?: string;
  elapsedMs: number;
  truncated?: boolean;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  reasoning?: string;
}

/** 只增不改的日志条目。所有派生状态（恢复/分叉/统计/回放）都由此重建。 */
export interface Event {
  seq: number;
  ts: string;
  sessionId: string;
  turn: number;
  step: number;
  type: EventType;
  payload: Record<string, unknown>;
  usage?: Usage;
}

export type EventDraft = Omit<Event, "seq" | "ts">;

let counter = 0;
export function newId(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export type EventListener = (event: Event) => void | Promise<void>;

/**
 * 事件总线：订阅者错误被隔离，绝不因某个 UI/插件异常打断主循环。
 * 所有注册返回 disposer，供插件卸载时回滚副作用。
 */
export class EventBus {
  private readonly listeners = new Map<EventType | "*", Set<EventListener>>();
  private readonly errors: Array<{ type: EventType; error: string }> = [];

  on(type: EventType | "*", fn: EventListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set<EventListener>();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(type);
    };
  }

  async emit(event: Event): Promise<void> {
    const targets: EventListener[] = [
      ...(this.listeners.get(event.type) ?? []),
      ...(this.listeners.get("*") ?? []),
    ];
    await Promise.all(
      targets.map(async (fn) => {
        try {
          await fn(event);
        } catch (err) {
          // 错误隔离：记录但不抛出
          this.errors.push({ type: event.type, error: err instanceof Error ? err.message : String(err) });
          if (this.errors.length > 200) this.errors.shift();
        }
      }),
    );
  }

  get subscriberErrors(): ReadonlyArray<{ type: EventType; error: string }> {
    return this.errors;
  }

  get listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

/** 把事件流还原为模型可见的消息序列（会话恢复的核心）。 */
export function eventsToMessages(events: readonly Event[]): Message[] {
  const out: Message[] = [];
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case EventType.UserMessage:
        out.push({ role: Role.User, content: String(p.content ?? "") });
        break;
      case EventType.AssistantMessage: {
        const calls = (p.toolCalls as ToolCall[] | undefined) ?? undefined;
        out.push({
          role: Role.Assistant,
          content: String(p.content ?? ""),
          ...(calls && calls.length > 0 ? { toolCalls: calls } : {}),
          ...(p.reasoning ? { reasoning: String(p.reasoning) } : {}),
        });
        break;
      }
      case EventType.ToolResult: {
        const r = p.result as ToolResult | undefined;
        if (r) {
          out.push({
            role: Role.Tool,
            content: r.ok ? (r.output ?? "") : `ERROR: ${r.error ?? "unknown"}`,
            toolCallId: r.callId,
            name: r.name,
          });
        }
        break;
      }
      case EventType.ContextInject:
        out.push({ role: Role.System, content: `[上下文注入] ${String(p.content ?? "")}` });
        break;
      default:
        break;
    }
  }
  return out;
}
