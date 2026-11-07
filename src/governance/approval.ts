/**
 * L6 治理层 · 人工介入（HITL）审批队列
 *
 * 审批请求是异步 Promise：CLI 交互确认 / Web 弹窗 / headless 自动批准都走同一入口。
 * 支持「本会话始终允许」，避免重复打断。
 */
import { newId, EventType } from "../kernel/events.ts";
import type { EventBus } from "../kernel/events.ts";
import type { EventDraft } from "../kernel/events.ts";

export const ApprovalDecision = {
  Approve: "approve",
  Deny: "deny",
  Always: "always",
} as const;
export type ApprovalDecision = (typeof ApprovalDecision)[keyof typeof ApprovalDecision];

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  createdAt: string;
  status: "pending" | ApprovalDecision;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

export interface ApprovalManagerOptions {
  bus: EventBus;
  record: (draft: EventDraft) => import("../kernel/events.ts").Event;
  /** headless / CI 模式：自动批准，避免阻塞。 */
  autoApprove?: boolean;
  /** 审批超时（毫秒），超时按拒绝处理，防止主循环永久挂起。 */
  timeoutMs?: number;
}

export class ApprovalManager {
  private readonly bus: EventBus;
  private readonly record: (draft: EventDraft) => void;
  private readonly pending = new Map<string, Pending>();
  private readonly alwaysAllowed = new Set<string>();
  private readonly timeoutMs: number;
  private autoApprove: boolean;
  private onRequestListener?: (req: ApprovalRequest) => void;

  constructor(options: ApprovalManagerOptions) {
    this.bus = options.bus;
    this.record = options.record;
    this.autoApprove = options.autoApprove ?? false;
    this.timeoutMs = options.timeoutMs ?? 120000;
  }

  setAutoApprove(v: boolean): void {
    this.autoApprove = v;
  }

  get isAutoApprove(): boolean {
    return this.autoApprove;
  }

  /** UI 订阅：有新审批请求时推送。 */
  onRequest(fn: (req: ApprovalRequest) => void): () => void {
    this.onRequestListener = fn;
    return () => {
      if (this.onRequestListener === fn) this.onRequestListener = undefined;
    };
  }

  private key(sessionId: string, toolName: string): string {
    return `${sessionId}::${toolName}`;
  }

  isAlwaysAllowed(sessionId: string, toolName: string): boolean {
    return this.alwaysAllowed.has(this.key(sessionId, toolName));
  }

  async request(input: {
    sessionId: string;
    turn: number;
    step: number;
    toolName: string;
    arguments: Record<string, unknown>;
    reason: string;
  }): Promise<ApprovalDecision> {
    if (this.isAlwaysAllowed(input.sessionId, input.toolName)) return ApprovalDecision.Approve;
    if (this.autoApprove) return ApprovalDecision.Approve;

    const req: ApprovalRequest = {
      id: newId("appr"),
      sessionId: input.sessionId,
      toolName: input.toolName,
      arguments: input.arguments,
      reason: input.reason,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const event = this.record({
      sessionId: input.sessionId,
      turn: input.turn,
      step: input.step,
      type: EventType.ApprovalRequest,
      payload: { request: req },
    });
    await this.bus.emit(event);

    // 必须先登记 pending 再通知 UI：否则编程式/同步 resolve 会找不到请求。
    const promise = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(req.id)) {
          this.finish(req.id, ApprovalDecision.Deny, "审批超时，按拒绝处理");
        }
      }, this.timeoutMs);
      this.pending.set(req.id, {
        request: req,
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
      });
    });
    this.onRequestListener?.(req);
    return promise;
  }

  resolve(id: string, decision: ApprovalDecision, note?: string): boolean {
    return this.finish(id, decision, note);
  }

  private finish(id: string, decision: ApprovalDecision, note?: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.request.status = decision;
    this.pending.delete(id);
    if (decision === ApprovalDecision.Always) {
      this.alwaysAllowed.add(this.key(p.request.sessionId, p.request.toolName));
    }
    const event = this.record({
      sessionId: p.request.sessionId,
      turn: 0,
      step: 0,
      type: EventType.ApprovalResolved,
      payload: { id, decision, ...(note ? { note } : {}), toolName: p.request.toolName },
    });
    void this.bus.emit(event);
    p.resolve(decision);
    return true;
  }

  list(sessionId?: string): ApprovalRequest[] {
    return [...this.pending.values()]
      .map((p) => p.request)
      .filter((r) => !sessionId || r.sessionId === sessionId);
  }

  clearSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.request.sessionId === sessionId) this.finish(id, ApprovalDecision.Deny, "会话结束");
    }
    for (const k of this.alwaysAllowed) {
      if (k.startsWith(`${sessionId}::`)) this.alwaysAllowed.delete(k);
    }
  }
}
