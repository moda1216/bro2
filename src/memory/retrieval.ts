/**
 * L3 记忆层 · 检索与上下文注入
 */
import type { MemoryEntry, MemoryStore } from "./store.ts";
import { estimateTokens } from "../models/base.ts";

export interface Retrieved {
  entry: MemoryEntry;
  score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。.!！?？、;；:：/\\()\[\]{}"']+/)
    .filter((w) => w.length > 1);
}

/** 关键词 + 标签 + 新近度打分，无第三方向量库，接口可替换。 */
export function retrieve(store: MemoryStore, query: string, limit = 5): Retrieved[] {
  const q = new Set(tokenize(query));
  const scored: Retrieved[] = [];
  for (const e of store.list()) {
    const words = new Set(tokenize(`${e.key} ${e.content} ${e.tags.join(" ")}`));
    let overlap = 0;
    for (const w of q) if (words.has(w)) overlap += 2;
    for (const t of e.tags) if (q.has(t.toLowerCase())) overlap += 3;
    if (e.key.toLowerCase().includes(query.toLowerCase().slice(0, 8))) overlap += 2;
    if (overlap > 0) scored.push({ entry: e, score: overlap });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 生成可注入系统提示的记忆片段，受 token 预算约束。 */
export function buildMemoryInjection(store: MemoryStore, query: string, maxTokens = 800): string {
  const hits = retrieve(store, query, 6);
  if (hits.length === 0) return "";
  const lines: string[] = ["以下是与当前任务相关的长期/工作记忆："];
  let used = estimateTokens(lines[0]!);
  for (const h of hits) {
    const line = `- [${h.entry.kind}] ${h.entry.key}: ${h.entry.content.slice(0, 240)}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
