/**
 * 内置工具 · 代码感知 ACI（W2）
 * ----------------------------------------------------------
 * 与 file_* 的分工：
 *  - `file_read` 读全文，适合目标已明确；
 *  - `repo_map` 看骨架（预算受限），适合「先定位再读」；
 *  - `search_symbol` 查符号定义/引用位置，适合「知道名字但不知道在哪」。
 * 三者都只读，写操作仍走 `file_write` / `file_edit`（后续 apply_patch）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, RiskLevel } from "../registry.ts";
import type { ToolDef } from "../registry.ts";
import type { PermissionPolicy } from "../../governance/permissions.ts";
import { buildRepoMap, scanRepo } from "../../context/repomap.ts";
import { applyPatch, formatPatchResult } from "../patch.ts";
import { formatDiagnostics, runDiagnostics } from "../diagnostics.ts";

function rootOf(ctx: { runtime: import("../../kernel/runtime.ts").Runtime }, path?: string): string {
  const policy = ctx.runtime.require<PermissionPolicy>("permissions");
  const v = policy.validatePath(path ?? ".");
  if (!v.ok) throw new Error(v.reason);
  return v.resolved;
}

export const repoMap = defineTool({
  name: "repo_map",
  description:
    "输出仓库骨架：文件 → 导出符号 → 被引用次数。适合在动代码前先定位，避免逐个文件通读。" +
    "输出有 token 预算（默认 1200），超预算会先省略低引用文件。",
  risk: RiskLevel.Safe,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "仓库/子目录相对路径，缺省为工作区根", default: "." },
      budget: { type: "number", description: "token 预算，默认 1200", default: 1200 },
    },
    required: [],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const root = rootOf(ctx, args.path);
    const budget = Math.min(4000, Math.max(200, Number(args.budget) || 1200));
    const text = buildRepoMap(root, budget);
    return text || "（未发现可索引的代码文件）";
  },
});

export const searchSymbol = defineTool({
  name: "search_symbol",
  description:
    "按符号名在仓库内查找定义与引用位置，返回 `路径:行号: 内容`。用于「知道名字但不知道在哪」，比全文搜索更省 token。",
  risk: RiskLevel.Safe,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "符号名（区分大小写）" },
      path: { type: "string", description: "搜索根目录，缺省为工作区根", default: "." },
      limit: { type: "number", description: "最多返回条数，默认 30，上限 100", default: 30 },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const name = String(args.name ?? "").trim();
    if (!name) return "请提供符号名";
    const root = rootOf(ctx, args.path);
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const hits: string[] = [];
    for (const entry of scanRepo(root)) {
      let text: string;
      try {
        text = readFileSync(join(root, entry.path), "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (!pattern.test(lines[i]!)) continue;
        hits.push(`${entry.path}:${i + 1}: ${lines[i]!.trim().slice(0, 120)}`);
        if (hits.length >= limit) break;
      }
      if (hits.length >= limit) break;
    }
    if (hits.length === 0) return `未找到符号 "${name}"`;
    return `${hits.length >= limit ? `（已达上限 ${limit} 条）\n` : ""}${hits.join("\n")}`;
  },
});

export const applyPatchTool = defineTool({
  name: "apply_patch",
  description:
    "按 unified diff 修改文件（可多文件、多块）。比 file_edit 更适合一次改多处：" +
    "补丁块按内容匹配定位，不依赖行号；失败会返回最接近的行号与原因，且**一个字节都不会写**。" +
    "新建文件用 `--- /dev/null`。改前建议先 repo_map / file_read 确认上下文。",
  risk: RiskLevel.Write,
  pathArgs: [],
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "unified diff 文本（@@ hunk 格式）" },
      dry_run: { type: "boolean", description: "只校验不写盘，默认 false", default: false },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const root = rootOf(ctx);
    const r = applyPatch(root, String(args.patch ?? ""), { dryRun: args.dry_run === true });
    return formatPatchResult(r, args.dry_run === true);
  },
});

export const diagnosticsTool = defineTool({
  name: "diagnostics",
  description:
    "在当前仓库跑测试/类型检查，并把结果解析成「哪个测试、哪一行、什么错」。改完代码后用它自检，" +
    "比读完整测试输出省 token。未识别项目类型时可显式传 command。",
  risk: RiskLevel.Write,
  pathArgs: ["path"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "仓库/子目录相对路径，缺省为工作区根", default: "." },
      command: { type: "string", description: "覆盖自动检测的命令（可选）" },
    },
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 150_000,
  handler: async (args, ctx) => {
    const root = rootOf(ctx, args.path);
    const command = typeof args.command === "string" && args.command.trim() ? args.command : undefined;
    return formatDiagnostics(await runDiagnostics(root, { command }));
  },
});

export const CODE_TOOLS: readonly ToolDef[] = [repoMap, searchSymbol, applyPatchTool, diagnosticsTool];
