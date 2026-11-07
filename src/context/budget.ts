/**
 * L1 模型层 · Token 预算、历史裁剪与摘要压缩
 *
 * 关键正确性：裁剪必须保持 assistant(tool_calls) 与后续 tool 消息配对，
 * 否则 OpenAI 兼容端点会返回 400。这里按「步」整组裁剪。
 */
import { estimateMessagesTokens, estimateTokens } from "../models/base.ts";
import { Role } from "../kernel/events.ts";
import type { Message } from "../kernel/events.ts";
import type { ToolSchema } from "../tools/schema.ts";
import type { CompactionMode } from "../runtime/policy.ts";

export interface CompactResult {
  messages: Message[];
  compacted: boolean;
  summary?: string;
  removed: number;
  estimatedTokens: number;
  /** 本次生效的压缩策略，写入 Trajectory 供评测断言。 */
  strategy: CompactionMode;
  /** salience 模式下被完整保留的成功工具结果条数。 */
  evidenceKept: number;
}

export class BudgetManager {
  private readonly maxTokens: number;
  private readonly keepRecent: number;
  private readonly mode: CompactionMode;

  constructor(maxTokens: number, keepRecent = 8, mode: CompactionMode = "truncate") {
    this.maxTokens = maxTokens;
    this.keepRecent = keepRecent;
    this.mode = mode;
  }

  compact(messages: readonly Message[], tools: readonly ToolSchema[] | undefined, system: string): CompactResult {
    const total = estimateTokens(system) + estimateMessagesTokens(messages, tools);
    if (total <= this.maxTokens || messages.length <= this.keepRecent) {
      return {
        messages: [...messages], compacted: false, removed: 0, estimatedTokens: total,
        strategy: this.mode, evidenceKept: 0,
      };
    }

    let cut = Math.max(0, messages.length - this.keepRecent);
    // 若切点首条是孤儿 tool 消息，向前扩展到配对的 assistant(tool_calls)
    while (cut > 0 && cut < messages.length && messages[cut]!.role === Role.Tool) cut -= 1;
    // 若切点正好落在一条 assistant(tool_calls) 上，连同它一起裁掉（避免留下无结果调用）
    if (cut < messages.length && messages[cut]!.role === Role.Assistant && messages[cut]!.toolCalls?.length) cut += 1;
    while (cut < messages.length && messages[cut]!.role === Role.Tool) cut += 1;

    const dropped = messages.slice(0, cut);
    const kept = messages.slice(cut);
    // salience：成功的工具结果是"证据"，比普通对话文本更值得完整保留。
    // 等权截断会把关键数值一起切掉，导致压缩后模型看不到依据而臆造结论。
    const isEvidence = (m: Message): boolean =>
      m.role === Role.Tool && !m.content.startsWith("ERROR:");
    const evidenceKept = this.mode === "salience" ? dropped.filter(isEvidence).length : 0;
    const summaryParts = dropped
      .map((m) => {
        const tag = m.role === Role.Tool ? "工具结果" : m.role === Role.User ? "用户" : "助手";
        const cap = this.mode === "salience" && isEvidence(m) ? 320 : 160;
        const text = m.content.replace(/\s+/g, " ").slice(0, cap);
        return `- [${tag}] ${text}`;
      })
      .slice(-12);
    const prefix = this.mode === "salience"
      ? `[历史压缩·证据优先] 已省略 ${dropped.length} 条早期消息，其中 ${evidenceKept} 条成功工具结果被优先完整保留：`
      : `[历史压缩] 已省略 ${dropped.length} 条早期消息，要点如下：`;
    const summary = `${prefix}\n${summaryParts.join("\n")}`;
    const estimated = estimateTokens(system) + estimateTokens(summary) + estimateMessagesTokens(kept, tools);
    return {
      messages: kept,
      compacted: true,
      summary,
      removed: dropped.length,
      estimatedTokens: estimated,
      strategy: this.mode,
      evidenceKept,
    };
  }

  get limit(): number {
    return this.maxTokens;
  }

  get compactionMode(): CompactionMode {
    return this.mode;
  }
}
