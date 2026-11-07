/**
 * 内置工具 · 协作与运行时自省（子 Agent / 自动化 / 轨迹 / 插件热插拔）
 */
import { defineTool, RiskLevel } from "../registry.ts";
import type { ToolDef } from "../registry.ts";
import type { SubAgentRunner, SubTask } from "../../delegation/subagent.ts";
import { SubAgentRunner as Runner } from "../../delegation/subagent.ts";
import type { AutomationScheduler } from "../../delegation/automation.ts";
import type { Tracer } from "../../observability/tracing.ts";
import type { PluginDefinition, Runtime } from "../../kernel/runtime.ts";
import type { PresetRegistry } from "../../cognition/preset.ts";
import type { ToolRegistry } from "../registry.ts";
import type { Event } from "../../kernel/events.ts";

export const delegate = defineTool({
  name: "delegate",
  description: "派生多个子 Agent 并行处理子任务，隔离上下文与预算，只回传结果摘要。适合调研、多角度分析。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "子任务列表，每项 {task, preset?, input?}",
        items: { type: "object" },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  timeoutMs: 120000,
  handler: async (args, ctx) => {
    const presets = ctx.runtime.require<PresetRegistry>("presets");
    const preset = presets.resolve(ctx.session.preset);
    if (!preset.allowSubAgents) return "当前 Preset 不允许派生子 Agent";
    if (ctx.nested) return "子 Agent 内部不再嵌套派生（防止递归膨胀）";
    const runner = ctx.runtime.require<SubAgentRunner>("subagents");
    const tasks = (Array.isArray(args.tasks) ? args.tasks : []) as SubTask[];
    if (tasks.length === 0) return "没有子任务";
    const results = await runner.run(tasks, {
      parentSessionId: ctx.session.id,
      turn: ctx.turn,
      step: ctx.step,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      depth: 0,
      record: (d) => ctx.session.trajectory.append(d),
      publish: (e) => ctx.runtime.publish(e as Event),
    });
    return Runner.format(results);
  },
});

export const automationAdd = defineTool({
  name: "automation_add",
  description: "创建定时自动化任务（按间隔重复执行一段提示词）。",
  risk: RiskLevel.Write,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "任务名称" },
      task: { type: "string", description: "每次触发时交给 Agent 执行的任务" },
      interval_seconds: { type: "integer", description: "触发间隔（秒），最小 1", minimum: 1, default: 60 },
      preset: { type: "string", description: "使用的 Preset", default: "standard" },
    },
    required: ["name", "task"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const scheduler = ctx.runtime.require<AutomationScheduler>("scheduler");
    const job = scheduler.add({
      name: args.name,
      task: args.task,
      ...(args.preset ? { preset: String(args.preset) } : {}),
      intervalMs: (args.interval_seconds ?? 60) * 1000,
    });
    return `已创建自动化任务 ${job.id} (${job.name})，每 ${job.intervalMs / 1000}s 执行一次，状态 ${job.status}`;
  },
});

export const automationList = defineTool({
  name: "automation_list",
  description: "列出全部自动化任务及其状态、上次结果。",
  risk: RiskLevel.Safe,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => {
    const scheduler = ctx.runtime.require<AutomationScheduler>("scheduler");
    const jobs = scheduler.list();
    return jobs.length === 0
      ? "（没有自动化任务）"
      : jobs.map((j) => `- ${j.id} ${j.name} [${j.status}] 每 ${j.intervalMs / 1000}s，运行 ${j.runCount} 次${j.lastResult ? `，上次: ${j.lastResult.slice(0, 80)}` : ""}`).join("\n");
  },
});

export const automationRun = defineTool({
  name: "automation_run",
  description: "立即触发执行一次自动化任务。",
  risk: RiskLevel.Write,
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "任务 id" } },
    required: ["id"],
    additionalProperties: false,
  },
  timeoutMs: 120000,
  handler: async (args, ctx) => {
    const scheduler = ctx.runtime.require<AutomationScheduler>("scheduler");
    try {
      return await scheduler.runNow(args.id);
    } catch (err) {
      return `触发失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const runtimeStatus = defineTool({
  name: "runtime_status",
  description: "查看运行时状态：已注册服务、工具、插件、Preset 与实时指标。",
  risk: RiskLevel.Safe,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => {
    const registry = ctx.runtime.require<ToolRegistry>("registry");
    const tracer = ctx.runtime.get<Tracer>("tracer");
    const m = tracer?.snapshot();
    const policy = ctx.runtime.get<Record<string, string>>("policy");
    return [
      `服务: ${ctx.runtime.keys().sort().join(", ")}`,
      policy ? `行为策略: ${Object.entries(policy).map(([k, v]) => `${k}=${v}`).join("  ")}` : "",
      `工具数: ${registry.size} (${registry.names().slice(0, 20).join(", ")}…)`,
      `插件: ${ctx.runtime.pluginNames().join(", ") || "（无）"}`,
      `Hook 数: ${ctx.runtime.hooks.count()}`,
      `事件订阅: ${ctx.runtime.bus.listenerCount}`,
      m ? `指标: 事件 ${m.events} / 工具调用 ${m.toolCalls} / 失败 ${m.toolFailures} / token ${m.inputTokens}+${m.outputTokens} / 平均工具耗时 ${m.avgToolLatencyMs}ms` : "",
    ].filter(Boolean).join("\n");
  },
});

export const trajectoryView = defineTool({
  name: "trajectory_view",
  description: "查看当前会话的 Trajectory 执行轨迹（只增不改的事件日志）。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: { limit: { type: "integer", description: "返回最近多少条", default: 20, minimum: 1, maximum: 200 } },
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const all = ctx.session.trajectory.events();
    const rows = all.slice(-(args.limit ?? 20)).map((e) =>
      `#${e.seq} [step ${e.step}] ${e.type} ${JSON.stringify(e.payload).slice(0, 160)}`,
    );
    return `共 ${all.length} 条事件，显示最近 ${rows.length} 条:\n${rows.join("\n")}`;
  },
});

export const pluginList = defineTool({
  name: "plugin_list",
  description: "列出可安装的内置插件与当前已加载插件。",
  risk: RiskLevel.Safe,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => {
    const catalog = ctx.runtime.get<Record<string, PluginDefinition>>("pluginCatalog") ?? {};
    const loaded = ctx.runtime.pluginNames();
    return [
      `已加载: ${loaded.join(", ") || "（无）"}`,
      `可安装: ${Object.keys(catalog).join(", ") || "（无）"}`,
    ].join("\n");
  },
});

export const pluginInstall = defineTool({
  name: "plugin_install",
  description: "运行时安装（热插拔）一个内置插件，无需重启。插件注册的所有副作用可完整回滚。",
  risk: RiskLevel.Write,
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "插件名称，可用 plugin_list 查看" } },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const catalog = ctx.runtime.get<Record<string, PluginDefinition>>("pluginCatalog") ?? {};
    const def = catalog[args.name];
    if (!def) return `未找到插件 ${args.name}。可用: ${Object.keys(catalog).join(", ")}`;
    if (ctx.runtime.pluginNames().includes(args.name)) return `插件 ${args.name} 已加载`;
    try {
      const handle = await (ctx.runtime as Runtime).loadPlugin(def);
      return `插件 ${handle.name} 已热加载。当前插件: ${ctx.runtime.pluginNames().join(", ")}`;
    } catch (err) {
      return `插件加载失败并已回滚: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const ORCHESTRATION_TOOLS: ToolDef[] = [
  delegate, automationAdd, automationList, automationRun,
  runtimeStatus, trajectoryView, pluginList, pluginInstall,
];
