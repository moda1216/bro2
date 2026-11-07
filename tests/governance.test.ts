import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionPolicy } from "../src/governance/permissions.ts";
import { Guards, newGuardState } from "../src/governance/guards.ts";
import { ApprovalManager, ApprovalDecision } from "../src/governance/approval.ts";
import { redact, redactObject } from "../src/governance/audit.ts";
import { BudgetManager } from "../src/context/budget.ts";
import { EventBus, Role } from "../src/kernel/events.ts";
import type { Event, EventDraft, Message } from "../src/kernel/events.ts";
import { defineTool, RiskLevel } from "../src/tools/registry.ts";
import type { ToolDef } from "../src/tools/registry.ts";

const pathTool = (risk: RiskLevel = RiskLevel.Safe): ToolDef =>
  defineTool({
    name: "file_read", description: "", risk, pathArgs: ["path"],
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: () => "",
  });

test("权限层硬拦截路径逃逸（.. 与绝对路径越界）", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentos-perm-"));
  try {
    const ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    const policy = new PermissionPolicy({ level: "workspace-write", workspace: ws, allowedPaths: [ws], autoApproveSafe: true });
    const r1 = policy.check(pathTool(), { path: "../../etc/passwd" });
    assert.equal(r1.decision, "deny");
    assert.ok(r1.reason.includes("越界"));
    const r2 = policy.check(pathTool(), { path: "/etc/passwd" });
    assert.equal(r2.decision, "deny");
    const r3 = policy.check(pathTool(), { path: "sub/ok.txt" });
    assert.equal(r3.decision, "allow");
    assert.ok(policy.validatePath("sub/ok.txt").resolved.startsWith(ws));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("高危命令与 danger 工具按级别拒绝或触发审批", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentos-perm-"));
  try {
    const ws = join(dir, "ws");
    mkdirSync(ws);
    const policy = new PermissionPolicy({ level: "workspace-write", workspace: ws, allowedPaths: [ws] });
    const shellTool = defineTool({
      name: "shell", description: "", risk: RiskLevel.Write,
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      handler: () => "",
    });
    assert.equal(policy.check(shellTool, { command: "rm -rf /" }).decision, "deny");
    assert.equal(policy.check(shellTool, { command: "echo hello" }).decision, "allow");
    assert.equal(policy.check(pathTool(RiskLevel.Danger), { path: "a.txt" }).decision, "ask");

    const ro = new PermissionPolicy({ level: "read-only", workspace: ws, allowedPaths: [ws] });
    assert.equal(ro.check(pathTool(RiskLevel.Write), { path: "a.txt" }).decision, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Guards 检测步数 / token 上限与连续重复调用死循环", () => {
  const g = new Guards({ maxSteps: 3, maxTokens: 100, maxSeconds: 60, loopDetectionThreshold: 3 });
  const state = newGuardState(1);
  assert.equal(g.check(state).ok, true);
  state.steps = 3;
  assert.equal(g.check(state).kind, "steps");
  state.steps = 0;
  state.totalTokens = 100;
  assert.equal(g.check(state).kind, "tokens");

  const s2 = newGuardState(1);
  const call = { id: "c", name: "calc", arguments: { expression: "1+1" } };
  assert.equal(g.recordToolCalls(s2, [call]).ok, true);
  assert.equal(g.recordToolCalls(s2, [call]).ok, true);
  const third = g.recordToolCalls(s2, [call]);
  assert.equal(third.ok, false);
  assert.equal(third.kind, "loop");
});

test("审批队列：同步 resolve 能命中（pending 先登记再通知）", async () => {
  const bus = new EventBus();
  const drafts: EventDraft[] = [];
  const record = (d: EventDraft): Event => {
    drafts.push(d);
    return { ...d, seq: drafts.length, ts: new Date().toISOString() };
  };
  const am = new ApprovalManager({ bus, record, autoApprove: false, timeoutMs: 1000 });
  am.onRequest((req) => {
    assert.equal(am.resolve(req.id, ApprovalDecision.Deny), true);
  });
  const decision = await am.request({ sessionId: "s", turn: 1, step: 0, toolName: "file_delete", arguments: { path: "x.txt" }, reason: "危险" });
  assert.equal(decision, ApprovalDecision.Deny);
  assert.equal(am.list().length, 0);
  assert.ok(drafts.some((d) => d.type === "approval.resolved"));
});

test("审批支持本会话始终允许", async () => {
  const bus = new EventBus();
  let n = 0;
  const record = (d: EventDraft): Event => ({ ...d, seq: ++n, ts: new Date().toISOString() });
  const am = new ApprovalManager({ bus, record, autoApprove: false });
  am.onRequest((req) => am.resolve(req.id, ApprovalDecision.Always));
  const d1 = await am.request({ sessionId: "s", turn: 1, step: 0, toolName: "shell", arguments: {}, reason: "危险" });
  assert.equal(d1, ApprovalDecision.Always);
  const d2 = await am.request({ sessionId: "s", turn: 1, step: 1, toolName: "shell", arguments: {}, reason: "危险" });
  assert.equal(d2, ApprovalDecision.Approve);
});

test("日志脱敏：密钥与敏感字段不进明文日志", () => {
  assert.ok(redact("Authorization: Bearer sk-abcdefghijklmnop").includes("REDACTED"));
  const obj = redactObject({ apiKey: "secret123", nested: { password: "p@ss" }, safe: "ok" }) as Record<string, unknown>;
  assert.equal(obj.apiKey, "***REDACTED***");
  assert.equal((obj.nested as Record<string, unknown>).password, "***REDACTED***");
  assert.equal(obj.safe, "ok");
});

test("上下文压缩保持 assistant(tool_calls) 与 tool 消息配对", () => {
  const bm = new BudgetManager(40, 4);
  const messages: Message[] = [
    { role: Role.User, content: "任务" },
    { role: Role.Assistant, content: "", toolCalls: [{ id: "c1", name: "calc", arguments: {} }] },
    { role: Role.Tool, content: "1", toolCallId: "c1", name: "calc" },
    { role: Role.User, content: "继续" },
    { role: Role.Assistant, content: "", toolCalls: [{ id: "c2", name: "calc", arguments: {} }] },
    { role: Role.Tool, content: "2", toolCallId: "c2", name: "calc" },
    { role: Role.User, content: "再继续" },
    { role: Role.Assistant, content: "中间结论" },
    { role: Role.User, content: "最后" },
  ];
  const r = bm.compact(messages, undefined, "系统提示".repeat(20));
  assert.equal(r.compacted, true);
  assert.ok(r.removed > 0);
  assert.notEqual(r.messages[0]!.role, Role.Tool, "不能留下孤儿 tool 消息");
  assert.ok(r.summary?.includes("历史压缩"));
});
