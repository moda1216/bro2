/**
 * L0 内核 · Trajectory（只增不改会话日志）
 *
 * 工业级要求：单次 writeSync 追加一行 + fsyncSync 落盘，崩溃后最多丢失
 * 最后一条未完成写入；读取时容忍残缺末行；支持回放 / 恢复 / 分叉 / 检索。
 */
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Event, EventDraft, EventType, Message, Usage } from "./events.ts";
import { eventsToMessages } from "./events.ts";

export interface TrajectoryStats {
  events: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  lastTs?: string;
  firstTs?: string;
}

export class Trajectory {
  readonly path: string;
  private fd: number;
  private seq: number;
  private closed = false;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.seq = 0;
    if (existsSync(path)) {
      for (const e of this.readRaw()) this.seq = Math.max(this.seq, e.seq);
    }
    this.fd = openSync(path, "a");
  }

  /** 原子追加一条事件。返回完整 Event（含 seq / ts）。 */
  append(draft: EventDraft): Event {
    if (this.closed) throw new Error(`Trajectory 已关闭: ${this.path}`);
    this.seq += 1;
    const event: Event = {
      seq: this.seq,
      ts: new Date().toISOString(),
      ...draft,
    };
    const line = JSON.stringify(event) + "\n";
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    return event;
  }

  /** 读取全部合法事件；残缺的最后一行会被跳过（崩溃恢复）。 */
  private readRaw(): Event[] {
    if (!existsSync(this.path)) return [];
    const buf = readFileSync(this.path, "utf8");
    const out: Event[] = [];
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Event;
        if (typeof obj.seq === "number" && typeof obj.type === "string") out.push(obj);
      } catch {
        // 残缺末行：忽略
      }
    }
    return out;
  }

  events(): Event[] {
    return this.readRaw();
  }

  messages(): Message[] {
    return eventsToMessages(this.events());
  }

  ofType(type: EventType): Event[] {
    return this.events().filter((e) => e.type === type);
  }

  search(keyword: string, limit = 20): Event[] {
    const k = keyword.toLowerCase();
    return this.events()
      .filter((e) => JSON.stringify(e.payload).toLowerCase().includes(k))
      .slice(-limit);
  }

  /** 分叉：复制日志前缀到新文件，返回新 Trajectory。原会话不受影响。 */
  fork(newPath: string, uptoSeq?: number): Trajectory {
    mkdirSync(dirname(newPath), { recursive: true });
    const lines = this.events()
      .filter((e) => uptoSeq === undefined || e.seq <= uptoSeq)
      .map((e) => JSON.stringify(e) + "\n")
      .join("");
    // 先写临时文件再原子替换，避免分叉出半成品
    const tmp = `${newPath}.tmp`;
    writeFileSync(tmp, lines);
    renameSync(tmp, newPath);
    return new Trajectory(newPath);
  }

  stats(): TrajectoryStats {
    const all = this.events();
    let toolCalls = 0;
    let toolErrors = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const e of all) {
      if (e.type === "tool.call") toolCalls += 1;
      if (e.type === "tool.result" && (e.payload.result as { ok?: boolean } | undefined)?.ok === false) toolErrors += 1;
      const u = e.usage as Usage | undefined;
      if (u) {
        inputTokens += u.inputTokens;
        outputTokens += u.outputTokens;
      }
    }
    return {
      events: all.length,
      toolCalls,
      toolErrors,
      inputTokens,
      outputTokens,
      ...(all.length > 0 ? { firstTs: all[0]!.ts, lastTs: all[all.length - 1]!.ts } : {}),
    };
  }

  get sizeBytes(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  get lastSeq(): number {
    return this.seq;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fsyncSync(this.fd);
    } catch {
      // fd 可能已失效
    }
    try {
      closeSync(this.fd);
    } catch {
      // ignore
    }
  }
}

/** 工具结果 / 事件写入时统一裁剪超长输出，避免打爆上下文。 */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n…[已截断 ${text.length - maxChars} 字符]`,
    truncated: true,
  };
}

