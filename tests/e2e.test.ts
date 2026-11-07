import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import type { AgentOS } from "../src/index.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";
import { MockProvider } from "../src/models/mock.ts";
import type { LLMProvider } from "../src/models/base.ts";
import { BUILTIN_PLUGINS } from "../src/tools/plugin.ts";
import { HookPoint } from "../src/kernel/hooks.ts";
import { EventType } from "../src/kernel/events.ts";
import { ApprovalDecision } from "../src/governance/approval.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type After = { after: (fn: () => void | Promise<void>) => void };

interface Ctx { os: AgentOS; tmp: string; ws: string }

function makeOS(
  t: After,
  opts: { autoApprove?: boolean; providerOverride?: LLMProvider; budget?: Record<string, number> } = {},
): Ctx {
  const tmp = mkdtempSync(join(tmpdir(), "agentos-e2e-"));
  const ws = join(tmp, "ws");
  const config: Record<string, unknown> = {
    storage: { dir: tmp },
    permission: { workspace: ws, allowedPaths: [ws] },
    ...(opts.budget ? { budget: opts.budget } : {}),
  };
  const os = createAgentOS({
    root: ROOT,
    autoApprove: opts.autoApprove ?? true,
    plugins: [],
    ...(opts.providerOverride ? { providerOverride: opts.providerOverride } : {}),
    config: config as unknown as Partial<RuntimeConfig>,
  });
  t.after(async () => {
    await os.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  });
  return { os, tmp, ws };
}

const usage = () => ({ inputTokens: 10, outputTokens: 10, totalTokens: 20 });

test("端到端：规划 → 真实写文件 → 终答，Trajectory 可恢复可分叉", async (t) => {
  const provider = new MockProvider({
    script: [
      { content: "先拆解任务", toolCalls: [{ name: "todo_write", arguments: { todos: [{ id: "1", content: "写入文件", status: "in_progress" }] } }] },
      { content: "执行写入", toolCalls: [{ name: "file_write", arguments: { path: "e2e.txt", content: "hello agent os" } }] },
      { content: "已完成，文件已落盘。", toolCalls: [] },
    ],
  });
  const { os, ws } = makeOS(t, { providerOverride: provider });
  const s = os.createSession("standard");
  const r = await os.run(s.id, "请把结果写入 e2e.txt");

  assert.equal(r.stoppedBy, "completed");
  assert.equal(r.toolCallCount, 2);
  assert.ok(r.usage.totalTokens > 0);
  assert.ok(existsSync(join(ws, "e2e.txt")));
  assert.equal(readFileSync(join(ws, "e2e.txt"), "utf8"), "hello agent os");

  const events = s.trajectory.events();
  for (const ty of [EventType.UserMessage, EventType.ToolCall, EventType.ToolResult, EventType.AssistantMessage, EventType.RunStart, EventType.RunEnd]) {
    assert.ok(events.some((e) => e.type === ty), `缺少事件 ${ty}`);
  }
  const msgs = s.messages();
  assert.equal(msgs[0]!.role, "user");
  assert.ok(msgs.some((m) => m.role === "tool"));
  assert.ok(msgs.some((m) => m.role === "assistant" && m.toolCalls));

  const child = os.sessions.fork(s.id);
  assert.ok(child);
  assert.equal(child!.messages().length, msgs.length);
  assert.equal(child!.meta.parentId, s.id);
  child!.close();
});

test("端到端：danger 工具触发 HITL 审批，用户拒绝后回喂模型且不落盘", async (t) => {
  const provider = new MockProvider({
    script: [
      { content: "准备删除", toolCalls: [{ name: "file_delete", arguments: { path: "x.txt" } }] },
      { content: "已按拒绝处理。", toolCalls: [] },
    ],
  });
  const { os, ws } = makeOS(t, { autoApprove: false, providerOverride: provider });
  writeFileSync(join(ws, "x.txt"), "keep me");
  os.approvals.onRequest((req) => { os.approvals.resolve(req.id, ApprovalDecision.Deny); });

  const s = os.createSession("standard");
  const r = await os.run(s.id, "删除 x.txt");
  assert.equal(r.stoppedBy, "completed");
  const results = s.trajectory.ofType(EventType.ToolResult);
  assert.ok(results.some((e) => JSON.stringify(e.payload).includes("用户拒绝")));
  assert.ok(s.trajectory.events().some((e) => e.type === EventType.ApprovalRequest));
  assert.ok(existsSync(join(ws, "x.txt")), "被拒绝的文件必须保留");
});

