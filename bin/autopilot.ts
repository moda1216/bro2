#!/usr/bin/env node
/**
 * autopilot · 计划执行器（调度 + 记账，不写代码）
 * ----------------------------------------------------------
 * 它解决的是「状态留在对话里」的问题：进度、教训、阻塞项全部来自
 * data/plan/*.jsonl 只增账本，任何一次会话读一遍就能接上。
 *
 *   npm run auto:next                 下一个任务卡（含验收、预算、命中的教训）
 *   npm run auto:status               五个战役进度 + 阻塞项 + 已用 LOC
 *   npm run auto:done -- W1-01 --evidence <sha> --loc 142
 *   npm run auto:fail -- W1-01 --reason "..." [--lesson-action "..."]
 *   npm run auto:block -- W1-01 --reason "..."
 *   npm run auto:unblock -- W1-01
 *
 * 边界（见 docs/PLAN-TOP-HARNESS.md §11）：本脚本不做实现、不跑门禁、不联网。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendJsonl, foldFailures, foldLoc, foldStatus, readJsonl } from "../src/plan/backlog.ts";
import type { JournalEvent, Lesson, Task } from "../src/plan/backlog.ts";
import { battleProgress, blockedBy, matchLessons, nextTask } from "../src/plan/select.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data", "plan");
const BACKLOG = join(DIR, "backlog.jsonl");
const JOURNAL = join(DIR, "journal.jsonl");
const LESSONS = join(DIR, "lessons.jsonl");

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "next";

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function positional(): string | undefined {
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) { i += 1; continue; }
    return argv[i];
  }
  return undefined;
}

const tasks = readJsonl<Task>(BACKLOG);
const events = readJsonl<JournalEvent>(JOURNAL);
const lessons = readJsonl<Lesson>(LESSONS);
const status = foldStatus(tasks, events);
const now = new Date().toISOString();

function requireTask(): Task {
  const id = positional();
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    console.error(`未找到任务 ${id ?? "(缺少 id)"}；可用 npm run auto:status 查看`);
    process.exit(2);
  }
  return task;
}

function record(e: Omit<JournalEvent, "at">): void {
  appendJsonl(JOURNAL, { at: now, ...e });
}

switch (cmd) {
  case "next": {
    const task = nextTask(tasks, status);
    if (!task) {
      console.log("✓ 没有可推进任务（全部完成或全部阻塞）。");
      for (const t of blockedBy(tasks, status)) console.log(`  ⏸ ${t.id} ${t.title}`);
      process.exit(0);
    }
    const fails = foldFailures(events).get(task.id) ?? 0;
    console.log(`── ${task.id} · ${task.title}`);
    console.log(`   战役 ${task.battle} · LOC 预算 ${task.loc} · 依赖 ${task.deps.join(",") || "无"}${fails ? ` · 已失败 ${fails} 次` : ""}`);
    console.log(`   验收 ${task.accept}`);
    const hits = matchLessons(lessons, task);
    if (hits.length) {
      console.log(`   教训（${hits.length} 条，来自历史账本）`);
      for (const l of hits) console.log(`     ⚠ ${l.trigger}\n       → ${l.action}（依据 ${l.evidence}，置信 ${l.confidence}）`);
    } else {
      console.log("   教训：无命中（首次处理该类任务）");
    }
    if (status.get(task.id) !== "doing") record({ id: task.id, event: "start" });
    break;
  }
  case "status": {
    const rows = battleProgress(tasks, status);
    console.log("战役   进度      阻塞");
    for (const r of rows) console.log(`${r.battle.padEnd(6)} ${`${r.done}/${r.total}`.padEnd(9)} ${r.blocked}`);
    const budget = JSON.parse(readFileSync(join(DIR, "budget.json"), "utf8")) as {
      battles: Record<string, number>;
    };
    const totalBudget = Object.values(budget.battles).reduce((a, b) => a + b, 0);
    console.log(`\n已用 LOC（done 合计）: ${foldLoc(events)} / ${totalBudget}（战役预算合计）`);
    const hardBlocked = tasks.filter((t) => status.get(t.id) === "blocked");
    const waiting = tasks.filter(
      (t) => status.get(t.id) === "todo" && !t.deps.every((d) => status.get(d) === "done"),
    );
    console.log(`阻塞 ${hardBlocked.length} · 待前置 ${waiting.length}（前置完成后自动解除，非异常）`);
    if (hardBlocked.length) {
      console.log("\n已阻塞（需人工决定）:");
      for (const t of hardBlocked) console.log(`  ⏸ ${t.id} ${t.title}`);
    }
    const next = nextTask(tasks, status);
    console.log(`\n下一个: ${next ? `${next.id} ${next.title}` : "无"}`);
    break;
  }
  case "done": {
    const task = requireTask();
    const loc = Number(flag("loc") ?? task.loc);
    record({ id: task.id, event: "done", evidence: flag("evidence") ?? "uncommitted", loc, note: flag("note") });
    console.log(`✓ ${task.id} 完成 · 记 ${loc} 行 · 证据 ${flag("evidence") ?? "uncommitted"}`);
    break;
  }
  case "fail": {
    const task = requireTask();
    const reason = flag("reason");
    if (!reason) {
      console.error("fail 必须提供 --reason（失败原因要可复核，不接受空泛描述）");
      process.exit(2);
    }
    record({ id: task.id, event: "fail", reason });
    const action = flag("lesson-action");
    if (action) {
      appendJsonl(LESSONS, {
        at: now, scope: "engineering", trigger: task.title, action, evidence: `journal:${task.id}`, confidence: 1,
      });
      console.log(`✗ ${task.id} 失败已记账，并沉淀 1 条教训`);
    } else {
      console.log(`✗ ${task.id} 失败已记账（未沉淀教训；若原因可复用请补 --lesson-action）`);
    }
    break;
  }
  case "block": {
    const task = requireTask();
    record({ id: task.id, event: "block", reason: flag("reason") ?? "未说明" });
    console.log(`⏸ ${task.id} 已阻塞`);
    break;
  }
  case "unblock": {
    const task = requireTask();
    record({ id: task.id, event: "unblock" });
    console.log(`▶ ${task.id} 已解除阻塞`);
    break;
  }
  default:
    console.error(`未知命令 ${cmd}；可用 next / status / done / fail / block / unblock`);
    process.exit(2);
}
