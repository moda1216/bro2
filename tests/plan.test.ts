/**
 * 计划账本与调度器的纯逻辑测试。
 * 只测纯函数：IO 层（readJsonl/appendJsonl）由真实运行验证，避免测试污染仓库账本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldFailures, foldLoc, foldStatus } from "../src/plan/backlog.ts";
import type { JournalEvent, Lesson, Task } from "../src/plan/backlog.ts";
import { battleProgress, blockedBy, matchLessons, nextTask } from "../src/plan/select.ts";

const task = (id: string, deps: string[] = [], battle = id.slice(0, 2)): Task => ({
  id, battle, title: `任务 ${id}`, accept: "通过", loc: 10, deps,
});

const ev = (id: string, event: JournalEvent["event"], extra: Partial<JournalEvent> = {}): JournalEvent => ({
  at: "2026-11-08T00:00:00Z", id, event, ...extra,
});

test("foldStatus：start→doing，done 为终态，后续事件不得回退", () => {
  const s = foldStatus([task("W1-01")], [ev("W1-01", "start"), ev("W1-01", "done"), ev("W1-01", "fail")]);
  assert.equal(s.get("W1-01"), "done");
});

test("foldStatus：fail 回到 todo 可重试，block 为终态，unblock 才解除", () => {
  const s1 = foldStatus([task("A")], [ev("A", "start"), ev("A", "fail")]);
  assert.equal(s1.get("A"), "todo");

  const s2 = foldStatus([task("B")], [ev("B", "block")]);
  assert.equal(s2.get("B"), "blocked");
  const s3 = foldStatus([task("B")], [ev("B", "block"), ev("B", "start")]);
  assert.equal(s3.get("B"), "blocked", "start 不得绕过阻塞");
  const s4 = foldStatus([task("B")], [ev("B", "block"), ev("B", "unblock")]);
  assert.equal(s4.get("B"), "todo");
});

test("foldStatus：未知任务的事件被忽略，不产生幽灵条目", () => {
  const s = foldStatus([task("A")], [ev("ZZZ", "done")]);
  assert.equal(s.has("ZZZ"), false);
  assert.equal(s.get("A"), "todo");
});

test("foldLoc：只累计 done 的 loc，fail 不计入", () => {
  const events = [ev("A", "done", { loc: 120 }), ev("B", "fail", { loc: 50 }), ev("C", "done", { loc: 30 })];
  assert.equal(foldLoc(events), 150);
});

test("foldFailures：按任务统计失败次数", () => {
  const f = foldFailures([ev("A", "fail"), ev("A", "fail"), ev("B", "fail")]);
  assert.equal(f.get("A"), 2);
  assert.equal(f.get("B"), 1);
});

test("nextTask：跳过依赖未完成的任务，按 id 升序返回", () => {
  const tasks = [task("W1-01"), task("W1-02", ["W1-01"]), task("W1-03", ["W1-02"])];
  const s = foldStatus(tasks, []);
  assert.equal(nextTask(tasks, s)?.id, "W1-01");

  const s2 = foldStatus(tasks, [ev("W1-01", "done")]);
  assert.equal(nextTask(tasks, s2)?.id, "W1-02");
});

test("nextTask：全部完成或全部阻塞时返回 null，不擅自降级选择", () => {
  const tasks = [task("A"), task("B")];
  assert.equal(nextTask(tasks, foldStatus(tasks, [ev("A", "done"), ev("B", "done")])), null);
  assert.equal(nextTask(tasks, foldStatus(tasks, [ev("A", "block"), ev("B", "block")])), null);
});

test("nextTask：重复调用不会重复选已 in-progress 的任务", () => {
  const tasks = [task("A")];
  const s = foldStatus(tasks, [ev("A", "start")]);
  assert.equal(s.get("A"), "doing");
  assert.equal(nextTask(tasks, s), null);
});

test("blockedBy：只报告真正不可执行的项（阻塞或依赖未满足）", () => {
  const tasks = [task("A"), task("B", ["A"]), task("C")];
  const s = foldStatus(tasks, [ev("C", "done")]);
  const ids = blockedBy(tasks, s).map((t) => t.id);
  assert.deepEqual(ids, ["B"], "A 可执行不应列入；C 已完成不应列入");
});

test("matchLessons：命中同类任务，置信为 0 的教训失效", () => {
  const lessons: Lesson[] = [
    { at: "", scope: "engineering", trigger: "编辑降级链与自动重试", action: "先备份缩进", evidence: "j:1", confidence: 2 },
    { at: "", scope: "engineering", trigger: "编辑降级链与自动重试", action: "旧结论已失效", evidence: "j:2", confidence: 0 },
  ];
  const t: Task = { id: "W2-04", battle: "W2", title: "编辑降级链与自动重试", accept: "四段分支断言", loc: 150, deps: [] };
  const hits = matchLessons(lessons, t);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].action, "先备份缩进");
});

test("matchLessons：不相关任务不命中，避免噪声提示", () => {
  const lessons: Lesson[] = [
    { at: "", scope: "engineering", trigger: "Docker 容器网络配置", action: "用 host 模式", evidence: "j:1", confidence: 3 },
  ];
  const t: Task = { id: "W1-03", battle: "W1", title: "写首批 18 个 L2 真实工程任务", accept: "通过率 20%-70%", loc: 120, deps: [] };
  assert.deepEqual(matchLessons(lessons, t), []);
});

test("battleProgress：按战役统计，保持出现顺序", () => {
  const tasks = [task("W1-01"), task("W1-02"), task("W2-01")];
  const s = foldStatus(tasks, [ev("W1-01", "done"), ev("W2-01", "block")]);
  const rows = battleProgress(tasks, s);
  assert.deepEqual(rows, [
    { battle: "W1", total: 2, done: 1, blocked: 0 },
    { battle: "W2", total: 1, done: 0, blocked: 1 },
  ]);
});