test("端到端：路径越界被权限层硬拦截，读不到沙箱外文件", async (t) => {
  const provider = new MockProvider({
    script: [
      { content: "尝试读取", toolCalls: [{ name: "file_read", arguments: { path: "../../etc/passwd" } }] },
      { content: "读取被拒绝。", toolCalls: [] },
    ],
  });
  const { os } = makeOS(t, { providerOverride: provider });
  const s = os.createSession("standard");
  const r = await os.run(s.id, "读取系统文件");
  assert.equal(r.stoppedBy, "completed");
  assert.ok(s.trajectory.ofType(EventType.ToolResult).some((e) => JSON.stringify(e.payload).includes("权限拒绝")));
});

test("故障注入：模型返回畸形工具参数，工具层校验失败并回喂而不崩溃", async (t) => {
  let n = 0;
  const bad: LLMProvider = {
    name: "bad",
    async complete() {
      n += 1;
      return {
        content: n === 1 ? "" : "参数缺失，已按错误处理。",
        toolCalls: n === 1 ? [{ id: "c1", name: "calc", arguments: {} }] : [],
        usage: usage(),
        model: "bad",
        durationMs: 1,
        provider: "bad",
      };
    },
  };
  const { os } = makeOS(t, { providerOverride: bad });
  const s = os.createSession("standard");
  const r = await os.run(s.id, "算一下");
  assert.equal(r.stoppedBy, "completed");
  assert.ok(s.trajectory.ofType(EventType.ToolResult).some((e) => JSON.stringify(e.payload).includes("参数校验失败")));
});

test("Guard：超过步数上限时终止并写入 guard 事件", async (t) => {
  let n = 0;
  const looping: LLMProvider = {
    name: "loop",
    async complete() {
      n += 1;
      return {
        content: "继续",
        toolCalls: [{ id: `c${n}`, name: "calc", arguments: { expression: "1+1" } }],
        usage: usage(), model: "loop", durationMs: 1, provider: "loop",
      };
    },
  };
  const { os } = makeOS(t, { providerOverride: looping, budget: { maxSteps: 2, loopDetectionThreshold: 100 } });
  const s = os.createSession("standard");
  const r = await os.run(s.id, "一直循环");
  assert.equal(r.stoppedBy, "guard");
  assert.ok(r.reason.includes("最大步数"));
  assert.ok(s.trajectory.events().some((e) => e.type === EventType.Guard));
});

test("运行时插件热插拔：安装后 Hook 生效，卸载后完全回滚", async (t) => {
  const { os } = makeOS(t);
  assert.equal(os.runtime.hooks.count(HookPoint.PreTool), 0);
  const handle = await os.runtime.loadPlugin(BUILTIN_PLUGINS["danger-blocker"]!);
  assert.equal(os.runtime.hooks.count(HookPoint.PreTool), 1);
  const ctx = { point: HookPoint.PreTool, sessionId: "s", turn: 1, step: 0, data: { tool: "shell", arguments: { command: "rm -rf /" } } };
  assert.equal((await os.runtime.hooks.fire(ctx)).blocked, true);
  await handle.unload();
  assert.equal(os.runtime.hooks.count(HookPoint.PreTool), 0);
  assert.equal((await os.runtime.hooks.fire(ctx)).blocked, false);
});

test("会话恢复：从只增日志重建消息后继续对话", async (t) => {
  const provider = new MockProvider({ script: [{ content: "第一轮完成。", toolCalls: [] }] });
  const { os } = makeOS(t, { providerOverride: provider });
  const s = os.createSession("standard");
  await os.run(s.id, "第一轮");
  const resumed = os.sessions.resume(s.id);
  assert.ok(resumed);
  assert.ok(resumed!.messages().some((m) => m.content === "第一轮"));
  assert.equal(resumed!.meta.turns, 1);
  resumed!.close();
});
