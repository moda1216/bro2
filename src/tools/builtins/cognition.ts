/**
 * 内置工具 · 规划 / 技能 / 记忆 / 人工提问
 */
import { defineTool, RiskLevel } from "../registry.ts";
import type { ToolDef } from "../registry.ts";
import type { PlanManager } from "../../cognition/plan.ts";
import type { SkillRegistry } from "../../cognition/skills.ts";
import type { MemoryStore } from "../../memory/store.ts";
import { retrieve } from "../../memory/retrieval.ts";
import { MemoryKind } from "../../memory/store.ts";
import { EventType } from "../../kernel/events.ts";

export const todoWrite = defineTool({
  name: "todo_write",
  description: "创建或更新任务计划（TODO 列表）。复杂任务开始时调用，完成后把各项标记为 done。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "任务列表，每项含 id / content / status(pending|in_progress|done|cancelled)",
        items: { type: "object" },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const plans = ctx.runtime.require<PlanManager>("plans");
    const r = plans.write(ctx.session.id, args.todos);
    if (!r.ok) return r.message;
    return `${r.message}\n${plans.format(ctx.session.id)}`;
  },
});

export const todoRead = defineTool({
  name: "todo_read",
  description: "读取当前会话的任务计划与进度。",
  risk: RiskLevel.Safe,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => ctx.runtime.require<PlanManager>("plans").format(ctx.session.id),
});

export const skillList = defineTool({
  name: "skill_list",
  description: "列出已安装的技能包（SKILL.md）及其描述。",
  risk: RiskLevel.Safe,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => {
    const skills = ctx.runtime.require<SkillRegistry>("skills");
    const all = skills.list();
    return all.length === 0 ? "（未安装技能）" : all.map((s) => `- ${s.name}: ${s.description}${s.loaded ? " [已加载]" : ""}`).join("\n");
  },
});

export const skillLoad = defineTool({
  name: "skill_load",
  description: "按需加载某个技能的完整说明（渐进披露：系统提示里只有摘要）。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "技能名称" } },
    required: ["name"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const skills = ctx.runtime.require<SkillRegistry>("skills");
    const body = skills.load(args.name);
    if (!body) return `未找到技能 ${args.name}。可用: ${skills.list().map((s) => s.name).join(", ")}`;
    ctx.session.trajectory.append({
      sessionId: ctx.session.id, turn: ctx.turn, step: ctx.step,
      type: EventType.ContextInject,
      payload: { kind: "skill", name: args.name, content: body.slice(0, 8000) },
    });
    return body;
  },
});

export const memoryWrite = defineTool({
  name: "memory_write",
  description: "写入长期记忆（跨会话保留）或工作记忆（scratchpad）。",
  risk: RiskLevel.Write,
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "记忆键" },
      content: { type: "string", description: "记忆内容" },
      tags: { type: "array", description: "便于检索的标签", items: { type: "string" } },
      scope: { type: "string", description: "long(长期) 或 working(工作记忆)", enum: ["long", "working"], default: "long" },
    },
    required: ["key", "content"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const mem = ctx.runtime.require<MemoryStore>("memory");
    const kind = args.scope === "working" ? MemoryKind.Working : MemoryKind.Long;
    mem.put(kind, args.key, args.content, (args.tags as string[] | undefined) ?? [], ctx.session.id);
    return `已写入${kind === MemoryKind.Long ? "长期" : "工作"}记忆: ${args.key}`;
  },
});

export const memoryRead = defineTool({
  name: "memory_read",
  description: "按 key 读取记忆内容。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "记忆键" },
      scope: { type: "string", enum: ["long", "working"], default: "long" },
    },
    required: ["key"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const mem = ctx.runtime.require<MemoryStore>("memory");
    const kind = args.scope === "working" ? MemoryKind.Working : MemoryKind.Long;
    const e = mem.get(kind, args.key, ctx.session.id);
    return e ? `${e.key}:\n${e.content}` : `未找到记忆: ${args.key}`;
  },
});

export const memorySearch = defineTool({
  name: "memory_search",
  description: "按关键词检索长期记忆与工作记忆。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "查询词" } },
    required: ["query"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const mem = ctx.runtime.require<MemoryStore>("memory");
    const hits = retrieve(mem, args.query, 8);
    return hits.length === 0 ? "无相关记忆" : hits.map((h) => `- [${h.entry.kind}] ${h.entry.key} (score ${h.score}): ${h.entry.content.slice(0, 200)}`).join("\n");
  },
});

export const askUser = defineTool({
  name: "ask_user",
  description: "当信息不足或需要用户决策时提问。问题会写入轨迹并作为本轮结论返回给用户。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "要向用户提出的问题" } },
    required: ["question"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    ctx.session.trajectory.append({
      sessionId: ctx.session.id, turn: ctx.turn, step: ctx.step,
      type: EventType.ContextInject,
      payload: { kind: "question", content: args.question },
    });
    return `已记录待确认问题，请在终答中直接向用户提出：${args.question}`;
  },
});

export const COGNITION_TOOLS: ToolDef[] = [todoWrite, todoRead, skillList, skillLoad, memoryWrite, memoryRead, memorySearch, askUser];
