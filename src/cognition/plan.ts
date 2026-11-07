/**
 * L4 认知层 · 任务规划与 TODO 状态机
 */
export const TodoStatus = {
  Pending: "pending",
  InProgress: "in_progress",
  Done: "done",
  Cancelled: "cancelled",
} as const;
export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface PlanProgress {
  total: number;
  done: number;
  inProgress: number;
  percent: number;
}

const VALID = new Set<string>(Object.values(TodoStatus));

export class PlanManager {
  private readonly plans = new Map<string, Todo[]>();

  write(sessionId: string, raw: unknown): { ok: boolean; message: string; todos: Todo[] } {
    if (!Array.isArray(raw)) return { ok: false, message: "todos 必须是数组", todos: this.read(sessionId) };
    const todos: Todo[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const item = raw[i] as Record<string, unknown>;
      if (!item || typeof item.content !== "string") {
        return { ok: false, message: `第 ${i + 1} 项缺少 content`, todos: this.read(sessionId) };
      }
      const status = typeof item.status === "string" && VALID.has(item.status) ? (item.status as TodoStatus) : TodoStatus.Pending;
      todos.push({ id: String(item.id ?? i + 1), content: item.content, status });
    }
    this.plans.set(sessionId, todos);
    return { ok: true, message: `已更新计划（${todos.length} 项）`, todos };
  }

  read(sessionId: string): Todo[] {
    return (this.plans.get(sessionId) ?? []).map((t) => ({ ...t }));
  }

  progress(sessionId: string): PlanProgress {
    const todos = this.read(sessionId);
    const done = todos.filter((t) => t.status === TodoStatus.Done).length;
    const inProgress = todos.filter((t) => t.status === TodoStatus.InProgress).length;
    return {
      total: todos.length,
      done,
      inProgress,
      percent: todos.length === 0 ? 0 : Math.round((done / todos.length) * 100),
    };
  }

  format(sessionId: string): string {
    const todos = this.read(sessionId);
    if (todos.length === 0) return "（当前没有计划）";
    const mark: Record<TodoStatus, string> = {
      pending: "[ ]",
      in_progress: "[~]",
      done: "[x]",
      cancelled: "[-]",
    };
    return `${todos.map((t) => `${mark[t.status]} ${t.id}. ${t.content}`).join("\n")}\n进度: ${this.progress(sessionId).percent}%`;
  }

  clear(sessionId: string): void {
    this.plans.delete(sessionId);
  }
}
