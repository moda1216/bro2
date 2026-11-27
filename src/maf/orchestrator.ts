import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId, EventType } from "../kernel/events.ts";
import type { EventDraft } from "../kernel/events.ts";

export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "deadletter";
export interface TaskNode { id: string; task: string; domain?: string; agentId?: string; agentVersion?: string; deps: string[]; status: NodeStatus; attempts: number; maxAttempts: number; idempotencyKey: string; leaseUntil?: string; leaseOwner?: string; result?: string; error?: string }
export interface MafTask { id: string; name: string; status: "pending" | "running" | "succeeded" | "failed" | "cancelled"; nodes: TaskNode[]; trigger: "manual" | "interval" | "event"; intervalMs?: number; nextRunAt?: string; createdAt: string; updatedAt: string }
interface State { tasks: MafTask[]; commits: Record<string, string>; audit: Array<{ ts: string; action: string; taskId: string; nodeId?: string; detail?: string }> }
export interface ExecuteContext { taskId: string; nodeId: string; idempotencyKey: string; signal: AbortSignal }

export class Orchestrator {
  readonly path: string;
  private state: State;
  private readonly controllers = new Map<string, AbortController>();
  private readonly owner = newId("worker");
  private readonly executor: (node: TaskNode, ctx: ExecuteContext) => Promise<string>;
  private readonly leaseMs: number;
  private readonly record?: (draft: EventDraft) => unknown;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(root: string, executor: (node: TaskNode, ctx: ExecuteContext) => Promise<string>, leaseMs = 30000, record?: (draft: EventDraft) => unknown) {
    this.executor = executor; this.leaseMs = leaseMs; this.record = record;
    this.path = join(root, "data", "maf", "orchestrator.json"); mkdirSync(dirname(this.path), { recursive: true });
    this.state = this.load(); this.recover();
  }
  private load(): State { if (!existsSync(this.path)) return { tasks: [], commits: {}, audit: [] }; try { return JSON.parse(readFileSync(this.path, "utf8")) as State; } catch { throw new Error("编排状态损坏：拒绝静默重建，需人工恢复"); } }
  private save(): void { const tmp = `${this.path}.tmp`; writeFileSync(tmp, JSON.stringify(this.state, null, 2)); renameSync(tmp, this.path); }
  private log(action: string, taskId: string, nodeId?: string, detail?: string): void {
    this.state.audit.push({ ts: new Date().toISOString(), action, taskId, ...(nodeId ? { nodeId } : {}), ...(detail ? { detail } : {}) });
    this.record?.({ sessionId: `maf:${taskId}`, turn: 0, step: 0, type: EventType.MafTask, payload: { action, taskId, nodeId, detail }, runId: nodeId ? `${taskId}:${nodeId}` : taskId, rootRunId: taskId, correlationId: taskId, causationId: nodeId ?? taskId });
  }
  private touch(t: MafTask): void { t.updatedAt = new Date().toISOString(); this.save(); }
  private recover(): void {
    const now = Date.now(); let changed = false;
    for (const t of this.state.tasks) for (const n of t.nodes) if (n.status === "running" && Date.parse(n.leaseUntil ?? "0") <= now) {
      n.status = "pending"; delete n.leaseUntil; delete n.leaseOwner; t.status = "pending"; this.log("lease.recover", t.id, n.id, "过期租约恢复，未完成节点重新排队"); changed = true;
    }
    if (changed) this.save();
  }
  list(): MafTask[] { return this.state.tasks; }
  get(id: string): MafTask | undefined { return this.state.tasks.find((t) => t.id === id); }
  submit(input: { name: string; nodes: Array<Partial<TaskNode> & { id: string; task: string }>; trigger?: MafTask["trigger"]; intervalMs?: number }): MafTask {
    const ids = new Set(input.nodes.map((n) => n.id)); if (ids.size !== input.nodes.length || !input.nodes.length) throw new Error("DAG 节点为空或 ID 重复");
    const nodes: TaskNode[] = input.nodes.map((n) => ({ id: n.id, task: n.task, ...(n.domain ? { domain: n.domain } : {}), ...(n.agentId ? { agentId: n.agentId } : {}), ...(n.agentVersion ? { agentVersion: n.agentVersion } : {}), deps: n.deps ?? [], status: "pending", attempts: 0, maxAttempts: Math.min(n.maxAttempts ?? 3, 3), idempotencyKey: n.idempotencyKey ?? `${input.name}:${n.id}` }));
    for (const n of nodes) for (const d of n.deps) if (!ids.has(d)) throw new Error(`未知依赖: ${d}`);
    const visiting = new Set<string>(), visited = new Set<string>(), byId = new Map(nodes.map((n) => [n.id, n]));
    const visit = (id: string): void => { if (visiting.has(id)) throw new Error("DAG 存在循环依赖"); if (visited.has(id)) return; visiting.add(id); for (const d of byId.get(id)!.deps) visit(d); visiting.delete(id); visited.add(id); };
    for (const n of nodes) visit(n.id);
    const now = new Date().toISOString(), t: MafTask = { id: newId("task"), name: input.name, status: "pending", nodes, trigger: input.trigger ?? "manual", ...(input.intervalMs ? { intervalMs: Math.max(1000, input.intervalMs), nextRunAt: new Date(Date.now() + Math.max(1000, input.intervalMs)).toISOString() } : {}), createdAt: now, updatedAt: now };
    this.state.tasks.push(t); this.log("task.submit", t.id); this.save(); return t;
  }
  async run(id: string): Promise<MafTask> {
    const t = this.get(id); if (!t) throw new Error("任务不存在"); if (t.status === "cancelled") throw new Error("任务已取消");
    this.recover(); t.status = "running"; this.log("task.start", id); this.touch(t);
    while (t.status === "running") {
      const ready = t.nodes.filter((n) => n.status === "pending" && n.deps.every((d) => t.nodes.find((x) => x.id === d)?.status === "succeeded"));
      if (ready.length) { await Promise.all(ready.slice(0, 2).map((n) => this.execute(t, n))); continue; }
      if (t.nodes.some((n) => n.status === "running")) { await new Promise((r) => setTimeout(r, 5)); continue; }
      break;
    }
    if (t.status !== "cancelled") t.status = t.nodes.every((n) => n.status === "succeeded") ? "succeeded" : t.nodes.some((n) => n.status === "deadletter" || n.status === "failed") ? "failed" : "pending";
    if (t.trigger === "interval" && t.intervalMs) t.nextRunAt = new Date(Date.now() + t.intervalMs).toISOString();
    this.log("task.end", id, undefined, t.status); this.touch(t); return t;
  }
  private async execute(t: MafTask, n: TaskNode): Promise<void> {
    const committed = this.state.commits[n.idempotencyKey]; if (committed !== undefined) { n.status = "succeeded"; n.result = committed; this.log("idempotent.skip", t.id, n.id); this.touch(t); return; }
    n.status = "running"; n.attempts += 1; n.leaseOwner = this.owner; n.leaseUntil = new Date(Date.now() + this.leaseMs).toISOString(); this.log("node.start", t.id, n.id, `attempt=${n.attempts}`); this.touch(t);
    const controller = new AbortController(); this.controllers.set(`${t.id}:${n.id}`, controller);
    const heartbeat = setInterval(() => { if (n.status === "running") { n.leaseUntil = new Date(Date.now() + this.leaseMs).toISOString(); this.save(); } }, Math.max(5, Math.floor(this.leaseMs / 3))); heartbeat.unref?.();
    try {
      const result = await this.executor(n, { taskId: t.id, nodeId: n.id, idempotencyKey: n.idempotencyKey, signal: controller.signal });
      if (controller.signal.aborted || t.status === "cancelled") { n.status = "cancelled"; this.log("node.cancel", t.id, n.id); }
      else { this.state.commits[n.idempotencyKey] = result; n.status = "succeeded"; n.result = result; delete n.error; this.log("node.commit", t.id, n.id); }
    } catch (err) {
      n.error = err instanceof Error ? err.message : String(err);
      n.status = controller.signal.aborted ? "cancelled" : n.attempts < n.maxAttempts ? "pending" : "deadletter";
      this.log("node.error", t.id, n.id, `${n.error}; status=${n.status}`);
    } finally { clearInterval(heartbeat); this.controllers.delete(`${t.id}:${n.id}`); delete n.leaseUntil; delete n.leaseOwner; this.touch(t); }
  }
  cancel(id: string): MafTask {
    const t = this.get(id); if (!t) throw new Error("任务不存在"); t.status = "cancelled";
    for (const n of t.nodes) if (n.status === "pending") n.status = "cancelled";
    for (const n of t.nodes) if (n.status === "running") this.controllers.get(`${id}:${n.id}`)?.abort();
    this.log("task.cancel", id); this.touch(t); return t;
  }
  runDue(): MafTask[] { const now = Date.now(); return this.state.tasks.filter((t) => t.trigger === "interval" && t.status !== "running" && t.status !== "cancelled" && Date.parse(t.nextRunAt ?? "0") <= now); }
  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return; const due = this.runDue()[0]; if (!due) return;
      this.busy = true; void this.run(due.id).catch(() => undefined).finally(() => { this.busy = false; });
    }, Math.max(100, intervalMs)); this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  audit(): State["audit"] { return this.state.audit; }
}
