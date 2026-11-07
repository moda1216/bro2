/**
 * L0 内核 · 会话生命周期（创建 / 恢复 / 分叉 / 自动标题）
 *
 * Session 的唯一真相是 Trajectory；meta.json 只是可重建的索引。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Trajectory } from "./trajectory.ts";
import { newId } from "./events.ts";
import type { Message } from "./events.ts";

export const SessionStatus = {
  Active: "active",
  Paused: "paused",
  Done: "done",
  Error: "error",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export interface SessionMeta {
  id: string;
  title: string;
  preset: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  trajectoryPath: string;
  parentId?: string;
  forkAtSeq?: number;
  turns: number;
}

export class Session {
  readonly meta: SessionMeta;
  readonly trajectory: Trajectory;
  private readonly manager: SessionManager;

  constructor(meta: SessionMeta, trajectory: Trajectory, manager: SessionManager) {
    this.meta = meta;
    this.trajectory = trajectory;
    this.manager = manager;
  }

  get id(): string {
    return this.meta.id;
  }

  get preset(): string {
    return this.meta.preset;
  }

  /** Preset 一旦有内容即锁定，否则历史里的工具调用无法解释。 */
  get locked(): boolean {
    return this.trajectory.events().length > 0;
  }

  messages(): Message[] {
    return this.trajectory.messages();
  }

  touch(status?: SessionStatus, turns?: number): void {
    this.meta.updatedAt = new Date().toISOString();
    if (status) this.meta.status = status;
    if (turns !== undefined) this.meta.turns = turns;
    this.manager.save(this.meta);
  }

  autoTitle(text: string): void {
    if (this.meta.title !== "新会话") return;
    const clean = text.replace(/\s+/g, " ").trim();
    this.meta.title = clean.length > 28 ? `${clean.slice(0, 28)}…` : clean || "新会话";
    this.manager.save(this.meta);
  }

  close(): void {
    this.trajectory.close();
  }
}

export class SessionManager {
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(baseDir, { recursive: true });
  }

  private metaPath(id: string): string {
    return join(this.baseDir, `${id}.meta.json`);
  }

  private trajPath(id: string): string {
    return join(this.baseDir, `${id}.jsonl`);
  }

  create(preset = "standard", title = "新会话"): Session {
    const id = newId("s");
    const meta: SessionMeta = {
      id,
      title,
      preset,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: SessionStatus.Active,
      trajectoryPath: this.trajPath(id),
      turns: 0,
    };
    const traj = new Trajectory(meta.trajectoryPath);
    this.save(meta);
    return new Session(meta, traj, this);
  }

  get(id: string): Session | undefined {
    const p = this.metaPath(id);
    if (!existsSync(p)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(p, "utf8")) as SessionMeta;
      const traj = new Trajectory(meta.trajectoryPath);
      return new Session(meta, traj, this);
    } catch {
      return undefined;
    }
  }

  resume(id: string): Session | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    s.touch(SessionStatus.Active);
    return s;
  }

  fork(id: string, uptoSeq?: number): Session | undefined {
    const parent = this.get(id);
    if (!parent) return undefined;
    const childId = newId("s");
    const childTrajPath = this.trajPath(childId);
    parent.trajectory.fork(childTrajPath, uptoSeq);
    const meta: SessionMeta = {
      id: childId,
      title: `${parent.meta.title} (分支)`,
      preset: parent.meta.preset,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: SessionStatus.Active,
      trajectoryPath: childTrajPath,
      parentId: parent.id,
      ...(uptoSeq !== undefined ? { forkAtSeq: uptoSeq } : {}),
      turns: parent.meta.turns,
    };
    this.save(meta);
    parent.close();
    return new Session(meta, new Trajectory(childTrajPath), this);
  }

  list(): SessionMeta[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.baseDir, f), "utf8")) as SessionMeta;
        } catch {
          return undefined;
        }
      })
      .filter((m): m is SessionMeta => m !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(meta: SessionMeta): void {
    const tmp = `${this.metaPath(meta.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, this.metaPath(meta.id));
  }
}
