/**
 * L1 模型层 · 离线 Mock Provider
 *
 * 两种驱动方式：
 *  - scripted：示例/测试注入确定性脚本，逐步返回工具调用与终答；
 *  - heuristic：内置状态机，任意用户输入都能跑出「规划 → 执行 → 汇总」闭环。
 * 没有 API Key 也能完整验证 Agent OS 的全部链路。
 */
import { newId } from "../kernel/events.ts";
import { estimateMessagesTokens } from "./base.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "./base.ts";
import type { ToolCall } from "../kernel/events.ts";

export interface MockStep {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export type MockScript = MockStep[] | ((req: LLMRequest, stepIndex: number) => MockStep);

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private readonly script?: MockScript;
  private readonly strategy: "scripted" | "heuristic";
  private stepIndex = 0;
  private readonly latencyMs: number;

  constructor(options: { script?: MockScript; strategy?: "scripted" | "heuristic"; latencyMs?: number } = {}) {
    this.script = options.script;
    this.strategy = options.strategy ?? (options.script ? "scripted" : "heuristic");
    this.latencyMs = options.latencyMs ?? 0;
  }

  reset(): void {
    this.stepIndex = 0;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (req.signal?.aborted) throw new Error("已取消");

    const step: MockStep = this.strategy === "scripted" ? this.fromScript(req) : this.heuristic(req);
    const text = step.content ?? "";
    const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((c) => ({
      id: newId("call"),
      name: c.name,
      arguments: c.arguments,
    }));

    // 模拟流式输出
    for (const piece of chunk(text, 48)) {
      if (req.signal?.aborted) throw new Error("已取消");
      req.onChunk?.({ kind: "text", text: piece });
    }
    for (const c of toolCalls) req.onChunk?.({ kind: "tool_call", text: c.name });
    req.onChunk?.({ kind: "done" });

    const inputTokens = estimateMessagesTokens(req.messages, req.tools);
    const outputTokens = Math.ceil((text + JSON.stringify(toolCalls)).length / 3.2);
    this.stepIndex += 1;
    return {
      content: text,
      ...(step.reasoning ? { reasoning: step.reasoning } : {}),
      toolCalls,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: "mock-1",
      durationMs: Date.now() - started,
      provider: this.name,
    };
  }

  private fromScript(req: LLMRequest): MockStep {
    if (!this.script) return { content: "已完成。" };
    if (typeof this.script === "function") return this.script(req, this.stepIndex);
    const s = this.script[Math.min(this.stepIndex, this.script.length - 1)];
    // 最后一步之后保持终答，避免无限循环
    if (this.stepIndex >= this.script.length) return { content: "任务已完成。" };
    return s ?? { content: "任务已完成。" };
  }

  /** 启发式状态机：从历史事件推断已做过什么，决定下一步。 */
  private heuristic(req: LLMRequest): MockStep {
    const msgs = req.messages;
    const userText = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    const called = new Set<string>();
    for (const m of msgs) {
      if (m.role === "assistant" && m.toolCalls) for (const c of m.toolCalls) called.add(c.name);
    }
    const results = msgs.filter((m) => m.role === "tool");
    const lastToolName = results.length > 0 ? results[results.length - 1]!.name : undefined;
    const lastResult = results.length > 0 ? results[results.length - 1]!.content : "";

    // 0) 先规划
    if (!called.has("todo_write")) {
      return {
        reasoning: "先拆解任务，再逐步执行。",
        content: "我先列个计划，然后逐步执行。",
        toolCalls: [
          {
            name: "todo_write",
            arguments: {
              todos: [
                { id: "1", content: "理解任务并确定所需工具", status: "in_progress" },
                { id: "2", content: "执行核心操作并获取结果", status: "pending" },
                { id: "3", content: "汇总结果并交付", status: "pending" },
              ],
            },
          },
        ],
      };
    }

    // 1) 规划后选择主执行工具（按关键词）
    const mainTool = pickMainTool(userText);
    const mainDone = called.has(mainTool.name) && lastToolName !== "todo_write";
    if (!mainDone && !called.has(mainTool.name)) {
      return {
        reasoning: `根据任务关键词选用 ${mainTool.name}。`,
        content: `接下来调用 ${mainTool.name} 执行。`,
        toolCalls: [{ name: mainTool.name, arguments: mainTool.args(userText) }],
      };
    }

    // 2) 子 agent 演示：任务含「调研 / 并行 / 分析」时派生一次
    if (/调研|并行|多角度|子任务|subagent|delegate/i.test(userText) && !called.has("delegate")) {
      return {
        content: "这个任务适合并行，我派生一个子 Agent 处理子任务。",
        toolCalls: [
          {
            name: "delegate",
            arguments: {
              tasks: [{ preset: "researcher", task: "请对以下内容做要点归纳并给出 3 条结论", input: userText }],
            },
          },
        ],
      };
    }

    // 3) 终答（引用最后一次工具结果）
    const summary = lastResult.length > 420 ? `${lastResult.slice(0, 420)}…` : lastResult;
    return {
      reasoning: "工具结果已足够，输出结论。",
      content: `任务已完成。\n\n执行摘要：${summary || "无额外工具输出"}\n\n（本次由离线 Mock 模型驱动，工具调用与 Trajectory 均为真实执行。）`,
    };
  }
}

function pickMainTool(text: string): { name: string; args: (t: string) => Record<string, unknown> } {
  const t = text.toLowerCase();
  if (/计算|求和|统计|多少|算一下|平均值|calc/.test(t)) {
    return { name: "calc", args: () => ({ expression: "sum([12, 18, 25, 31, 14])" }) };
  }
  if (/删除|清空|remove|rm |危险/.test(t)) {
    return { name: "shell", args: () => ({ command: "echo 'danger: rm -rf demo' && false" }) };
  }
  if (/运行|命令|shell|终端|pwd|ls/.test(t)) {
    return { name: "shell", args: () => ({ command: "node --version && ls -la" }) };
  }
  if (/搜索|查找|grep|search/.test(t)) {
    return { name: "search_files", args: (s) => ({ pattern: "Agent", path: "./" }) };
  }
  if (/网页|http|请求|url|抓取/.test(t)) {
    return { name: "http_get", args: () => ({ url: "https://example.com" }) };
  }
  if (/报告|文档|写入|生成文件|保存|写文件|report/.test(t)) {
    return {
      name: "file_write",
      args: (s) => ({
        path: "report.md",
        content: `# 任务报告\n\n原始任务：${s.slice(0, 200)}\n\n结论：已由 bro2 自动完成。\n生成时间：${new Date().toISOString()}\n`,
      }),
    };
  }
  return { name: "file_write", args: (s) => ({ path: "notes.md", content: `# 任务记录\n\n${s.slice(0, 300)}\n` }) };
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
