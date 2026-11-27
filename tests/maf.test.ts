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

test("MAF 四类可执行评测、配对统计、发布与完整快照回滚", () => {
  const f = new Foundry(mkdtempSync(join(tmpdir(), "maf-"))), { s, root, trim } = chain(f);
  const r1 = f.evaluate(trim.agentId, trim.version);
  assert.equal(r1.pairs.length, 64); assert.equal(r1.power, "sufficient"); assert.equal(r1.decision, "active-eligible"); assert.ok(r1.ci95[0] > 0);
  f.publish(trim.agentId, trim.version, "owner");
  const semi = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: trim.version, blocks: ["semicolon"], reason: "补齐缺失分号", permissions: ["read"] });
  const r2 = f.evaluate(semi.agentId, semi.version); assert.equal(r2.decision, "active-eligible");
  f.publish(semi.agentId, semi.version, "owner");
  const restored = f.rollback(root.agentId, trim.version, "owner");
  assert.equal(restored.snapshotHash, trim.snapshotHash); assert.equal(f.list().releases[root.agentId], trim.version);
  assert.ok(f.auditTrail().some((a) => a.action === "agent.rollback" && a.refs.snapshotHash === trim.snapshotHash));
  const persisted = JSON.parse(readFileSync(join(f.dir, "agents", root.agentId, `${trim.version}.json`), "utf8"));
  assert.equal(persisted.snapshotHash, trim.snapshotHash);
});

test("MAF 小样本只能影子，退化、越权与隐藏集泄漏被拒绝", () => {
  const f = new Foundry(mkdtempSync(join(tmpdir(), "maf-"))), s = scenario(f, 1);
  const root = f.createAgent({ scenarioId: s.id, blocks: ["identity"], reason: "基线" });
  const candidate = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: root.version, blocks: ["semicolon"], reason: "测试" });
  const report = f.evaluate(root.agentId, candidate.version);
  assert.equal(report.power, "insufficient"); assert.equal(report.decision, "shadow-eligible");
  assert.throws(() => f.publish(root.agentId, candidate.version, "owner"), /门禁/);
  assert.equal(f.publish(root.agentId, candidate.version, "owner", true).status, "active");
  const bad = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: candidate.version, blocks: ["lower"], reason: "故意制造大小写回归" });
  assert.equal(f.evaluate(root.agentId, bad.version).decision, "rejected");
  assert.throws(() => f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: candidate.version, blocks: ["identity"], permissions: ["write"], reason: "越权" }), /扩权/);
  const view = f.scenario(s.id) as { cases: Record<string, number> };
  assert.equal(typeof view.cases.hidden, "number"); assert.equal(JSON.stringify(view).includes("Hello"), false);
  const block = f.distill(root.agentId, candidate.version, "owner"); assert.equal(block.status, "shadow"); assert.ok(block.evidenceRefs.length > 0);
});

test("共享能力必须经独立专项迁移与全局回归双门禁", () => {
  const f = new Foundry(mkdtempSync(join(tmpdir(), "maf-dual-")));
  const make = (name: string) => {
    const s = scenario(f); s.name = name;
    const root = f.createAgent({ scenarioId: s.id, blocks: ["identity"], reason: "基线", permissions: ["read"] });
    const c = f.createAgent({ scenarioId: s.id, agentId: root.agentId, parentVersion: root.version, blocks: ["semicolon"], reason: "专项修复", permissions: ["read"] });
    return f.evaluate(c.agentId, c.version);
  };
  const r1 = make("source"), r2 = make("transfer"), r3 = make("global"), src = f.distill(r1.agentId, r1.version, "owner");
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
});
