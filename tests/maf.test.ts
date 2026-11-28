import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Foundry, type MafCase, type Suite } from "../src/maf/foundry.ts";

function scenario(f: Foundry, perSuite = 16) {
  const make = (suite: Suite): MafCase[] => Array.from({ length: perSuite }, (_, i) => i % 2 === 0
    ? { id: `${suite}-${i}`, input: `  Hello${i};  `, expected: `Hello${i};` }
    : { id: `${suite}-${i}`, input: `Hello${i}`, expected: `Hello${i};` });
  return f.createScenario({ name: "代码格式修复", domain: "programming", cases: { visible: make("visible"), hidden: make("hidden"), replay: make("replay"), shadow: make("shadow") }, permissions: ["read"] });
}
function chain(f: Foundry) {
  const s = scenario(f), root = f.createAgent({ scenarioId: s.id, blocks: ["identity"], reason: "冻结通用基线", permissions: ["read"] });
  const trim = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: root.version, blocks: ["trim"], reason: "失效定位：首尾空白", permissions: ["read"] });
  return { s, root, trim };
}

test("MAF 四类可执行评测、配对统计、发布与完整快照回滚", async () => {
  const f = new Foundry(mkdtempSync(join(tmpdir(), "maf-"))), { s, root, trim } = chain(f);
  const r1 = await f.evaluate(trim.agentId, trim.version);
  assert.equal(r1.pairs.length, 64); assert.equal(r1.power, "sufficient"); assert.equal(r1.decision, "active-eligible"); assert.ok(r1.ci95[0] > 0);
  assert.equal(r1.verifier, "exact-output-v1"); assert.equal(r1.runnerCalls, 0);
  f.publish(trim.agentId, trim.version, "owner");
  const semi = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: trim.version, blocks: ["semicolon"], reason: "补齐缺失分号", permissions: ["read"] });
  const r2 = await f.evaluate(semi.agentId, semi.version); assert.equal(r2.decision, "active-eligible");
  f.publish(semi.agentId, semi.version, "owner");
  const restored = f.rollback(root.agentId, trim.version, "owner");
  assert.equal(restored.snapshotHash, trim.snapshotHash); assert.equal(f.list().releases[root.agentId], trim.version);
  assert.ok(f.auditTrail().some((a) => a.action === "agent.rollback" && a.refs.snapshotHash === trim.snapshotHash));
  const persisted = JSON.parse(readFileSync(join(f.dir, "agents", root.agentId, `${trim.version}.json`), "utf8"));
  assert.equal(persisted.snapshotHash, trim.snapshotHash); assert.equal(persisted.status, "active");
});

test("MAF 小样本只能影子，退化、越权与隐藏集泄漏被拒绝", async () => {
  const f = new Foundry(mkdtempSync(join(tmpdir(), "maf-"))), s = scenario(f, 1);
  const root = f.createAgent({ scenarioId: s.id, blocks: ["identity"], reason: "基线" });
  const candidate = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: root.version, blocks: ["semicolon"], reason: "测试" });
  const report = await f.evaluate(root.agentId, candidate.version);
  assert.equal(report.power, "insufficient"); assert.equal(report.decision, "shadow-eligible");
  assert.throws(() => f.publish(root.agentId, candidate.version, "owner"), /门禁/);
  assert.equal(f.publish(root.agentId, candidate.version, "owner", true).status, "active");
  const bad = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: candidate.version, blocks: ["lower"], reason: "故意制造大小写回归" });
  assert.equal((await f.evaluate(root.agentId, bad.version)).decision, "rejected");
  assert.throws(() => f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: candidate.version, blocks: ["identity"], permissions: ["write"], reason: "越权" }), /扩权/);
  assert.throws(() => f.createAgent({ scenarioId: s.id, blocks: ["agent-concise"], reason: "把 agent Block 塞进 DSL 场景" }), /只接受 dsl Block/);
  const view = f.scenario(s.id) as { cases: Record<string, number> };
  assert.equal(typeof view.cases.hidden, "number"); assert.equal(JSON.stringify(view).includes("Hello"), false);
  const block = f.distill(root.agentId, candidate.version, "owner"); assert.equal(block.status, "shadow"); assert.equal(block.kind, "dsl"); assert.ok(block.evidenceRefs.length > 0);
});

