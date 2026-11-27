/**
 * 多实例编排验证：不模拟并发，全部用真实 spawn 的独立 Node 进程共享同一磁盘账本。
 * 覆盖：竞争不重复执行 / fencing 拒绝陈旧提交 / 过期租约恢复 / 跨进程事件与因果字段 /
 * 协作式取消的提交点边界 / 账本重放确定性 / 损坏行 fail-closed / 陈旧锁抢占。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Orchestrator } from "../src/maf/orchestrator.ts";

const SRC = pathToFileURL(fileURLToPath(new URL("../src/maf/orchestrator.ts", import.meta.url))).href;
const WORKER = `
import { Orchestrator } from ${JSON.stringify(SRC)};
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.MAF_ROOT, taskId = process.env.MAF_TASK, tag = process.env.MAF_TAG;
const o = new Orchestrator(root, async (n) => {
  appendFileSync(join(root, "data", "maf", "calls.jsonl"), JSON.stringify({ tag, node: n.id, at: Date.now() }) + "\\n");
  if (process.env.MAF_BLOCK === "1") {
    const end = Date.now() + Number(process.env.MAF_BLOCK_MS || 300);
    while (Date.now() < end) {}
  } else await new Promise((r) => setTimeout(r, Number(process.env.MAF_SLEEP || 20)));
  return "ok:" + n.id;
}, Number(process.env.MAF_LEASE || 30000));
const done = await o.run(taskId);
process.stdout.write(JSON.stringify({ tag, status: done.status }));
`;

function worker(root: string, taskId: string, tag: string, extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", WORKER], {
      env: { ...process.env, MAF_ROOT: root, MAF_TASK: taskId, MAF_TAG: tag, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}
const callsOf = (root: string): Array<{ tag: string; node: string; at: number }> => readFileSync(join(root, "data", "maf", "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tag: string; node: string; at: number });
/** CI 慢机器上进程启动时间不可假设：轮询共享账本直到观察到 claim，而不是固定 sleep。 */
const waitForClaim = async (root: string, taskId: string, timeoutMs = 15000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = readFileSync(join(root, "data", "maf", "cluster.jsonl"), "utf8").split("\n").filter(Boolean).some((l) => {
      try { const r = JSON.parse(l) as { op: string; taskId?: string }; return r.op === "claim" && r.taskId === taskId; } catch { return false; }
    });
    if (hit) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等待 worker 领取租约超时：共享账本中未观察到 claim");
};
type ClusterView = { seq: number; workers: Array<{ id: string; alive: boolean; self: boolean }>; rejects: Array<{ seq: number; by: string; op: string; detail: string }>; events: Array<{ seq: number; instanceId: string; runId?: string; correlationId?: string }>; honest: string; instanceId: string };

test("两个真实进程竞争同一 DAG：节点恰好执行一次，账本可串行化", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-cluster-"));
  const seed = new Orchestrator(root, async () => "seed");
  const t = seed.submit({ name: "多实例竞争", nodes: [{ id: "a", task: "A" }, { id: "b", task: "B" }, { id: "c", task: "C", deps: ["a", "b"] }, { id: "d", task: "D", deps: ["c"] }] });
  const [r1, r2] = await Promise.all([worker(root, t.id, "w1", { MAF_SLEEP: "30" }), worker(root, t.id, "w2", { MAF_SLEEP: "30" })]);
  assert.equal(r1.code, 0, `w1 失败: ${r1.err}`); assert.equal(r2.code, 0, `w2 失败: ${r2.err}`);
  const calls = callsOf(root);
  for (const id of ["a", "b", "c", "d"]) assert.equal(calls.filter((c) => c.node === id).length, 1, `节点 ${id} 被重复执行: ${JSON.stringify(calls)}`);
  const view = new Orchestrator(root, async () => "view"), done = view.get(t.id)!;
  assert.equal(done.status, "succeeded"); assert.ok(done.nodes.every((n) => n.status === "succeeded"));
  const c = view.cluster() as unknown as ClusterView;
  assert.ok(c.seq > 0); assert.ok(c.workers.filter((w) => w.alive).length >= 3, "seed + 两个 worker + 观察者应同处一个成员视图");
  assert.ok(c.events.length >= 4, "两个进程的事件必须落在同一共享账本");
  assert.ok(new Set(c.events.map((e) => e.seq)).size === c.events.length, "事件 seq 必须全局唯一");
  assert.ok(c.honest.includes("不宣称"));
  rmSync(root, { recursive: true, force: true });
});

