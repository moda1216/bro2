/**
 * W2 · repomap：零依赖符号索引
 * ----------------------------------------------------------
 * 目标不是「完整 AST」，而是让模型在**预算内**看清仓库骨架：
 *  - 有哪些文件、每个文件导出什么、谁依赖谁；
 *  - 输出有硬预算（默认 1200 tokens ≈ 4800 字符），超了先丢低入度文件；
 *  - 只用正则与缩进启发式，不引入 tree-sitter（运行时依赖恒为 0）。
 *
 * 明确不做的：类型推断、跨文件符号解析、宏/装饰器语义。做不准就别假装。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "__pycache__", "coverage", ".next"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

export interface RepoMapEntry {
  /** 相对仓库根的路径（统一用 /） */
  path: string;
  symbols: string[];
  /** 解析后的仓库内相对路径依赖 */
  imports: string[];
  /** 被多少个文件引用（决定摘要排序） */
  importedBy: number;
  bytes: number;
}

export interface ScanOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  /** 额外忽略的目录名 */
  ignore?: string[];
}

function walk(dir: string, root: string, out: string[], opts: Required<ScanOptions>): void {
  if (out.length >= opts.maxFiles) return;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= opts.maxFiles) return;
    if (e.name.startsWith(".") && e.name !== ".") continue;
    if (SKIP_DIRS.has(e.name) || opts.ignore.includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, root, out, opts);
      continue;
    }
    if (!CODE_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) continue;
    try {
      if (statSync(full).size <= opts.maxBytesPerFile) out.push(relative(root, full).split("\\").join("/"));
    } catch {
      /* 读不到就跳过，索引不是审计 */
    }
  }
}

/** 提取导出符号：TS/JS 的 export 声明 + Python 顶层 def/class。 */
export function extractSymbols(text: string, ext: string): string[] {
  const out = new Set<string>();
  if (ext === ".py") {
    for (const m of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) out.add(m[1]!);
    return [...out];
  }
  for (const m of text.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.add(m[1]!);
  }
  // export { a, b as c } —— 只取名字，忽略别名后的新名（够用即可）
  for (const m of text.matchAll(/^\s*export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return [...out];
}

/** 提取相对导入说明符；只保留仓库内的边。 */
export function extractImports(text: string, ext: string): string[] {
  const out = new Set<string>();
  if (ext === ".py") {
    // 绝对导入（from dates import x）同样可能指向仓库内模块，必须解析，否则入度排序失真。
    for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import/gm)) out.add(m[1]!);
    return [...out];
  }
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) out.add(m[1]!);
  return [...out];
}

/** 把导入说明符解析为仓库内文件（按常见扩展名与 index 文件补齐）。 */
function resolveImport(fromPath: string, spec: string, known: Set<string>): string | null {
  const base = spec.startsWith(".") && fromPath.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/"))
    : "";
  const segs = spec.split("/");
  const parts = base ? base.split("/") : [];
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  const p = parts.join("/");
  const candidates = [
    p, `${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}.jsx`, `${p}.mjs`, `${p}.py`,
    `${p}/index.ts`, `${p}/index.js`, `${p}/__init__.py`,
  ];
  return candidates.find((c) => known.has(c)) ?? null;
}

export function scanRepo(root: string, options: ScanOptions = {}): RepoMapEntry[] {
  const opts: Required<ScanOptions> = {
    maxFiles: options.maxFiles ?? 400,
    maxBytesPerFile: options.maxBytesPerFile ?? 200_000,
    ignore: options.ignore ?? [],
  };
  const paths: string[] = [];
  walk(root, root, paths, opts);
  const known = new Set(paths);
  const entries: RepoMapEntry[] = [];
  for (const path of paths) {
    let text = "";
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const ext = path.slice(path.lastIndexOf("."));
    const imports = extractImports(text, ext)
      .map((s) => resolveImport(path, s, known))
      .filter((x): x is string => x !== null);
    entries.push({ path, symbols: extractSymbols(text, ext), imports, importedBy: 0, bytes: text.length });
  }
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const e of entries) for (const dep of e.imports) {
    const target = byPath.get(dep);
    if (target) target.importedBy += 1;
  }
  return entries;
}

/** token 粗估：中英混排按 4 字符 ≈ 1 token（宁可高估，避免撑爆上下文）。 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * 渲染预算受限的树状摘要。
 * 排序：被引用次数降序 → 路径升序；预算不够时丢尾部文件并显式标注「已省略 N 个」。
 */
export function renderRepoMap(entries: readonly RepoMapEntry[], budgetTokens = 1200): string {
  const budget = budgetTokens * 4;
  const listed = [...entries].sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path));
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const e of listed) {
    const head = `${e.path}${e.importedBy > 0 ? ` (←${e.importedBy})` : ""}`;
    const syms = e.symbols.length > 0 ? `\n  ${e.symbols.slice(0, 12).join(", ")}${e.symbols.length > 12 ? " …" : ""}` : "";
    const block = head + syms;
    if (used + block.length + 1 > budget) {
      omitted += 1;
      continue;
    }
    lines.push(block);
    used += block.length + 1;
  }
  if (omitted > 0) lines.push(`… 已省略 ${omitted} 个文件（预算 ${budgetTokens} tokens）`);
  return lines.join("\n");
}

/** 一步到位：扫描 + 渲染。供工具与评测共用。 */
export function buildRepoMap(root: string, budgetTokens = 1200, options: ScanOptions = {}): string {
  return renderRepoMap(scanRepo(root, options), budgetTokens);
}
