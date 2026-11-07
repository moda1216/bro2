import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArgs } from "../src/tools/schema.ts";
import type { JSONSchema } from "../src/tools/schema.ts";
import { ToolRegistry, defineTool, RiskLevel } from "../src/tools/registry.ts";
import { safeCalc } from "../src/tools/builtins/system.ts";
import { withTimeout } from "../src/tools/runtime.ts";
import { SkillRegistry } from "../src/cognition/skills.ts";
import { PlanManager } from "../src/cognition/plan.ts";
import { PresetRegistry } from "../src/cognition/preset.ts";
import { ProviderRouter } from "../src/models/router.ts";
import { emptyResponse } from "../src/models/base.ts";

const schema: JSONSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 1, maximum: 10 },
    mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
    flag: { type: "boolean" },
  },
  required: ["path", "count"],
  additionalProperties: false,
};

test("参数校验：必填 / 类型 / 枚举 / 范围 / 额外字段 / 默认值 / 温和 coerce", () => {
  assert.equal(validateArgs(schema, { path: "a", count: 2 }).ok, true);
  const bad = validateArgs(schema, { path: "a" });
  assert.equal(bad.ok, false);
  assert.ok(bad.ok === false && bad.errors.some((e) => e.includes("缺少必填")));
  assert.equal(validateArgs(schema, { path: "a", count: "3", flag: "true" }).ok, true);
  assert.equal(validateArgs(schema, { path: "", count: 2 }).ok, false);
  assert.equal(validateArgs(schema, { path: "a", count: 99 }).ok, false);
  assert.equal(validateArgs(schema, { path: "a", count: 2, mode: "turbo" }).ok, false);
  assert.equal(validateArgs(schema, { path: "a", count: 2, extra: 1 }).ok, false);
  const withDefault = validateArgs(schema, { path: "a", count: 1 });
  assert.ok(withDefault.ok && withDefault.value.mode === "fast");
});

test("calc 安全解析器：函数 / 数组 / 四则 / 幂 / 常量，且拒绝非法输入", () => {
  assert.equal(safeCalc("sum([12, 18, 25, 31, 14])"), 100);
  assert.equal(safeCalc("avg([2, 4, 6])"), 4);
  assert.equal(safeCalc("2 + 3 * 4"), 14);
  assert.equal(safeCalc("(2 + 3) * 4"), 20);
  assert.equal(safeCalc("2 ^ 10"), 1024);
  assert.equal(safeCalc("-5 + 2"), -3);
  assert.equal(safeCalc("round(pi * 10)"), 31);
  assert.throws(() => safeCalc("1 / 0"), /除数为零/);
  assert.throws(() => safeCalc("process.exit(1)"), /未知函数|非法/);
  assert.throws(() => safeCalc("1; console.log(2)"), /非法字符|多余内容/);
});

test("工具注册表：重复注册拒绝、disposer 可逆、按 Preset 过滤 schema", () => {
  const reg = new ToolRegistry();
  const t = defineTool({
    name: "demo", description: "d", risk: RiskLevel.Safe,
    parameters: { type: "object", properties: {} }, handler: () => "ok",
  });
  const dispose = reg.register(t);
  assert.equal(reg.size, 1);
  assert.throws(() => reg.register(t), /重复注册/);
  assert.equal(reg.schemas(["demo"]).length, 1);
  assert.equal(reg.schemas(["other"]).length, 0);
  assert.equal(reg.schemas(["*"]).length, 1);
  dispose();
  assert.equal(reg.size, 0);
});

test("工具执行超时可被强制短路", async () => {
  await assert.rejects(
    () => withTimeout(new Promise<void>(() => undefined), 30, undefined, "工具超时测试"),
    /工具超时测试/,
  );
});

test("技能渐进披露：先只有摘要，按需加载全文", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentos-skills-"));
  try {
    const skillDir = join(dir, "my-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: 演示技能\ntags: 测试, 演示\n---\n# 正文\n第一步：做事情。\n");
    const reg = new SkillRegistry([dir]);
    assert.equal(reg.size, 1);
    assert.equal(reg.list()[0]!.name, "my-skill");
    assert.ok(reg.summaries().includes("my-skill"));
    assert.ok(!reg.summaries().includes("第一步"));
    assert.equal(reg.get("my-skill")!.loaded, false);
    const body = reg.load("my-skill");
    assert.ok(body?.includes("第一步：做事情"));
    assert.equal(reg.get("my-skill")!.loaded, true);
    assert.equal(reg.load("不存在"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("计划状态机与进度计算", () => {
  const pm = new PlanManager();
  const r = pm.write("s1", [
    { id: "1", content: "A", status: "done" },
    { id: "2", content: "B", status: "in_progress" },
    { id: "3", content: "C" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(pm.progress("s1").percent, 33);
  assert.ok(pm.format("s1").includes("[x] 1. A"));
  assert.equal(pm.write("s1", "not-array").ok, false);
});

test("Preset：4 个内置预设 + 工具白名单", () => {
  const reg = new PresetRegistry();
  assert.equal(reg.list().length, 4);
  assert.deepEqual(reg.get("minimal")?.tools.includes("shell"), true);
  assert.equal(reg.get("minimal")?.tools.includes("delegate"), false);
  assert.equal(reg.resolve("不存在").name, "standard");
  assert.equal(reg.get("standard")?.permissionLevel, "workspace-write");
});

test("模型路由：首个 provider 失败时降级到备用", async () => {
  const router = new ProviderRouter("a");
  router.register("a", { name: "a", complete: async () => { throw new Error("boom"); } });
  router.register("b", { name: "b", complete: async () => emptyResponse("b", "m") });
  const res = await router.complete({ messages: [] });
  assert.ok(res.provider.startsWith("b"));
  assert.equal(router.list().find((x) => x.name === "a")?.failures, 1);
});
