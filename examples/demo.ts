/**
 * 离线完整演示：无 API Key 也能跑通
 *   规划 → 技能加载 → 计算/记忆 → 并行子 Agent → 写报告 → 高危审批 → 终答
 *
 * 运行：node --experimental-strip-types --no-warnings examples/demo.ts
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { createAgentOS } from "../src/index.ts";
import { newId, EventType } from "../src/kernel/events.ts";
import type { Event } from "../src/kernel/events.ts";
import { ApprovalDecision } from "../src/governance/approval.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";
import type { MockStep } from "../src/models/mock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PARENT_SCRIPT: MockStep[] = [
  {
    reasoning: "先拆解任务并加载报告写作方法论",
    content: "我先列计划、加载技能，然后并行收集数据。",
    toolCalls: [
      {
        name: "todo_write",
        arguments: {
          todos: [
            { id: "1", content: "核验 Q3 数据并计算总量", status: "in_progress" },
            { id: "2", content: "并行调研结论与风险", status: "pending" },
            { id: "3", content: "生成报告并落盘", status: "pending" },
          ],
        },
      },
      { name: "skill_load", arguments: { name: "report-writing" } },
    ],
  },
  {
    reasoning: "计算总量并把关键背景写入长期记忆",
    content: "并行执行计算与记忆写入。",
    toolCalls: [
      { name: "calc", arguments: { expression: "sum([128, 156, 142, 171, 165])" } },
      { name: "memory_write", arguments: { key: "Q3背景", content: "Q3 五个月营收，单位万元；口径为不含税累计。", tags: ["Q3", "营收"] } },
    ],
  },
  {
    reasoning: "两个独立子问题适合并行派生",
    content: "派生两个子 Agent 并行处理结论归纳与风险识别。",
    toolCalls: [
      {
        name: "delegate",
        arguments: {
          tasks: [
            { preset: "researcher", task: "归纳 3 条核心结论", input: "营收数据 128/156/142/171/165 万元" },
            { preset: "researcher", task: "列出 2 个风险点", input: "营收数据 128/156/142/171/165 万元" },
          ],
        },
      },
    ],
  },
  {
    reasoning: "汇总后生成报告，并顺手创建一个待删除的临时文件用于演示审批",
    content: "写入报告与临时文件。",
    toolCalls: [
      {
        name: "file_write",
        arguments: {
          path: "Q3报告.md",
          content: "# Q3 经营报告\n\n## 结论先行\n五个月合计 762 万元，环比保持增长。\n\n## 依据\n- 原始序列：128 / 156 / 142 / 171 / 165 万元（calc 求和 = 762）\n- 口径：不含税累计，来自长期记忆「Q3背景」\n\n## 分析\n- 峰值出现在第 4 期（171 万元），第 3 期有回落。\n- 子 Agent 并行给出结论与风险清单，已并入报告。\n\n## 行动项\n1. 复核第 3 期回落原因。\n2. 补充毛利率数据后再做同比。\n\n> 由 bro2 离线演示生成，所有数字来自真实工具返回。\n",
        },
      },
      { name: "file_write", arguments: { path: "tmp-delete-me.txt", content: "临时文件，用于演示高危操作审批" } },
    ],
  },
  {
    reasoning: "删除是 danger 工具，会进入人工审批",
    content: "清理临时文件（触发审批）。",
    toolCalls: [{ name: "file_delete", arguments: { path: "tmp-delete-me.txt" } }],
  },
  {
    reasoning: "工具链已完成，输出结论",
    content: "任务完成：报告已生成到 Q3报告.md，临时文件经审批后已清理。核心数字：合计 762 万元（真实 calc 结果）。",
    toolCalls: [],
  },
];

/** 父会话走脚本，子 Agent 走独立终答，避免共享脚本游标。 */
class DemoProvider implements LLMProvider {
  readonly name = "demo-scripted";
  private parentStep = 0;

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const isChild = req.messages.some((m) => m.role === "system" && m.content.includes("你是子 Agent"));
    const step: MockStep = isChild
      ? { content: "子任务完成：已基于给定材料归纳要点，并标注数据口径（子 Agent 上下文隔离）。" }
      : (PARENT_SCRIPT[this.parentStep] ?? { content: "任务已完成。" });
    if (!isChild) this.parentStep += 1;

