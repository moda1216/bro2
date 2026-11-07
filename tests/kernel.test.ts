import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, EventType, Role, eventsToMessages } from "../src/kernel/events.ts";
import { HookManager, HookPoint, HookAction } from "../src/kernel/hooks.ts";
import { Trajectory } from "../src/kernel/trajectory.ts";
import { SessionManager } from "../src/kernel/session.ts";
import { Runtime } from "../src/kernel/runtime.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";
import type { Event } from "../src/kernel/events.ts";

const mkEvent = (type: EventType, payload: Record<string, unknown>, seq = 1): Event => ({
  seq, ts: new Date().toISOString(), sessionId: "s1", turn: 1, step: 0, type, payload,
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "agentos-kernel-"));
}

test("事件流可还原为模型可见消息（会话恢复基础）", () => {
  const events: Event[] = [
    mkEvent(EventType.UserMessage, { content: "你好" }, 1),
    mkEvent(EventType.AssistantMessage, { content: "", toolCalls: [{ id: "c1", name: "calc", arguments: {} }] }, 2),
    mkEvent(EventType.ToolResult, { result: { callId: "c1", name: "calc", ok: true, output: "42", elapsedMs: 1 } }, 3),
    mkEvent(EventType.ContextInject, { content: "补充上下文" }, 4),
  ];
  const msgs = eventsToMessages(events);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0]!.role, Role.User);
  assert.equal(msgs[1]!.toolCalls?.[0]!.name, "calc");
  assert.equal(msgs[2]!.role, Role.Tool);
  assert.equal(msgs[2]!.toolCallId, "c1");
  assert.equal(msgs[3]!.role, Role.System);
});

test("EventBus 隔离订阅者异常，不打断其它订阅者", async () => {
  const bus = new EventBus();
  let seen = 0;
  bus.on(EventType.ToolCall, () => { throw new Error("插件崩了"); });
  bus.on(EventType.ToolCall, () => { seen += 1; });
  await bus.emit(mkEvent(EventType.ToolCall, {}));
  assert.equal(seen, 1);
  assert.equal(bus.subscriberErrors.length, 1);
  assert.equal(bus.listenerCount, 2);
});

test("HookManager 支持 modify 累积与 block 中断", async () => {
  const hm = new HookManager();
  const dispose = hm.register(HookPoint.PreStep, () => ({ action: HookAction.Modify, data: { inject: "A" } }));
  hm.register(HookPoint.PreStep, () => ({ action: HookAction.Modify, data: { b: 2 } }));
  const r1 = await hm.fire({ point: HookPoint.PreStep, sessionId: "s", turn: 1, step: 0, data: { x: 1 } });
  assert.equal(r1.blocked, false);
  assert.equal(r1.data.inject, "A");
  assert.equal(r1.data.x, 1);
  assert.equal(r1.data.b, 2);
  dispose();
  assert.equal(hm.count(HookPoint.PreStep), 1);

  hm.register(HookPoint.PreStep, () => ({ action: HookAction.Block, reason: "禁止" }));
  hm.register(HookPoint.PreStep, () => ({ action: HookAction.Continue }));
  const r2 = await hm.fire({ point: HookPoint.PreStep, sessionId: "s", turn: 1, step: 0, data: {} });
  assert.equal(r2.blocked, true);
  assert.equal(r2.fired.at(-1)?.reason, "禁止");
});

test("Trajectory 只增写、崩溃残缺末行容错、分叉与统计", () => {
  const dir = tmp();
  try {
    const p = join(dir, "t.jsonl");
    const t = new Trajectory(p);
    t.append({ sessionId: "s", turn: 1, step: 0, type: EventType.UserMessage, payload: { content: "a" } });
    t.append({ sessionId: "s", turn: 1, step: 1, type: EventType.AssistantMessage, payload: { content: "b" } });
    assert.equal(t.events().length, 2);
    assert.equal(t.messages().length, 2);
    assert.equal(t.lastSeq, 2);
    const st = t.stats();
    assert.equal(st.events, 2);
    assert.ok(st.firstTs && st.lastTs);

    const child = t.fork(join(dir, "fork.jsonl"), 1);
    assert.equal(child.events().length, 1);
    assert.equal(child.messages()[0]!.content, "a");
    t.close();
    child.close();

    // 模拟崩溃：追加半行 JSON
    writeFileSync(p, '{"seq":3,"ts":"broken\n', { flag: "a" });
    const recovered = new Trajectory(p);
    assert.equal(recovered.events().length, 2, "残缺末行应被跳过");
    assert.equal(recovered.lastSeq, 2);
    recovered.append({ sessionId: "s", turn: 1, step: 2, type: EventType.RunEnd, payload: {} });
    assert.equal(recovered.lastSeq, 3, "seq 应从已有最大值续接");
    recovered.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager 创建 / 恢复 / 分叉 / 列表", () => {
  const dir = tmp();
  try {
    const sm = new SessionManager(dir);
    const s = sm.create("standard", "测试会话");
    s.trajectory.append({ sessionId: s.id, turn: 1, step: 0, type: EventType.UserMessage, payload: { content: "hi" } });
    s.touch("done", 1);
    assert.equal(sm.list().length, 1);
    const resumed = sm.resume(s.id);
    assert.ok(resumed);
    assert.equal(resumed!.messages().length, 1);
    assert.equal(resumed!.meta.turns, 1);
    const forked = sm.fork(resumed!.id);
    assert.ok(forked);
    assert.equal(forked!.meta.parentId, resumed!.id);
    assert.equal(forked!.messages().length, 1);
    assert.equal(sm.list().length, 2);
    s.close();
    resumed!.close();
    forked!.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const minimalConfig = (): RuntimeConfig => ({}) as RuntimeConfig;

test("Runtime 插件的可逆副作用：卸载后 Hook / 服务全部回滚", async () => {
  const rt = new Runtime(minimalConfig());
  const def = {
    name: "demo-plugin",
    setup(r: Runtime): void {
      r.register("demo.value", 42);
      r.onHook(HookPoint.PreTool, () => ({ action: HookAction.Continue }));
      r.onEvent(EventType.ToolCall, () => undefined);
    },
  };
  const handle = await rt.loadPlugin(def);
  assert.equal(rt.require("demo.value"), 42);
  assert.equal(rt.hooks.count(HookPoint.PreTool), 1);
  assert.equal(rt.bus.listenerCount, 1);
  await handle.unload();
  assert.equal(rt.get("demo.value"), undefined);
  assert.equal(rt.hooks.count(HookPoint.PreTool), 0);
  assert.equal(rt.bus.listenerCount, 0);
  assert.deepEqual(rt.pluginNames(), []);
});

test("Runtime 插件加载失败时回滚已注册副作用", async () => {
  const rt = new Runtime(minimalConfig());
  await assert.rejects(
    () => rt.loadPlugin({
      name: "broken",
      setup(r: Runtime): void {
        r.register("half.done", 1);
        throw new Error("setup 失败");
      },
    }),
    /setup 失败/,
  );
  assert.equal(rt.get("half.done"), undefined);
  assert.deepEqual(rt.pluginNames(), []);
});
