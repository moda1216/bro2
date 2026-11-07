/**
 * L5 协作层 · 子智能体派生与并行汇总
 *
 * 通过注入 spawn 回调复用主循环，避免与 AgentLoop 循环依赖。
 * 子 Agent 拥有隔离的上下文与独立预算，结果只回传摘要，不污染父上下文。
 */
import { EventType } from "../kernel/events.ts";
import type { EventDraft } from "../kernel/events.ts";

export interface SubTask {
  task: string;
  preset?: string;
  input?: string;
}

export interface SubTaskResult {
  task: string;
  preset: string;
  ok: boolean;
  output: string;
  elapsedMs: number;
  error?: string;
}

export interface SpawnContext {
  parentSessionId: string;
  turn: number;
  step: number;
  signal?: AbortSignal;
  depth: number;
  record: (draft: EventDraft) => unknown;
  publish: (event: unknown) => Promise<void>;
}

export type SpawnFn = (preset: string, task: string, ctx: SpawnContext) => Promise<string>;

export class SubAgentRunner {
  private readonly spawn: SpawnFn;
  private readonly maxDepth: number;
  private readonly concurrency: number;

  constructor(options: { spawn: SpawnFn; maxDepth?: number; concurrency?: number }) {
    this.spawn = options.spawn;
    this.maxDepth = options.maxDepth ?? 2;
    this.concurrency = options.concurrency ?? 3;
  }

  get depthLimit(): number {
    return this.maxDepth;
  }

  async run(tasks: readonly SubTask[], ctx: SpawnContext): Promise<SubTaskResult[]> {
    if (ctx.depth >= this.maxDepth) {
      return tasks.map((t) => ({
        task: t.task,
        preset: t.preset ?? "researcher",
        ok: false,
        output: "",
        elapsedMs: 0,
        error: `已达到子 Agent 最大嵌套深度 ${this.maxDepth}，拒绝继续派生`,
      }));
    }
    const results: SubTaskResult[] = new Array(tasks.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, tasks.length) }, async () => {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= tasks.length) break;
        const t = tasks[i]!;
        const preset = t.preset ?? "researcher";
        const started = Date.now();
        const fullTask = t.input ? `${t.task}\n\n补充材料：\n${t.input}` : t.task;
        ctx.record({
          sessionId: ctx.parentSessionId,
          turn: ctx.turn,
          step: ctx.step,
          type: EventType.SubAgentStart,
          payload: { task: t.task.slice(0, 200), preset, depth: ctx.depth + 1 },
        });
        try {
          const output = await this.spawn(preset, fullTask, { ...ctx, depth: ctx.depth + 1 });
          results[i] = { task: t.task, preset, ok: true, output, elapsedMs: Date.now() - started };
        } catch (err) {
          results[i] = {
            task: t.task,
            preset,
            ok: false,
            output: "",
            elapsedMs: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        ctx.record({
          sessionId: ctx.parentSessionId,
          turn: ctx.turn,
          step: ctx.step,
          type: EventType.SubAgentEnd,
          payload: { task: t.task.slice(0, 200), ok: results[i]!.ok, elapsedMs: results[i]!.elapsedMs },
        });
      }
    });
    await Promise.all(workers);
    return results;
  }

  static format(results: readonly SubTaskResult[]): string {
    return results
      .map((r, i) =>
        `### 子任务 ${i + 1} [${r.preset}] ${r.ok ? "成功" : "失败"}\n任务: ${r.task}\n结果: ${r.ok ? r.output : `ERROR: ${r.error}`}\n耗时: ${r.elapsedMs}ms`,
      )
      .join("\n\n");
  }
}
