/**
 * bro2 · 只增账本（archive）与 incident log
 *
 * 对齐 Darwin Gödel Machine：保留**所有**候选（含被拒与"垫脚石"），
 * 而不是只留一条最优链；支持从任意已记录状态复核与分叉。
 * 采用与 Trajectory 一致的原子追加 + fsync + 残缺末行容错。
 */
import {
  openSync, writeSync, fsyncSync, closeSync,
  existsSync, readFileSync, mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LedgerEntry, Incident, Patch } from "./types.ts";

function atomicAppend(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  // 崩溃可能留下半行 JSON：丢弃末行而不是让整个账本不可读
  if (text.length > 0 && !text.endsWith("\n") && lines.length > 0) lines.pop();
  return lines;
}

export interface OperatorStats {
  promoted: number;
  rejected: number;
  blocked: number;
}

export class Ledger {
  readonly path: string;
  private seq = 0;

  constructor(path: string) {
    this.path = path;
    this.seq = readLines(path).length;
  }

  append(entry: Omit<LedgerEntry, "seq" | "ts">): LedgerEntry {
    const full: LedgerEntry = {
      seq: this.seq,
      ts: new Date().toISOString(),
      ...entry,
    };
    this.seq += 1;
    atomicAppend(this.path, JSON.stringify(full));
    return full;
  }

  entries(): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const line of readLines(this.path)) {
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // 单条损坏不影响账本整体可读
      }
    }
    return out;
  }

  count(): number {
    return this.seq;
  }

  /** 按算子聚合实证成败，作为改进策略（搜索先验）的唯一输入。 */
  stats(): Record<string, OperatorStats> {
    const out: Record<string, OperatorStats> = {};
    for (const e of this.entries()) {
      const name = e.patch.operator;
      if (name === "(meta)" || name === "(genesis)") continue;
      const s = out[name] ?? { promoted: 0, rejected: 0, blocked: 0 };
      if (e.decision === "promoted") s.promoted += 1;
      else if (e.decision === "rejected") s.rejected += 1;
      else if (e.decision === "blocked") s.blocked += 1;
      out[name] = s;
    }
    return out;
  }

  /** 已被晋升过的状态 hash 集合，用于分叉/复核。 */
  promotedStates(): string[] {
    return this.entries().filter((e) => e.decision === "promoted").map((e) => e.stateHash);
  }
}

export class IncidentLog {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(i: Omit<Incident, "ts">): Incident {
    const full: Incident = { ts: new Date().toISOString(), ...i };
    atomicAppend(this.path, JSON.stringify(full));
    return full;
  }

  entries(): Incident[] {
    const out: Incident[] = [];
    for (const line of readLines(this.path)) {
      try {
        out.push(JSON.parse(line) as Incident);
      } catch {
        // ignore
      }
    }
    return out;
  }

  count(): number {
    return this.entries().length;
  }
}

/** 构造一个不改动任何状态的账本条目（genesis / meta 用）。 */
export function metaPatch(id: string, description: string): Patch {
  return {
    id,
    operator: "(meta)",
    target: "meta",
    description,
    changes: [],
    evidence: [],
  };
}

export function genesisPatch(): Patch {
  return {
    id: "genesis",
    operator: "(genesis)",
    target: "meta",
    description: "初始状态与保护面哈希快照",
    changes: [],
    evidence: [],
  };
}
