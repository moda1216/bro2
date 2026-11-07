/**
 * L5 协作层 · 自动化编排（定时触发 + 后台任务 + 进度查询）
 */
import { newId, EventType } from "../kernel/events.ts";
import type { EventDraft } from "../kernel/events.ts";

export const JobStatus = {
  Idle: "idle",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  Disabled: "disabled",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export interface ScheduledJob {
  id: string;
  name: string;
  task: string;
  preset: string;
  intervalMs: number;
  enabled: boolean;
  status: JobStatus;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastResult?: string;
  runCount: number;
}

export class AutomationScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly executor: (job: ScheduledJob) => Promise<string>;
  private readonly record?: (draft: EventDraft) => unknown;
  private running = false;

  constructor(options: {
    executor: (job: ScheduledJob) => Promise<string>;
    record?: (draft: EventDraft) => unknown;
  }) {
    this.executor = options.executor;
    this.record = options.record;
  }

  add(input: { name: string; task: string; preset?: string; intervalMs: number }): ScheduledJob {
    const job: ScheduledJob = {
      id: newId("job"),
      name: input.name,
      task: input.task,
      preset: input.preset ?? "standard",
      intervalMs: Math.max(1000, input.intervalMs),
      enabled: true,
      status: JobStatus.Idle,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    this.jobs.set(job.id, job);
    if (this.running) this.schedule(job);
    return { ...job };
  }

  remove(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.timers.delete(id);
    return this.jobs.delete(id);
  }

  enable(id: string, enabled: boolean): ScheduledJob | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    j.enabled = enabled;
    if (!enabled) {
      const timer = this.timers.get(id);
      if (timer) clearInterval(timer);
      this.timers.delete(id);
      j.status = JobStatus.Disabled;
    } else if (this.running) {
      j.status = JobStatus.Idle;
      this.schedule(j);
    }
    return { ...j };
  }

  list(): ScheduledJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  /** 立即执行一次（也可由工具/手动触发）。 */
  async runNow(id: string): Promise<string> {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`未找到任务: ${id}`);
    return this.execute(j);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const j of this.jobs.values()) if (j.enabled) this.schedule(j);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  private schedule(j: ScheduledJob): void {
    const old = this.timers.get(j.id);
    if (old) clearInterval(old);
    j.nextRunAt = new Date(Date.now() + j.intervalMs).toISOString();
    const timer = setInterval(() => {
      void this.execute(j).catch(() => undefined);
    }, j.intervalMs);
    timer.unref?.();
    this.timers.set(j.id, timer);
  }

  private async execute(j: ScheduledJob): Promise<string> {
    if (j.status === JobStatus.Running) return "任务仍在执行中，跳过本次触发";
    j.status = JobStatus.Running;
    j.lastRunAt = new Date().toISOString();
    j.nextRunAt = new Date(Date.now() + j.intervalMs).toISOString();
    this.record?.({
      sessionId: "automation",
      turn: 0,
      step: 0,
      type: EventType.Automation,
      payload: { jobId: j.id, event: "start", name: j.name },
    });
    try {
      const out = await this.executor(j);
      j.status = JobStatus.Succeeded;
      j.lastResult = out.slice(0, 2000);
      j.runCount += 1;
      return out;
    } catch (err) {
      j.status = JobStatus.Failed;
      j.lastResult = err instanceof Error ? err.message : String(err);
      j.runCount += 1;
      return `ERROR: ${j.lastResult}`;
    } finally {
      this.record?.({
        sessionId: "automation",
        turn: 0,
        step: 0,
        type: EventType.Automation,
        payload: { jobId: j.id, event: "end", status: j.status },
      });
    }
  }
}
