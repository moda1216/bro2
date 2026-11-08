/**
 * 任务选择与教训检索（纯函数，无 IO）
 * ----------------------------------------------------------
 * 职责边界：
 *   - 只决定「下一个该做什么」和「这次要提防什么」；
 *   - 不执行、不写盘、不判定质量（那是门禁的事）。
 */
import type { Lesson, Task, TaskStatus } from "./backlog.ts";

/**
 * 选下一个可执行任务：状态为 todo、依赖全部 done、按 id 升序。
 * 返回 null 表示没有可推进项（全部完成或全部阻塞）——调用方必须如实上报，不得跳过阻塞项。
 */
export function nextTask(
  tasks: readonly Task[],
  status: ReadonlyMap<string, TaskStatus>,
): Task | null {
  const ready = tasks
    .filter((t) => status.get(t.id) === "todo")
    .filter((t) => t.deps.every((d) => status.get(d) === "done"))
    .sort((a, b) => a.id.localeCompare(b.id));
  return ready[0] ?? null;
}

/** 被阻塞或依赖未满足而暂时无法执行的任务，用于向人解释「为什么停在这里」。 */
export function blockedBy(tasks: readonly Task[], status: ReadonlyMap<string, TaskStatus>): Task[] {
  return tasks.filter((t) => {
    const s = status.get(t.id);
    if (s === "done" || s === "doing") return false;
    return s === "blocked" || !t.deps.every((d) => status.get(d) === "done");
  });
}

/** 中文按二元字组、英文按词切分，避免分词依赖。 */
function grams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

/**
 * 检索与任务相关的教训。
 * 命中条件：二元组交集 >= 2 且覆盖较短一方的 15% 以上。
 * confidence <= 0 的教训视为失效（保留在账本里供审计，但不再提示）。
 */
export function matchLessons(lessons: readonly Lesson[], task: Task): Lesson[] {
  const target = grams(task.title + task.accept);
  return lessons
    .filter((l) => l.confidence > 0)
    .map((l) => {
      const src = grams(l.trigger);
      let hit = 0;
      for (const g of src) if (target.has(g)) hit += 1;
      const cover = Math.min(src.size, target.size);
      return { lesson: l, hit, ok: hit >= 2 && cover > 0 && hit / cover >= 0.15 };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.hit - a.hit)
    .map((x) => x.lesson);
}

export interface BattleProgress {
  battle: string;
  total: number;
  done: number;
  blocked: number;
}

/** 按战役统计进度；battle 顺序取首次出现顺序，保持与 backlog 一致。 */
export function battleProgress(
  tasks: readonly Task[],
  status: ReadonlyMap<string, TaskStatus>,
): BattleProgress[] {
  const map = new Map<string, BattleProgress>();
  for (const t of tasks) {
    const row = map.get(t.battle) ?? { battle: t.battle, total: 0, done: 0, blocked: 0 };
    row.total += 1;
    const s = status.get(t.id);
    if (s === "done") row.done += 1;
    if (s === "blocked") row.blocked += 1;
    map.set(t.battle, row);
  }
  return [...map.values()];
}
