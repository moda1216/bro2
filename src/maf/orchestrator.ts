/**
 * 多实例编排器：同一共享文件系统上的多进程 worker 池。
 * 唯一事实源是只增账本 cluster.jsonl；任何状态都由 fold 重放得出，绝不整文件覆盖。
 * 写入统一经过 cluster.lock（mkdir 原子互斥）+ 乐观并发 baseSeq + leaseToken fencing。
 * 边界：单机共享磁盘可串行化；跨机共识/网络分区容错未实现，不宣称。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventType } from "../kernel/events.ts";
import type { Event, EventDraft } from "../kernel/events.ts";

export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "deadletter";
export interface TaskNode { id: string; task: string; domain?: string; agentId?: string; agentVersion?: string; deps: string[]; status: NodeStatus; attempts: number; maxAttempts: number; idempotencyKey: string; leaseUntil?: string; leaseOwner?: string; leaseToken?: string; lastSeq?: number; result?: string; error?: string }
export interface MafTask { id: string; name: string; status: "pending" | "running" | "succeeded" | "failed" | "cancelled"; nodes: TaskNode[]; trigger: "manual" | "interval" | "event"; intervalMs?: number; nextRunAt?: string; createdAt: string; updatedAt: string; lastRunAt?: string; cancelled?: boolean }
export interface ExecuteContext { taskId: string; nodeId: string; idempotencyKey: string; signal: AbortSignal }

type Op = "task.submit" | "task.tick" | "task.cancel" | "claim" | "heartbeat" | "commit" | "node.error" | "lease.recover" | "worker.join" | "worker.hb" | "audit" | "event";
interface Rec { seq: number; ts: string; by: string; op: Op; action?: string; taskId?: string; nodeId?: string; token?: string; baseSeq?: number; leaseUntil?: string; result?: string; error?: string; detail?: string; payload?: Record<string, unknown> }
interface Worker { id: string; pid: number; joinedAt: string; lastSeen: string; role: string }
interface Audit { ts: string; action: string; taskId: string; nodeId?: string; detail?: string }
interface State { tasks: MafTask[]; commits: Record<string, string>; audit: Audit[]; workers: Worker[]; rejects: Array<{ seq: number; by: string; op: Op; detail: string }>; events: Event[]; seq: number }

const LOCK_STALE_MS = 3000;
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** 同一共享文件系统上的原子互斥：mkdir 是 POSIX 原子操作；解锁前校验 owner，绝不误删他人锁；等待超时 fail-closed。 */
export function withLock<T>(lockDir: string, fn: () => T): T {
  const tag = `${process.pid}:${randomUUID().slice(0, 8)}`;
  for (let i = 0; i < 300; i++) {
    try { mkdirSync(lockDir); break; } catch {
      try { if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) rmSync(lockDir, { recursive: true, force: true }); } catch { /* 已被其他实例清理 */ }
      if (i === 299) throw new Error(`锁等待超时（${lockDir}）：fail-closed，拒绝无锁写入`);
      pause(2);
    }
  }
  writeFileSync(join(lockDir, "owner"), tag);
  try { return fn(); } finally {
    try { if (readFileSync(join(lockDir, "owner"), "utf8") === tag) rmSync(lockDir, { recursive: true, force: true }); } catch { /* 锁已被抢占，不删除他人锁 */ }
  }
}

export class Orchestrator {
  readonly path: string;
  readonly ledger: string;
  readonly instanceId = randomUUID().slice(0, 8);
  private readonly lockDir: string;
  private state: State;
  private readonly controllers = new Map<string, AbortController>();
  private readonly executor: (node: TaskNode, ctx: ExecuteContext) => Promise<string>;
  private readonly record?: (draft: EventDraft) => unknown;
  private readonly leaseMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private lastHb = 0;