test("共享能力必须经独立专项迁移与全局回归双门禁", async () => {
  const f = new Foundry(mkdtempSync(join(tmpdir(), "maf-dual-")));
  const make = async (name: string) => {
    const s = scenario(f); s.name = name;
    const root = f.createAgent({ scenarioId: s.id, blocks: ["identity"], reason: "基线", permissions: ["read"] });
    const c = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: root.version, blocks: ["semicolon"], reason: "专项修复", permissions: ["read"] });
    return f.evaluate(c.agentId, c.version);
  };
  const r1 = await make("source"), r2 = await make("transfer"), r3 = await make("global"), src = f.distill(r1.agentId, r1.version, "owner");
  assert.equal(src.status, "shadow");
  assert.equal(f.promoteBlock(src.id, r1.id, r1.id, "owner").status, "rejected");
  const src2 = f.distill(r2.agentId, r2.version, "owner");
  assert.equal(f.promoteBlock(src2.id, r1.id, r3.id, "owner").status, "active");
  assert.ok(f.auditTrail().some((a) => a.action === "capability.promote"));
});
test("MAF 缺场景变量、判分或超预算时 fail-closed", () => {
  const f = new Foundry(mkdtempSync(join(tmpdir(), "maf-")));
  assert.throws(() => f.createScenario({ name: "", domain: "programming", cases: {} as never }), /不能为空/);
  const valid = scenario(f, 1);
  assert.throws(() => f.createScenario({ name: "超额", domain: "programming", cases: (f.scenario(valid.id, true) as never as { cases: Record<Suite, MafCase[]> }).cases, budget: { maxMs: 600001, concurrency: 2, maxRepairs: 3 } }), /冻结预算/);
  assert.throws(() => f.createScenario({ name: "无 runner", domain: "x", verifier: "agent-output-v1", cases: (f.scenario(valid.id, true) as never as { cases: Record<Suite, MafCase[]> }).cases }), /runner/);
});

const agentCases = (n: number): Record<Suite, MafCase[]> => Object.fromEntries((["visible", "hidden", "replay", "shadow"] as Suite[]).map((s) => [s, Array.from({ length: n }, (_, i) => ({ id: `${s}-${i}`, input: `q${i}`, expected: "A" }))])) as Record<Suite, MafCase[]>;