    const toolCalls = (step.toolCalls ?? []).map((c) => ({ id: newId("call"), name: c.name, arguments: c.arguments }));
    const text = step.content ?? "";
    for (let i = 0; i < text.length; i += 40) req.onChunk?.({ kind: "text", text: text.slice(i, i + 40) });
    for (const c of toolCalls) req.onChunk?.({ kind: "tool_call", text: c.name });
    req.onChunk?.({ kind: "done" });
    return {
      content: text,
      ...(step.reasoning ? { reasoning: step.reasoning } : {}),
      toolCalls,
      usage: { inputTokens: 320, outputTokens: Math.ceil(text.length / 3), totalTokens: 320 + Math.ceil(text.length / 3) },
      model: "demo-scripted",
      durationMs: 1,
      provider: this.name,
    };
  }
}

const os = createAgentOS({
  root: ROOT,
  providerOverride: new DemoProvider(),
  autoApprove: false,
  plugins: ["tool-audit"],
});

os.approvals.onRequest((req) => {
  process.stdout.write(`  [HITL 审批] ${req.toolName} · ${req.reason} → 演示模式自动批准\n`);
  os.approvals.resolve(req.id, ApprovalDecision.Approve);
});

const session = os.createSession("standard");
process.stdout.write(`\n=== bro2 离线演示 ===\n会话 ${session.id} · Preset standard · 工具 ${os.registry.size} 个 · 技能 ${os.skills.size} 个\n\n`);

const onEvent = (e: Event): void => {
  if (e.type === EventType.ToolCall) {
    for (const c of (e.payload.calls as Array<{ name: string }>) ?? []) process.stdout.write(`  → 调用 ${c.name}\n`);
  } else if (e.type === EventType.ToolResult) {
    const r = e.payload.result as { name: string; ok: boolean; elapsedMs: number; error?: string };
    process.stdout.write(`     ${r.ok ? "✓" : "✗"} ${r.name} ${r.elapsedMs}ms${r.ok ? "" : ` ${r.error}`}\n`);
  } else if (e.type === EventType.SubAgentStart) {
    process.stdout.write(`  ⇢ 派生子 Agent: ${String(e.payload.preset)}\n`);
  } else if (e.type === EventType.ApprovalRequest) {
    process.stdout.write(`  ⚠ 审批请求已发出\n`);
  } else if (e.type === EventType.Guard) {
    process.stdout.write(`  ! Guard: ${String(e.payload.reason)}\n`);
  }
};

os.runtime.bus.on("*", onEvent);

const result = await os.run(session.id, "整理 Q3 数据、并行调研并产出报告");

process.stdout.write(`\n=== 结果 ===\n${result.answer}\n`);
process.stdout.write(`\n状态: ${result.stoppedBy} · 步数 ${result.steps + 1} · 工具调用 ${result.toolCallCount} · token ${result.usage.totalTokens}\n`);

const reportPath = join(os.config.permission.workspace, "Q3报告.md");
if (existsSync(reportPath)) {
  const content = readFileSync(reportPath, "utf8");
  process.stdout.write(`报告已落盘: ${reportPath} (${content.length} 字符)\n`);
}
const stats = session.trajectory.stats();
const events = session.trajectory.events();
process.stdout.write(`Trajectory: ${stats.events} 条事件 · 工具 ${stats.toolCalls} 次 · 失败 ${stats.toolErrors} 次\n`);
process.stdout.write(`审批事件: ${events.filter((e) => e.type === EventType.ApprovalRequest).length} · 子 Agent 事件: ${events.filter((e) => e.type === EventType.SubAgentStart).length} · 技能注入: ${events.filter((e) => e.type === EventType.ContextInject).length}\n`);
const m = os.tracer.snapshot();
process.stdout.write(`指标: 事件 ${m.events} · 平均工具耗时 ${m.avgToolLatencyMs}ms · 错误 ${m.errors}\n`);

await os.shutdown();
