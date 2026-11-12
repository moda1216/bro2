/**
 * v2.29.0 · P0-01 Harbor 装载 · 离线契约测试（不联网 / 不需要 Key / 不需要 Docker）
 *
 * 断言的不是「能跑分」，而是 bro2 作为 Harbor 自定义 agent 的**接入口契约与诚实护栏**：
 *  1) bro2_agent.py 实现 Harbor 的 BaseInstalledAgent 契约（name/install/run 形状正确）；
 *  2) run() 向任务容器内发出正确的 bro2 CLI 调用（--auto-approve、instruction 经 shlex 转义）；
 *  3) config.yaml 声明与 external:measure 对齐的预算（max_steps == MAX_MODEL_CALLS）；
 *  4) harbor-verify.ts 守住防自指护栏：不写 external-results.json、不改 L4/verdict；
 *  5) 文档明确「零 Key 接线验证不产能力分数」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? "", "..");
const read = (p: string): string => readFileSync(p, "utf8");
const py = read(join(ROOT, "examples", "harbor", "bro2_agent.py"));
const cfg = read(join(ROOT, "examples", "harbor", "config.yaml"));
const verify = read(join(ROOT, "examples", "harbor-verify.ts"));
const readme = read(join(ROOT, "examples", "harbor", "README.md"));

test("bro2_agent.py 实现 Harbor BaseInstalledAgent 契约", () => {
  assert.ok(py.includes("from harbor.agents.installed.base import BaseInstalledAgent"), "应继承 BaseInstalledAgent");
  assert.ok(py.includes("class Bro2Agent(BaseInstalledAgent)"), "应定义 Bro2Agent 子类");
  assert.ok(/@staticmethod\s*\n\s*def name\(/.test(py), "应实现 name() 静态方法");
  assert.ok(py.includes('return "bro2"'), "name() 应返回 bro2");
  assert.ok(py.includes("async def install("), "应实现 install()");
  assert.ok(/async def run\(\s*self,\s*instruction: str/.test(py), "run() 签名应为 (self, instruction, environment, context)");
  assert.ok(py.includes("@with_prompt_template"), "run() 应使用 @with_prompt_template");
});

test("run() 向任务容器内发出正确的 bro2 CLI 调用", () => {
  assert.ok(py.includes("bin/agentos.ts run"), "应调用 bro2 CLI 的 run 子命令");
  assert.ok(py.includes("--auto-approve"), "应无人值守跑完（--auto-approve）");
  assert.ok(py.includes("shlex.quote(instruction)"), "instruction 必须经 shlex 转义，防命令注入");
  assert.ok(py.includes("--preset standard"), "应使用 standard preset");
});

test("config.yaml 预算与 external:measure 的 MAX_MODEL_CALLS 对齐", () => {
  assert.ok(existsSync(join(ROOT, "examples", "harbor", "config.yaml")));
  // 12 是 external-measure.ts 的 MAX_MODEL_CALLS（见该文件顶部常量）
  assert.match(cfg, /max_steps:\s*12/, "max_steps 应为 12，与 MAX_MODEL_CALLS 对齐");
  assert.ok(cfg.includes("kilo"), "默认 provider 应为免 Key 的 kilo");
});

test("harbor-verify.ts 守住防自指护栏（不写 external-results / 不改 L4-verdict）", () => {
  assert.ok(existsSync(join(ROOT, "examples", "harbor-verify.ts")));
  assert.ok(verify.includes("data/benchmark/external-results.json"), "应引用 external-results.json 指纹前后比对");
  assert.ok(verify.includes("noExternalWrite"), "应断言不改 external-results.json");
  assert.ok(verify.includes("not-achieved") && verify.includes("not-proven"), "应断言 L4/verdict 仍为 not-achieved/not-proven");
  // 反向：验证脚本本身不得向 external-results.json 写任何内容
  assert.ok(!/writeFileSync\([^)]*external-results/.test(verify), "harbor-verify 不得写 external-results.json");
  assert.ok(verify.includes("passed") && verify.includes("honest"), "应产出含 honest 标志的报告");
});

test("文档明确「零 Key 接线验证不产能力分数」", () => {
  assert.ok(readme.includes("零 Key"), "README 应标注零 Key");
  assert.ok(readme.includes("不产生能力分数") || readme.includes("不产能力分数"), "应声明不产能力分数");
  assert.ok(readme.includes("不写") && readme.includes("external-results.json"), "应声明不写 external-results.json");
  assert.ok(readme.includes("L4") && readme.includes("verdict"), "应声明不改 L4/verdict");
  assert.ok(readme.includes("三方对齐"), "应说明任务/预算/评分器三方对齐");
});
