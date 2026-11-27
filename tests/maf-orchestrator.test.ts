import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/maf/orchestrator.ts";

test("持久 DAG 依赖、并发上限、幂等重放与审计", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-dag-")); let active = 0, peak = 0; const calls: string[] = [];
  const o = new Orchestrator(root, async (n) => { calls.push(n.id); active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return `ok:${n.task}`; });
  const t = o.submit({ name: "测试DAG", nodes: [{ id: "a", task: "A" }, { id: "b", task: "B" }, { id: "c", task: "C", deps: ["a", "b"] }] });
  const done = await o.run(t.id); assert.equal(done.status, "succeeded"); assert.equal(peak <= 2, true); assert.equal(calls.at(-1), "c");
  await o.run(t.id); assert.equal(calls.length, 3); assert.equal(o.audit().filter((a) => a.action === "node.commit").length, 3);
});

test("进程崩溃后过期租约恢复，已提交副作用不重复", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-recover-")); let executions = 0;
  const executor = async (n: { id: string }): Promise<string> => { executions += 1; return `done:${n.id}`; };
  const one = new Orchestrator(root, executor, 5), t = one.submit({ name: "故障恢复", nodes: [{ id: "a", task: "A" }, { id: "b", task: "B", deps: ["a"] }] });
  const path = join(root, "data", "maf", "orchestrator.json"), state = JSON.parse(readFileSync(path, "utf8"));
  state.commits["故障恢复:a"] = "done:a"; state.tasks[0].nodes[0].status = "succeeded"; state.tasks[0].nodes[0].result = "done:a";
  state.tasks[0].nodes[1].status = "running"; state.tasks[0].nodes[1].attempts = 1; state.tasks[0].nodes[1].leaseUntil = new Date(Date.now() - 1000).toISOString(); state.tasks[0].status = "running"; writeFileSync(path, JSON.stringify(state));
  const two = new Orchestrator(root, executor, 5), recovered = two.get(t.id)!;
  assert.equal(recovered.nodes[1].status, "pending"); assert.ok(two.audit().some((a) => a.action === "lease.recover"));
  const done = await two.run(t.id); assert.equal(done.status, "succeeded"); assert.equal(executions, 1); assert.equal(done.nodes[0].result, "done:a");
});

test("定时器自动领取到期 DAG，停止后不再触发", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-timer-")); let n = 0;
  const o = new Orchestrator(root, async () => { n += 1; return "ok"; });
  o.submit({ name: "周期任务", trigger: "interval", intervalMs: 1, nodes: [{ id: "a", task: "A" }] });
  o.start(10); await new Promise((r) => setTimeout(r, 1150)); o.stop();
  const after = n; await new Promise((r) => setTimeout(r, 80));
  assert.equal(after >= 1, true); assert.equal(n, after);
});
test("取消会传播 AbortSignal，循环依赖和未知依赖 fail-closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-cancel-"));
  const o = new Orchestrator(root, async (_n, ctx) => new Promise<string>((resolve, reject) => { ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))); setTimeout(() => resolve("late"), 100); }));
  const t = o.submit({ name: "取消", nodes: [{ id: "a", task: "A", maxAttempts: 1 }] });
  const running = o.run(t.id); o.cancel(t.id); const done = await running;
  assert.equal(done.status, "cancelled"); assert.equal(done.nodes[0].status, "cancelled");
  assert.throws(() => o.submit({ name: "环", nodes: [{ id: "a", task: "A", deps: ["b"] }, { id: "b", task: "B", deps: ["a"] }] }), /循环/);
  assert.throws(() => o.submit({ name: "未知", nodes: [{ id: "a", task: "A", deps: ["x"] }] }), /未知依赖/);
});
