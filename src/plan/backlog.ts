/**
 * 计划账本（Plan Ledger）
 * ----------------------------------------------------------
 * 三本只增账本的最小读写层：
 *   backlog.jsonl  任务定义（人写一次，不再改）
 *   journal.jsonl  尝试事件（start / done / fail / block / unblock）
 *   lessons.jsonl  可复用工程教训（失败或反直觉成功时写）
 *
 * 设计约束（对应 docs/PLAN-TOP-HARNESS.md §11）：
 *   - 状态不单独存储，由 journal 折叠得出 —— 与 Trajectory 是唯一真相源同一哲学；
 *   - 纯函数与 IO 分离，测试只测纯函数；
 *   - 零第三方依赖。
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

export interface Task {
  id: string;
  battle: string;
  title: string;
  accept: string;
  loc: number;
  deps: string[];
}

export type JournalKind = "start" | "done" | "fail" | "block" | "unblock";

export interface JournalEvent {
  at: string;
  id: string;
  event: JournalKind;
  evidence?: string;
  loc?: number;
  reason?: string;
  note?: string;
}

export interface Lesson {
  at: string;
  scope: "engineering" | "harness";
  trigger: string;
  action: string;
  evidence: string;
  confidence: number;
}

/** 读 JSONL；文件不存在返回空数组（首次运行不应报错）。 */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as T);
}

/** 只增追加；自动建父目录。 */
export function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

/**
 * 由事件折叠任务状态。
 * 终态优先级：done > blocked；blocked 只能被 unblock 解除，避免「失败即放弃」被静默绕过。
 */
export function foldStatus(
  tasks: readonly Task[],
  events: readonly JournalEvent[],
): Map<string, TaskStatus> {
  const status = new Map<string, TaskStatus>(tasks.map((t) => [t.id, "todo"]));
  for (const e of events) {
    if (!status.has(e.id)) continue;
    const cur = status.get(e.id)!;
    if (cur === "done") continue;
    if (cur === "blocked" && e.event !== "unblock") continue;
    switch (e.event) {
      case "start": status.set(e.id, "doing"); break;
      case "done": status.set(e.id, "done"); break;
      case "fail": status.set(e.id, "todo"); break;
      case "block": status.set(e.id, "blocked"); break;
      case "unblock": status.set(e.id, "todo"); break;
    }
  }
  return status;
}

/** 已完成任务的 LOC 合计（用于对照战役预算；fail 不计数）。 */
export function foldLoc(events: readonly JournalEvent[]): number {
  return events
    .filter((e) => e.event === "done")
    .reduce((sum, e) => sum + (e.loc ?? 0), 0);
}

/** 每个任务的失败次数，用于识别反复卡住的项。 */
export function foldFailures(events: readonly JournalEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.event !== "fail") continue;
    out.set(e.id, (out.get(e.id) ?? 0) + 1);
  }
  return out;
}