  constructor(root: string, executor: (node: TaskNode, ctx: ExecuteContext) => Promise<string>, leaseMs = 30000, record?: (draft: EventDraft) => unknown) {
    this.executor = executor; this.leaseMs = leaseMs; this.record = record;
    const dir = join(root, "maf"); mkdirSync(dir, { recursive: true });
    this.ledger = join(dir, "cluster.jsonl"); this.path = this.ledger; this.lockDir = join(dir, "cluster.lock");
    this.lock((recs) => { this.append(recs, { op: "worker.join", payload: { pid: process.pid, role: "worker" } }); });
    this.state = this.sync();
  }

  private readRecs(): Rec[] {
    if (!existsSync(this.ledger)) return [];
    return readFileSync(this.ledger, "utf8").split("\n").filter(Boolean).map((l, i) => {
      try { return JSON.parse(l) as Rec; } catch { throw new Error(`集群账本第 ${i + 1} 行损坏：拒绝静默重建，需人工恢复`); }
    });
  }
  private append(recs: Rec[], r: Omit<Rec, "seq" | "ts" | "by">): Rec {
    const rec: Rec = { seq: recs.length, ts: new Date().toISOString(), by: this.instanceId, ...r };
    appendFileSync(this.ledger, `${JSON.stringify(rec)}\n`); recs.push(rec); return rec;
  }
  private lock<T>(fn: (recs: Rec[]) => T): T { return withLock(this.lockDir, () => fn(this.readRecs())); }
  /** 确定性状态机投影：只认「记录自身时间戳」，不用 Date.now()，保证任何进程重放结果一致。 */
  private fold(recs: Rec[]): State {
    const s: State = { tasks: [], commits: {}, audit: [], workers: [], rejects: [], events: [], seq: recs.length };
    const bad = (r: Rec, why: string): void => { s.rejects.push({ seq: r.seq, by: r.by, op: r.op, detail: why }); };
    const node = (r: Rec): TaskNode | undefined => s.tasks.find((t) => t.id === r.taskId)?.nodes.find((n) => n.id === r.nodeId);
    const clear = (n: TaskNode, seq: number): void => { delete n.leaseUntil; delete n.leaseOwner; delete n.leaseToken; n.lastSeq = seq; };
    for (const r of recs) {
      const n = node(r);
      switch (r.op) {
        case "task.submit": {
          const t = r.payload?.task as unknown as MafTask | undefined; if (!t) break;
          const copy: MafTask = { ...t, nodes: t.nodes.map((x) => ({ ...x, status: "pending" as NodeStatus, lastSeq: r.seq })) };
          s.tasks.push(copy); s.audit.push({ ts: r.ts, action: "task.submit", taskId: t.id });
          break;
        }
        case "claim": {
          if (!n || n.status !== "pending" || r.baseSeq !== n.lastSeq) { bad(r, `claim 冲突 status=${n?.status} base=${r.baseSeq} last=${n?.lastSeq}`); break; }
          n.status = "running"; n.attempts += 1; n.leaseOwner = r.by; n.leaseToken = r.token; n.leaseUntil = r.leaseUntil; n.lastSeq = r.seq;
          s.audit.push({ ts: r.ts, action: "node.start", taskId: r.taskId ?? "", nodeId: r.nodeId, detail: `attempt=${n.attempts} by=${r.by}` });
          break;
        }
        case "heartbeat": {
          if (!n || n.status !== "running" || n.leaseToken !== r.token || n.leaseOwner !== r.by) { bad(r, "heartbeat: token/owner 不匹配"); break; }
          if (Date.parse(r.leaseUntil ?? "0") > Date.parse(n.leaseUntil ?? "0")) { n.leaseUntil = r.leaseUntil; n.lastSeq = r.seq; }
          break;
        }
        case "lease.recover": {
          if (!n || n.status !== "running" || n.leaseToken !== r.token) { bad(r, "recover: token 不匹配"); break; }
          n.status = n.attempts >= n.maxAttempts ? "deadletter" : "pending"; clear(n, r.seq);
          s.audit.push({ ts: r.ts, action: "lease.recover", taskId: r.taskId ?? "", nodeId: r.nodeId, detail: "过期租约恢复，未完成节点重新排队" });
          break;
        }
        case "commit": {
          if (!n || n.status !== "running" || n.leaseToken !== r.token || n.leaseOwner !== r.by || Date.parse(r.ts) > Date.parse(n.leaseUntil ?? "0")) { bad(r, `fencing 拒绝陈旧提交 by=${r.by} token=${r.token?.slice(0, 8)}`); break; }
          s.commits[n.idempotencyKey] = r.result ?? ""; n.status = "succeeded"; n.result = r.result; delete n.error; clear(n, r.seq);
          s.audit.push({ ts: r.ts, action: "node.commit", taskId: r.taskId ?? "", nodeId: r.nodeId, detail: `by=${r.by}` });
          break;
        }
        case "node.error": {
          if (!n || n.status !== "running" || n.leaseToken !== r.token) { bad(r, "node.error: token 不匹配"); break; }
          n.error = r.error; n.status = n.attempts >= n.maxAttempts ? "deadletter" : "pending"; clear(n, r.seq);
          s.audit.push({ ts: r.ts, action: "node.error", taskId: r.taskId ?? "", nodeId: r.nodeId, detail: `${r.error}; status=${n.status}` });
          break;
        }
        case "task.cancel": {
          const t = s.tasks.find((x) => x.id === r.taskId); if (!t) break;
          t.cancelled = true;
          for (const x of t.nodes) { if (x.status === "pending" || x.status === "running" || x.status === "failed") x.status = "cancelled"; x.lastSeq = r.seq; }
          s.audit.push({ ts: r.ts, action: "task.cancel", taskId: t.id });
          break;
        }
        case "task.tick": { const t = s.tasks.find((x) => x.id === r.taskId); if (t) { t.lastRunAt = r.ts; t.updatedAt = r.ts; } break; }
        case "worker.join": case "worker.hb": {
          const w = s.workers.find((x) => x.id === r.by);
          if (w) w.lastSeen = r.ts;
          else s.workers.push({ id: r.by, pid: Number(r.payload?.pid ?? 0), joinedAt: r.ts, lastSeen: r.ts, role: String(r.payload?.role ?? "worker") });
          break;
        }
        case "audit": { s.audit.push({ ts: r.ts, action: r.action ?? "audit", taskId: r.taskId ?? "", ...(r.nodeId ? { nodeId: r.nodeId } : {}), ...(r.detail ? { detail: r.detail } : {}) }); break; }
        case "event": { if (r.payload) s.events.push({ ...(r.payload as unknown as EventDraft), seq: r.seq, ts: r.ts, instanceId: r.by } as Event); break; }
      }
    }
    for (const t of s.tasks) {
      t.status = t.cancelled ? "cancelled" : t.nodes.every((n) => n.status === "succeeded") ? "succeeded" : t.nodes.some((n) => n.status === "deadletter" || n.status === "failed") ? "failed" : t.nodes.some((n) => n.status === "running") ? "running" : "pending";
      t.nextRunAt = t.trigger === "interval" && t.intervalMs ? new Date(Date.parse(t.lastRunAt ?? t.createdAt) + t.intervalMs).toISOString() : undefined;
    }
    return s;
  }
  private read(): State { return this.lock((recs) => this.fold(recs)); }
  /** 领取过期租约 + 本实例心跳；每次循环重新投影，绝不沿用陈旧内存对象。 */
  private sync(): State {
    const st = this.lock((recs) => {
      const before = this.fold(recs), now = Date.now();
      for (const t of before.tasks) for (const n of t.nodes) if (n.status === "running" && Date.parse(n.leaseUntil ?? "0") <= now) {
        this.append(recs, { op: "lease.recover", taskId: t.id, nodeId: n.id, token: n.leaseToken, detail: `租约于 ${n.leaseUntil} 过期` });
      }
      if (Date.now() - this.lastHb > 1000) { this.append(recs, { op: "worker.hb", payload: { pid: process.pid, role: "worker" } }); this.lastHb = Date.now(); }
      return this.fold(recs);
    });
    this.state = st; return st;
  }
  private log(action: string, taskId: string, nodeId?: string, detail?: string): void {
    const draft: EventDraft = { sessionId: `maf:${taskId}`, turn: 0, step: 0, type: EventType.MafTask, payload: { action, taskId, nodeId, detail }, runId: nodeId ? `${taskId}:${nodeId}` : taskId, rootRunId: taskId, correlationId: taskId, causationId: nodeId ?? taskId };
    this.record?.(draft);
    this.lock((recs) => { this.append(recs, { op: "event", payload: draft as unknown as Record<string, unknown> }); });
  }
  private key(t: MafTask, n: TaskNode): string { return `${t.id}:${n.id}`; }
  private current(recs: Rec[], taskId: string, nodeId: string): TaskNode | undefined { return this.fold(recs).tasks.find((t) => t.id === taskId)?.nodes.find((n) => n.id === nodeId); }

