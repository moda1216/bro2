/**
 * L3 记忆层 · 三层记忆（短期 / 长期 / 工作记忆）
 *
 * 长期记忆跨会话持久化到 JSON；工作记忆是可随时读写的 scratchpad；
 * 短期记忆即会话消息，由 Trajectory 承担，不重复存储（单一数据源原则）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../kernel/events.ts";

export const MemoryKind = {
  Long: "long",
  Working: "working",
} as const;
export type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  key: string;
  content: string;
  tags: string[];
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export class MemoryStore {
  private readonly dir: string;
  private readonly longPath: string;
  private readonly scratchDir: string;
  private readonly long: Map<string, MemoryEntry>;

  constructor(dir: string) {
    this.dir = dir;
    this.longPath = join(dir, "long-term.json");
    this.scratchDir = join(dir, "scratch");
    mkdirSync(dir, { recursive: true });
    mkdirSync(this.scratchDir, { recursive: true });
    this.long = new Map<string, MemoryEntry>();
    if (existsSync(this.longPath)) {
      try {
        const arr = JSON.parse(readFileSync(this.longPath, "utf8")) as MemoryEntry[];
        for (const e of arr) this.long.set(e.key, e);
      } catch {
        // 损坏的记忆文件不阻塞启动
      }
    }
  }

  put(kind: MemoryKind, key: string, content: string, tags: string[] = [], sessionId?: string): MemoryEntry {
    const now = new Date().toISOString();
    const existing = kind === MemoryKind.Long ? this.long.get(key) : undefined;
    const entry: MemoryEntry = {
      id: existing?.id ?? newId("mem"),
      kind,
      key,
      content,
      tags,
      ...(sessionId ? { sessionId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (kind === MemoryKind.Long) {
      this.long.set(key, entry);
      this.flush();
    } else {
      writeFileSync(this.scratchPath(sessionId ?? "global", key), content);
    }
    return entry;
  }

  get(kind: MemoryKind, key: string, sessionId?: string): MemoryEntry | undefined {
    if (kind === MemoryKind.Long) return this.long.get(key);
    const p = this.scratchPath(sessionId ?? "global", key);
    if (!existsSync(p)) return undefined;
    const now = new Date().toISOString();
    return {
      id: `scratch:${key}`,
      kind: MemoryKind.Working,
      key,
      content: readFileSync(p, "utf8"),
      tags: ["scratch"],
      createdAt: now,
      updatedAt: now,
    };
  }

  delete(kind: MemoryKind, key: string, sessionId?: string): boolean {
    if (kind === MemoryKind.Long) {
      const ok = this.long.delete(key);
      this.flush();
      return ok;
    }
    const p = this.scratchPath(sessionId ?? "global", key);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }

  list(kind?: MemoryKind, sessionId?: string): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    if (!kind || kind === MemoryKind.Long) out.push(...this.long.values());
    if (!kind || kind === MemoryKind.Working) {
      for (const f of readdirSync(this.scratchDir)) {
        if (!f.endsWith(".md")) continue;
        if (sessionId && !f.startsWith(`${sanitize(sessionId)}__`)) continue;
        out.push({
          id: `scratch:${f}`,
          kind: MemoryKind.Working,
          key: f.replace(/\.md$/, ""),
          content: readFileSync(join(this.scratchDir, f), "utf8"),
          tags: ["scratch"],
          createdAt: "",
          updatedAt: "",
        });
      }
    }
    return out;
  }

  appendScratch(sessionId: string, key: string, text: string): string {
    const p = this.scratchPath(sessionId, key);
    const prev = existsSync(p) ? readFileSync(p, "utf8") : "";
    const next = `${prev}${text}\n`;
    writeFileSync(p, next);
    return next;
  }

  private scratchPath(sessionId: string, key: string): string {
    return join(this.scratchDir, `${sanitize(sessionId)}__${sanitize(key)}.md`);
  }

  private flush(): void {
    const tmp = `${this.longPath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.long.values()], null, 2));
    renameSync(tmp, this.longPath);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]/g, "_").slice(0, 60);
}
