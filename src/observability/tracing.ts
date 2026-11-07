/**
 * L7 可观测性 · 实时指标与轨迹视图数据
 *
 * 订阅 EventBus 做无侵入统计；轨迹本身仍以 Trajectory 只增日志为准。
 */
import type { EventBus, Event } from "../kernel/events.ts";
import { EventType } from "../kernel/events.ts";

export interface Metrics {
  events: number;
  turns: number;
  toolCalls: number;
  toolFailures: number;
  approvals: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  avgToolLatencyMs: number;
  perTool: Record<string, { calls: number; failures: number; totalMs: number }>;
  uptimeMs: number;
}

export interface TimelineItem {
  seq: number;
  ts: string;
  step: number;
  type: string;
  summary: string;
}

export class Tracer {
  private readonly startedAt = Date.now();
  private counters: Omit<Metrics, "avgToolLatencyMs" | "perTool" | "uptimeMs"> = {
    events: 0,
    turns: 0,
    toolCalls: 0,
    toolFailures: 0,
    approvals: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  private readonly perTool: Metrics["perTool"] = {};
  private readonly timeline: TimelineItem[] = [];
  private readonly dispose: () => void;

  constructor(bus: EventBus) {
    this.dispose = bus.on("*", (e) => this.onEvent(e));
  }

  private onEvent(e: Event): void {
    this.counters.events += 1;
    if (e.type === EventType.RunStart) this.counters.turns += 1;
    if (e.type === EventType.ToolCall) this.counters.toolCalls += 1;
    if (e.type === EventType.ApprovalRequest) this.counters.approvals += 1;
    if (e.type === EventType.Error) this.counters.errors += 1;
    if (e.type === EventType.ToolResult) {
      const r = e.payload.result as { name?: string; ok?: boolean; elapsedMs?: number } | undefined;
      const name = r?.name ?? "unknown";
      const rec = this.perTool[name] ?? { calls: 0, failures: 0, totalMs: 0 };
      rec.calls += 1;
      rec.totalMs += r?.elapsedMs ?? 0;
      if (r?.ok === false) {
        rec.failures += 1;
        this.counters.toolFailures += 1;
      }
      this.perTool[name] = rec;
    }
    if (e.usage) {
      this.counters.inputTokens += e.usage.inputTokens;
      this.counters.outputTokens += e.usage.outputTokens;
    }
    this.timeline.push({
      seq: e.seq,
      ts: e.ts,
      step: e.step,
      type: e.type,
      summary: summarize(e),
    });
    if (this.timeline.length > 2000) this.timeline.shift();
  }

  snapshot(): Metrics {
    const totalMs = Object.values(this.perTool).reduce((s, v) => s + v.totalMs, 0);
    const calls = Object.values(this.perTool).reduce((s, v) => s + v.calls, 0);
    return {
      ...this.counters,
      avgToolLatencyMs: calls === 0 ? 0 : Math.round(totalMs / calls),
      perTool: structuredClone(this.perTool),
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  recent(limit = 100): TimelineItem[] {
    return this.timeline.slice(-limit);
  }

  close(): void {
    this.dispose();
  }
}

function summarize(e: Event): string {
  const p = e.payload;
  switch (e.type) {
    case EventType.UserMessage:
    case EventType.AssistantMessage:
      return String(p.content ?? "").slice(0, 160);
    case EventType.ToolCall:
      return JSON.stringify(p.calls ?? p.call ?? "").slice(0, 160);
    case EventType.ToolResult: {
      const r = p.result as { name?: string; ok?: boolean; output?: string; error?: string } | undefined;
      return `${r?.name ?? "?"} ${r?.ok ? "ok" : "fail"}: ${String(r?.output ?? r?.error ?? "").slice(0, 140)}`;
    }
    case EventType.ApprovalRequest:
      return `审批: ${String((p.request as { toolName?: string } | undefined)?.toolName ?? "")}`;
    case EventType.Guard:
      return `Guard: ${String(p.reason ?? "")}`;
    case EventType.Error:
      return `错误: ${String(p.error ?? "")}`;
    default:
      return JSON.stringify(p).slice(0, 160);
  }
}