test("冻结进程租约过期被接管，陈旧提交被 fencing 拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-fence-"));
  const seed = new Orchestrator(root, async () => "seed");
  const t = seed.submit({ name: "fencing", nodes: [{ id: "a", task: "A", maxAttempts: 3 }] });
  const frozen = worker(root, t.id, "frozen", { MAF_BLOCK: "1", MAF_BLOCK_MS: "2500", MAF_LEASE: "60" });
  await waitForClaim(root, t.id);
  await new Promise((r) => setTimeout(r, 140));
  const takeover = await worker(root, t.id, "takeover", { MAF_SLEEP: "10", MAF_LEASE: "60" });
  assert.equal(takeover.code, 0, takeover.err);
  const stale = await frozen; assert.equal(stale.code, 0, stale.err);
  const view = new Orchestrator(root, async () => "view"), c = view.cluster() as unknown as ClusterView;
  assert.ok(c.rejects.some((r) => r.detail.includes("fencing")), `陈旧提交必须被 fencing 拒绝: ${JSON.stringify(c.rejects)}`);
  assert.ok(view.audit().some((a) => a.action === "lease.recover"));
  const done = view.get(t.id)!; assert.equal(done.status, "succeeded"); assert.equal(done.nodes[0].result, "ok:a");
  rmSync(root, { recursive: true, force: true });
});

test("跨进程取消在提交点生效，已取消任务不再接受提交", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-cancel-cluster-"));
  const seed = new Orchestrator(root, async () => "seed");
  const t = seed.submit({ name: "跨实例取消", nodes: [{ id: "a", task: "A" }] });
  const running = worker(root, t.id, "runner", { MAF_SLEEP: "180" });
  await waitForClaim(root, t.id);
  const observer = new Orchestrator(root, async () => "observer");
  assert.equal(observer.cancel(t.id).status, "cancelled");
  const r = await running; assert.equal(r.code, 0, r.err);
  const c = observer.cluster() as unknown as ClusterView;
  assert.equal(observer.get(t.id)!.status, "cancelled");
  assert.ok(c.rejects.length >= 1, "被取消任务的迟到提交必须被拒绝，而不是覆盖状态");
  rmSync(root, { recursive: true, force: true });
});

test("账本重放确定性、损坏行 fail-closed、陈旧锁可抢占", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-replay-"));
  const one = new Orchestrator(root, async () => "x"), t = one.submit({ name: "重放", nodes: [{ id: "a", task: "A" }] });
  const ledger = join(root, "data", "maf", "cluster.jsonl");
  const lines = readFileSync(ledger, "utf8").trim().split("\n");
  const submitSeq = (lines.map((l) => JSON.parse(l) as { seq: number; op: string })).find((r) => r.op === "task.submit")!.seq;
  const expired = { seq: lines.length, ts: new Date(Date.now() - 5000).toISOString(), by: "dead-worker", op: "claim", taskId: t.id, nodeId: "a", token: "dead-token", leaseUntil: new Date(Date.now() - 4000).toISOString(), baseSeq: submitSeq };
  appendFileSync(ledger, `${JSON.stringify(expired)}\n`);
  const two = new Orchestrator(root, async () => "x");
  assert.equal(two.get(t.id)!.nodes[0].status, "pending", "过期租约必须在重放时被恢复");
  assert.ok(two.audit().some((a) => a.action === "lease.recover"));
  const three = new Orchestrator(root, async () => "x");
  assert.equal(JSON.stringify(three.get(t.id)), JSON.stringify(two.get(t.id)), "同一账本在不同进程重放必须完全一致");
  appendFileSync(ledger, "{ 这不是合法 JSON\n");
  assert.throws(() => new Orchestrator(root, async () => "y"), /损坏/, "账本损坏必须 fail-closed，禁止静默重建");
  writeFileSync(ledger, `${lines.join("\n")}\n${JSON.stringify(expired)}\n`);
  const lockDir = join(root, "data", "maf", "cluster.lock");
  rmSync(lockDir, { recursive: true, force: true }); mkdirSync(lockDir); writeFileSync(join(lockDir, "owner"), "dead:0");
  const old = new Date(Date.now() - 10000); utimesSync(lockDir, old, old);
  const four = new Orchestrator(root, async () => "z");
  assert.ok(four.seq() > 0, "陈旧锁必须可被抢占，不能永久阻塞集群");
  rmSync(root, { recursive: true, force: true });
});
