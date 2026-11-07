/**
 * L6 治理层 · 三级沙箱与权限策略
 *
 * 如实标注：这是应用层路径白名单沙箱，不是 OS 级隔离（bwrap/Landlock/Seatbelt）。
 */
import { resolve, sep, isAbsolute, relative, normalize } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import type { ToolDef } from "../tools/registry.ts";
import { RiskLevel } from "../tools/registry.ts";

export const PermissionLevel = {
  ReadOnly: "read-only",
  WorkspaceWrite: "workspace-write",
  DangerFullAccess: "danger-full-access",
} as const;
export type PermissionLevel = (typeof PermissionLevel)[keyof typeof PermissionLevel];

export const Decision = {
  Allow: "allow",
  Deny: "deny",
  Ask: "ask",
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

export interface PermissionCheck {
  decision: Decision;
  reason: string;
  /** 被判定越界的路径参数。 */
  violations: string[];
}

/** 高危命令模式：命中即提升为审批或拒绝。 */
const DANGEROUS_COMMAND = [
  /\brm\s+-[a-z]*r[a-z]*f/i,
  /\b(sudo|mkfs|dd\s+if=|format)\b/i,
  />\s*\/etc\//,
  /\bchmod\s+-R\s+777/i,
  /\b(shutdown|reboot|halt)\b/i,
  /:\(\)\s*\{\s*:\|:/,
];

export class PermissionPolicy {
  private readonly level: PermissionLevel;
  private readonly workspace: string;
  private readonly allowedPaths: string[];
  private readonly autoApproveSafe: boolean;

  constructor(options: {
    level: PermissionLevel;
    workspace: string;
    allowedPaths: readonly string[];
    autoApproveSafe?: boolean;
  }) {
    this.level = options.level;
    this.workspace = resolve(options.workspace);
    this.allowedPaths = options.allowedPaths.map((p) => resolve(p));
    this.autoApproveSafe = options.autoApproveSafe ?? true;
  }

  get currentLevel(): PermissionLevel {
    return this.level;
  }

  get root(): string {
    return this.workspace;
  }

  /** 解析用户/模型给的路径，并强制约束在白名单内（防 .. 逃逸与 symlink 逃逸）。 */
  validatePath(input: string): { ok: boolean; resolved: string; reason: string } {
    if (!input || typeof input !== "string") return { ok: false, resolved: "", reason: "路径为空" };
    if (input.includes("\0")) return { ok: false, resolved: "", reason: "路径包含空字节" };
    let target = resolve(this.workspace, input);
    // 绝对路径必须已经落在白名单内；不做静默重定向，避免产生歧义
    if (isAbsolute(input) && !this.isWithinAllowed(target)) {
      return { ok: false, resolved: target, reason: `绝对路径越出沙箱白名单: ${input}` };
    }
    // 已存在的父目录做 realpath，阻断符号链接逃逸
    try {
      const parent = resolve(target, "..");
      if (existsSync(parent)) {
        const realParent = realpathSync(parent);
        const resolvedReal = resolve(realParent, target.slice(target.lastIndexOf(sep) + 1));
        if (!this.isWithinAllowed(resolvedReal)) {
          return { ok: false, resolved: target, reason: "符号链接指向白名单之外" };
        }
      }
    } catch {
      return { ok: false, resolved: target, reason: "无法解析路径" };
    }
    if (!this.isWithinAllowed(target)) {
      return { ok: false, resolved: target, reason: `路径越出沙箱白名单 (${this.allowedPaths.join(", ")})` };
    }
    return { ok: true, resolved: target, reason: "在白名单内" };
  }

  private isWithinAllowed(target: string): boolean {
    const norm = normalize(target);
    return this.allowedPaths.some((base) => {
      const rel = relative(base, norm);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  }

  check(tool: ToolDef, args: Record<string, unknown>): PermissionCheck {
    const violations: string[] = [];

    // 1) 路径沙箱（对所有声明了 pathArgs 的工具，包括只读工具）
    for (const key of tool.pathArgs ?? []) {
      const raw = args[key];
      if (typeof raw === "string") {
        const v = this.validatePath(raw);
        if (!v.ok) violations.push(`${key}=${raw}: ${v.reason}`);
      }
    }
    if (violations.length > 0) {
      return { decision: Decision.Deny, reason: `路径越界被硬拦截: ${violations.join("; ")}`, violations };
    }

    // 2) 高危命令检测
    const commandArg = args.command ?? args.cmd ?? args.script;
    if (typeof commandArg === "string" && DANGEROUS_COMMAND.some((r) => r.test(commandArg))) {
      if (this.level === PermissionLevel.DangerFullAccess) {
        return { decision: Decision.Ask, reason: "检测到高危命令，需人工确认", violations };
      }
      return { decision: Decision.Deny, reason: `高危命令在当前权限级别(${this.level})下被拒绝`, violations };
    }

    // 3) 按权限级别 × 风险等级决策
    if (this.level === PermissionLevel.DangerFullAccess) {
      return { decision: Decision.Allow, reason: "完全访问模式", violations };
    }
    if (tool.risk === RiskLevel.Danger) {
      return { decision: Decision.Ask, reason: `工具 ${tool.name} 标记为 danger，需人工审批`, violations };
    }
    if (this.level === PermissionLevel.ReadOnly && tool.risk !== RiskLevel.Safe) {
      return { decision: Decision.Deny, reason: `只读模式下禁止 ${tool.risk} 类工具`, violations };
    }
    if (tool.risk === RiskLevel.Safe && this.autoApproveSafe) {
      return { decision: Decision.Allow, reason: "安全工具自动放行", violations };
    }
    // workspace-write 下，路径已通过白名单校验的写操作放行
    return { decision: Decision.Allow, reason: `路径在白名单内，${this.level} 允许`, violations };
  }
}
