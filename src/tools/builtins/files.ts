/**
 * 内置工具 · 文件系统
 * 纵深防御：权限层已做白名单校验，工具内部再做一次 resolve，杜绝绕过。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { defineTool, RiskLevel } from "../registry.ts";
import type { ToolDef } from "../registry.ts";
import type { PermissionPolicy } from "../../governance/permissions.ts";
import { applyEdit, formatEditFailure } from "../edit-strategy.ts";

function resolveSafe(ctx: { runtime: import("../../kernel/runtime.ts").Runtime }, p: string): string {
  const policy = ctx.runtime.require<PermissionPolicy>("permissions");
  const v = policy.validatePath(p);
  if (!v.ok) throw new Error(v.reason);
  return v.resolved;
}

export const fileRead = defineTool({
  name: "file_read",
  description: "读取工作区内文本文件的内容。",
  risk: RiskLevel.Safe,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "相对工作区的文件路径" } },
    required: ["path"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const p = resolveSafe(ctx, args.path);
    if (!existsSync(p)) return `文件不存在: ${args.path}`;
    const s = statSync(p);
    if (s.isDirectory()) return `这是目录，请使用 file_list: ${args.path}`;
    const text = readFileSync(p, "utf8");
    return text.length > 30000 ? `${text.slice(0, 30000)}\n…[文件过大已截断]` : text;
  },
});

export const fileWrite = defineTool({
  name: "file_write",
  description: "把内容写入工作区文件（自动创建父目录）。用于生成报告、文档、代码等。",
  risk: RiskLevel.Write,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作区的文件路径" },
      content: { type: "string", description: "要写入的完整内容" },
      append: { type: "boolean", description: "是否追加而非覆盖", default: false },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const p = resolveSafe(ctx, args.path);
    mkdirSync(dirname(p), { recursive: true });
    if (args.append) {
      const prev = existsSync(p) ? readFileSync(p, "utf8") : "";
      writeFileSync(p, prev + args.content);
    } else {
      writeFileSync(p, args.content);
    }
    return `已写入 ${args.path}（${args.content.length} 字符）${args.append ? "，追加模式" : ""}`;
  },
});

export const fileList = defineTool({
  name: "file_list",
  description: "列出工作区目录内容。",
  risk: RiskLevel.Safe,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "目录路径，缺省为工作区根", default: "." } },
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const p = resolveSafe(ctx, args.path ?? ".");
    if (!existsSync(p)) return `目录不存在: ${args.path}`;
    if (!statSync(p).isDirectory()) return `不是目录: ${args.path}`;
    const rows = readdirSync(p).slice(0, 200).map((f) => {
      const full = join(p, f);
      try {
        const s = statSync(full);
        return `${s.isDirectory() ? "d" : "-"} ${String(s.size).padStart(8)} ${f}`;
      } catch {
        return `? ${f}`;
      }
    });
    return `目录 ${args.path ?? "."} (${rows.length} 项):\n${rows.join("\n")}`;
  },
});

export const fileEdit = defineTool({
  name: "file_edit",
  description: "在文件中替换一段文本（精确匹配，只替换第一次出现）。",
  risk: RiskLevel.Write,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_text: { type: "string", description: "要被替换的原文" },
      new_text: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const p = resolveSafe(ctx, args.path);
    if (!existsSync(p)) return `文件不存在: ${args.path}`;
    const text = readFileSync(p, "utf8");
    const r = applyEdit(text, args.old_text, args.new_text);
    if (!r.ok) return formatEditFailure(r);
    writeFileSync(p, r.text);
    return `已替换 ${args.path} 中的文本${r.note}`;
  },
});

export const fileDelete = defineTool({
  name: "file_delete",
  description: "删除工作区内文件（危险操作，会触发人工审批）。",
  risk: RiskLevel.Danger,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "要删除的文件路径" } },
    required: ["path"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const p = resolveSafe(ctx, args.path);
    if (!existsSync(p)) return `文件不存在: ${args.path}`;
    if (statSync(p).isDirectory()) return "不能删除目录，请指定文件";
    unlinkSync(p);
    return `已删除 ${args.path}`;
  },
});

export const searchFiles = defineTool({
  name: "search_files",
  description: "在工作区文件中搜索文本/正则，返回匹配行。跳过 node_modules、.git 与二进制文件。",
  risk: RiskLevel.Safe,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "要搜索的字符串或正则表达式" },
      path: { type: "string", description: "搜索起始目录", default: "." },
      max_results: { type: "integer", description: "最大返回条数", default: 30, minimum: 1, maximum: 200 },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const root = resolveSafe(ctx, args.path ?? ".");
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, "i");
    } catch {
      re = new RegExp(escapeRegex(args.pattern), "i");
    }
    const limit = args.max_results ?? 30;
    const hits: string[] = [];
    const skip = new Set(["node_modules", ".git", ".codebuddy", "dist", "build"]);
    const walk = (dir: string): void => {
      if (hits.length >= limit || !existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        if (hits.length >= limit) break;
        if (skip.has(f)) continue;
        const full = join(dir, f);
        let s;
        try { s = statSync(full); } catch { continue; }
        if (s.isDirectory()) { walk(full); continue; }
        if (s.size > 512000) continue;
        let text: string;
        try { text = readFileSync(full, "utf8"); } catch { continue; }
        if (text.includes("\0")) continue;
        text.split("\n").forEach((line, i) => {
          if (hits.length < limit && re.test(line)) {
            hits.push(`${relative(root, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    };
    walk(root);
    return hits.length > 0 ? `找到 ${hits.length} 条匹配:\n${hits.join("\n")}` : `未找到匹配: ${args.pattern}`;
  },
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const FILE_TOOLS: ToolDef[] = [fileRead, fileWrite, fileList, fileEdit, fileDelete, searchFiles];