test("agent-output-v1：基线与候选各真跑一次 runner，无 runner / 超预算 / 执行失败均不冒充", async () => {
  const calls: Array<{ genome: string[]; input: string; blocks: string[] }> = [];
  let mode: "pass" | "fail" | "hang" = "pass";
  const f = new Foundry(mkdtempSync(join(tmpdir(), "maf-agent-")), async ({ genome, blocks, input, signal }) => {
    calls.push({ genome: genome.blocks, input, blocks: blocks.map((b) => b.id) });
    if (mode === "fail") throw new Error("provider down");
    if (mode === "hang") await new Promise((_, rej) => { signal.addEventListener("abort", () => rej(new Error("aborted"))); });
    return genome.blocks.includes("agent-concise") ? " A " : "B";
  });
  const s = f.createScenario({ name: "真实 Agent", domain: "support", verifier: "agent-output-v1", cases: agentCases(2), permissions: ["read"], budget: { maxMs: 2000, concurrency: 2, maxRepairs: 3 } });
  const root = f.createAgent({ scenarioId: s.id, blocks: ["identity"], reason: "基线" });
  const cand = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: root.version, blocks: ["agent-concise", "trim"], reason: "加提示片段 + 输出后处理" });
  const r = await f.evaluate(root.agentId, cand.version);
  assert.equal(calls.length, 16, "8 用例 × (基线+候选) 各跑一次");
  assert.equal(r.verifier, "agent-output-v1"); assert.equal(r.runnerCalls, 16);
  assert.ok(calls.every((c) => c.blocks.length > 0 && c.input.startsWith("q")));
  assert.equal(r.delta, 1, "候选 A+trim=A 命中，基线 B 未命中");
  assert.equal(r.decision, "shadow-eligible", "样本不足 64 仍只能影子");
  mode = "fail"; calls.length = 0;
  const bad = await f.evaluate(root.agentId, cand.version);
  assert.equal(bad.pairs.filter((p) => p.status === "error").length, 8); assert.ok(bad.pairs.every((p) => p.error === "provider down"));
  mode = "hang";
  const t0 = Date.now(); const slow = await f.evaluate(root.agentId, cand.version);
  assert.equal(slow.decision, "rejected"); assert.ok(slow.reasons.some((x) => x.includes("预算") || x.includes("效应量")));
  assert.ok(Date.now() - t0 < 4000, "单次调用受 maxMs/（用例×2）约束被中止，而不是挂死");
  assert.ok(slow.pairs.some((p) => p.error === "aborted"));
  assert.equal((await f.evaluate(root.agentId, cand.version)).runnerCalls, 16, "超预算后仍记录真实调用次数");
  const tight = f.createScenario({ name: "紧预算", domain: "support", verifier: "agent-output-v1", cases: agentCases(2), budget: { maxMs: 5, concurrency: 1, maxRepairs: 3 } });
  const r0 = f.createAgent({ scenarioId: tight.id, blocks: ["identity"], reason: "基线" }), r1 = f.createAgent({ scenarioId: tight.id, agentId: r0.agentId, parentVersion: r0.version, blocks: ["agent-concise"], reason: "候选" });
  const blown = await f.evaluate(r0.agentId, r1.version);
  assert.ok(blown.reasons.includes("超出单候选时间预算"), "预算耗尽后未执行的用例不得计分，整体拒绝");
  assert.ok(blown.pairs.some((p) => p.error === "超出时间预算，未执行"));
});

test("agent Block 蒸馏保留提示片段与工具白名单；多实例审计 seq 唯一、损坏 fail-closed、回滚只认曾发布版本", async () => {
  const root = mkdtempSync(join(tmpdir(), "maf-lock-"));
  const f = new Foundry(root, async ({ genome }) => (genome.blocks.includes("agent-plan-first") ? " A" : "B"));
  const s = f.createScenario({ name: "N", domain: "support", verifier: "agent-output-v1", cases: agentCases(2), permissions: ["read"], budget: { maxMs: 3000, concurrency: 2, maxRepairs: 3 } });
  const base = f.createAgent({ scenarioId: s.id, blocks: ["identity"], reason: "基线" });
  const c = f.createAgent({ scenarioId: s.id, agentId: base.agentId, parentVersion: base.version, blocks: ["agent-plan-first", "agent-files", "trim"], tools: ["calc"], reason: "规划 + 文件工具" });
  await f.evaluate(base.agentId, c.version);
  const block = f.distill(base.agentId, c.version, "owner");
  assert.equal(block.kind, "agent"); assert.ok(block.prompt!.includes("todo_write")); assert.deepEqual([...block.tools!].sort(), ["calc", "file_edit", "file_list", "file_read", "file_write"]);
  f.publish(base.agentId, c.version, "owner", true);
  const draft = f.createAgent({ scenarioId: s.id, agentId: base.agentId, parentVersion: c.version, blocks: ["identity"], reason: "从未评测发布" });
  assert.throws(() => f.rollback(base.agentId, draft.version, "owner"), /曾通过发布门禁/);
  const other = new Foundry(root); other.createScenario({ name: "另一实例", domain: "ops", cases: agentCases(1) });
  const seqs = f.auditTrail().map((a) => a.seq);
  assert.equal(new Set(seqs).size, seqs.length); assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.equal((other.getAgent(base.agentId, c.version)!.status), "active", "另一实例无需重启即可看到发布");
  assert.equal(other.release(base.agentId), c.version, "releases.json 不被陈旧内存覆盖");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(f.dir, "blocks.json"), "{half-written");
  assert.throws(() => new Foundry(root), /损坏/);
});
