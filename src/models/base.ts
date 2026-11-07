/**
 * L1 模型层 · 抽象契约
 */
import type { Message, ToolCall, Usage } from "../kernel/events.ts";
import type { ToolSchema } from "../tools/schema.ts";

export interface StreamChunk {
  kind: "text" | "reasoning" | "tool_call" | "done";
  text?: string;
}

export interface LLMRequest {
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: StreamChunk) => void;
}

export interface LLMResponse {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  durationMs: number;
  provider: string;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/** 轻量 token 估算：中英混排下按 3.2 字符/token + 结构化开销，误差可接受。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.2);
}

export function estimateMessagesTokens(messages: readonly Message[], tools?: readonly ToolSchema[]): number {
  let n = 4;
  for (const m of messages) {
    n += estimateTokens(m.content) + 4;
    if (m.toolCalls) n += estimateTokens(JSON.stringify(m.toolCalls)) + 2;
    if (m.reasoning) n += estimateTokens(m.reasoning);
  }
  if (tools) n += estimateTokens(JSON.stringify(tools));
  return n;
}

export const emptyResponse = (provider: string, model: string): LLMResponse => ({
  content: "",
  toolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  model,
  durationMs: 0,
  provider,
});