  list(): MafTask[] { this.state = this.read(); return this.state.tasks; }
  get(id: string): MafTask | undefined { this.state = this.read(); return this.state.tasks.find((t) => t.id === id); }
  audit(): Audit[] { return this.read().audit; }
  runDue(): MafTask[] { const now = Date.now(); return this.read().tasks.filter((t) => t.trigger === "interval" && t.status !== "running" && t.status !== "cancelled" && Date.parse(t.nextRunAt ?? "0") <= now); }
  seq(): number { return this.read().seq; }
  events(): Event[] { return this.read().events; }
  eventsSince(cursor: number): Event[] { return this.read().events.filter((e) => (e.seq ?? 0) > cursor); }
  cluster(): Record<string, unknown> {
    const s = this.read(), now = Date.now();
    const all = s.workers.map((w) => ({ ...w, alive: now - Date.parse(w.lastSeen) < 5000, self: w.id === this.instanceId }));
    const alive = all.filter((w) => w.alive), gone = all.filter((w) => !w.alive).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))).slice(0, 8);
    return {
      instanceId: this.instanceId, pid: process.pid, scope: "same-host-shared-fs", ledger: this.ledger, seq: s.seq,
      mode: "append-only-ledger + atomic-lock + optimistic-concurrency + fencing",
      workers: [...alive, ...gone], totalWorkers: all.length,
      tasks: s.tasks, rejects: s.rejects, events: s.events.slice(-200), audit: s.audit.slice(-100),
      honest: "单机共享磁盘的多进程 worker 池，写入可串行化；跨机共识、网络分区容错、分布式时钟与真实流量灰度未实现，不宣称。",
    };
  }

  submit(input: { name: string; nodes: Array<Partial<TaskNode> & { id: string; task: string }>; trigger?: MafTask["trigger"]; intervalMs?: number }): MafTask {
    const ids = new Set(input.nodes.map((n) => n.id)); if (ids.size !== input.nodes.length || !input.nodes.length) throw new Error("DAG 节点为空或 ID 重复");
    const nodes: TaskNode[] = input.nodes.map((n) => ({ id: n.id, task: n.task, ...(n.domain ? { domain: n.domain } : {}), ...(n.agentId ? { agentId: n.agentId } : {}), ...(n.agentVersion ? { agentVersion: n.agentVersion } : {}), deps: n.deps ?? [], status: "pending", attempts: 0, maxAttempts: Math.min(n.maxAttempts ?? 3, 3), idempotencyKey: n.idempotencyKey ?? `${input.name}:${n.id}` }));
    for (const n of nodes) for (const d of n.deps) if (!ids.has(d)) throw new Error(`未知依赖: ${d}`);
    const visiting = new Set<string>(), visited = new Set<string>(), byId = new Map(nodes.map((n) => [n.id, n]));
    const visit = (id: string): void => { if (visiting.has(id)) throw new Error("DAG 存在循环依赖"); if (visited.has(id)) return; visiting.add(id); for (const d of byId.get(id)!.deps) visit(d); visiting.delete(id); visited.add(id); };
    for (const n of nodes) visit(n.id);
    const now = new Date().toISOString(), t: MafTask = { id: `task_${this.instanceId}_${randomUUID().slice(0, 8)}`, name: input.name, status: "pending", nodes, trigger: input.trigger ?? "manual", ...(input.intervalMs ? { intervalMs: Math.max(1000, input.intervalMs) } : {}), createdAt: now, updatedAt: now };
    this.lock((recs) => { this.append(recs, { op: "task.submit", taskId: t.id, payload: { task: t as unknown as Record<string, unknown> } }); });
    this.log("task.submit", t.id); return this.get(t.id)!;
  }

  private async claimAndExecute(t: MafTask, n: TaskNode): Promise<void> {
    const token = randomUUID(), leaseUntil = new Date(Date.now() + this.leaseMs).toISOString(), expected = n.lastSeq;
    const claimed = this.lock((recs) => {
      const cur = this.current(recs, t.id, n.id);
      if (!cur || cur.status !== "pending" || cur.lastSeq !== expected) {
        this.append(recs, { op: "audit", action: "claim.reject", taskId: t.id, nodeId: n.id, detail: `乐观锁冲突 status=${cur?.status} expected=${expected} actual=${cur?.lastSeq}` });
        return false;
      }
      this.append(recs, { op: "claim", taskId: t.id, nodeId: n.id, token, leaseUntil, baseSeq: expected });
      return true;
    });
    if (!claimed) return;
    const controller = new AbortController(); this.controllers.set(this.key(t, n), controller);
    const hb = setInterval(() => { this.lock((recs) => { const cur = this.current(recs, t.id, n.id); if (cur && cur.status === "running" && cur.leaseToken === token) this.append(recs, { op: "heartbeat", taskId: t.id, nodeId: n.id, token, leaseUntil: new Date(Date.now() + this.leaseMs).toISOString() }); }); }, Math.max(5, Math.floor(this.leaseMs / 3)));
    hb.unref?.();
    try {
      const result = await this.executor(n, { taskId: t.id, nodeId: n.id, idempotencyKey: n.idempotencyKey, signal: controller.signal });
      this.lock((recs) => { this.append(recs, { op: "commit", taskId: t.id, nodeId: n.id, token, result }); });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.get(t.id)?.cancelled) this.lock((recs) => { this.append(recs, { op: "node.error", taskId: t.id, nodeId: n.id, token, error: message }); });
      else this.log("node.cancel", t.id, n.id, message);
    } finally { clearInterval(hb); this.controllers.delete(this.key(t, n)); }
  }

  async run(id: string): Promise<MafTask> {
    if (!this.get(id)) throw new Error("任务不存在");
    if (this.get(id)!.status === "cancelled") throw new Error("任务已取消");
    this.log("task.start", id);
    for (;;) {
      const st = this.sync(), t = st.tasks.find((x) => x.id === id); if (!t) throw new Error("任务不存在");
      if (t.status === "cancelled" || t.status === "succeeded" || t.status === "failed") break;
      const byId = new Map(t.nodes.map((n) => [n.id, n]));
      const ready = t.nodes.filter((n) => n.status === "pending" && n.deps.every((d) => byId.get(d)?.status === "succeeded"));
      if (ready.length) { await Promise.all(ready.slice(0, 2).map((n) => this.claimAndExecute(t, n))); continue; }
      if (t.nodes.some((n) => n.status === "running")) { await new Promise((r) => setTimeout(r, 10)); continue; }
      break;
    }
    this.lock((recs) => { this.append(recs, { op: "task.tick", taskId: id }); });
    const done = this.get(id)!; this.log("task.end", id, undefined, done.status);
    return done;
  }
  cancel(id: string): MafTask {
    if (!this.get(id)) throw new Error("任务不存在");
    this.lock((recs) => { this.append(recs, { op: "task.cancel", taskId: id }); });
    for (const [k, c] of this.controllers) if (k.startsWith(`${id}:`)) c.abort();
    this.log("task.cancel", id); return this.get(id)!;
  }
  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return; const due = (this.sync(), this.runDue()[0]); if (!due) return;
      this.busy = true; void this.run(due.id).catch(() => undefined).finally(() => { this.busy = false; });
    }, Math.max(100, intervalMs)); this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
