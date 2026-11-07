/**
 * L1 模型层 · 上下文组装（系统提示 + 记忆 + 技能摘要 + 计划状态）
 */
import { buildMemoryInjection } from "../memory/retrieval.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { SkillRegistry } from "../cognition/skills.ts";
import type { PlanManager } from "../cognition/plan.ts";
import type { AgentPreset } from "../cognition/preset.ts";
import type { Session } from "../kernel/session.ts";
import type { Message } from "../kernel/events.ts";

export interface ContextInputs {
  preset: AgentPreset;
  skills: SkillRegistry;
  memory: MemoryStore;
  plans: PlanManager;
  session: Session;
  toolNames: readonly string[];
  query: string;
  permissionLevel: string;
  workspace: string;
  extraInject?: string;
  depth?: number;
}

export interface BuiltContext {
  system: string;
  history: Message[];
}

export class ContextBuilder {
  build(input: ContextInputs): BuiltContext {
    const parts: string[] = [input.preset.systemPrompt];

    parts.push(
      [
        "",
        "## 运行环境",
        `- 时间: ${new Date().toISOString()}`,
        `- 工作区: ${input.workspace}`,
        `- 权限级别: ${input.permissionLevel}`,
        `- 可用工具数: ${input.toolNames.length}`,
        ...(input.depth ? [`- 当前为子 Agent（嵌套深度 ${input.depth}），请勿无限派生`] : []),
      ].join("\n"),
    );

    const skillSummary = input.skills.summaries();
    if (skillSummary) parts.push(`\n## 技能\n${skillSummary}`);

    const mem = buildMemoryInjection(input.memory, input.query, 600);
    if (mem) parts.push(`\n## 记忆\n${mem}`);

    const progress = input.plans.progress(input.session.id);
    if (progress.total > 0) parts.push(`\n## 当前计划\n${input.plans.format(input.session.id)}`);

    if (input.extraInject) parts.push(`\n## 上下文注入\n${input.extraInject}`);

    parts.push(
      [
        "",
        "## 行为约束",
        "1. 严格按工具 schema 传参；工具结果以真实返回为准，不得臆造。",
        "2. 复杂任务先用 todo_write 拆解；完成后更新计划状态。",
        "3. 高危操作会进入人工审批，被拒绝时换安全方案，不要反复重试同一调用。",
        "4. 任务完成时直接给出结论，不要再发起工具调用。",
      ].join("\n"),
    );

    return { system: parts.join("\n"), history: input.session.messages() };
  }
}
