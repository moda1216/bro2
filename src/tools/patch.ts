/**
 * W2-02 · unified diff 应用器
 * ----------------------------------------------------------
 * 为什么不是「再包一层 patch(1)」：
 *  - 需要结构化失败原因（哪一块、期望什么、最接近哪一行），否则模型只能瞎猜；
 *  - 需要路径越界防护（补丁文本来自模型，不可信）；
 *  - 需要在无 git 的隔离工作区里可用。
 *
 * 支持的 diff 子集（够模型用，且能说清边界）：
 *  - `--- a/x` / `+++ b/x`，多文件；
 *  - `@@ -l,c +l,c @@`，一个 hunk 内可含上下文/增/删；
 *  - `--- /dev/null` 新建文件；
 *  - 不支持二进制、重命名、mode 变更——遇到就明确报错，不静默忽略。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

export interface Hunk {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

export interface FilePatch {
  path: string;
  hunks: Hunk[];
  create: boolean;
}

export interface PatchError {
  path: string;
  hunk: number;
  reason: string;
  /** 最接近的实际行号（1-based），没有则为 0 */
  nearestLine: number;
  nearestText: string;
}

export interface PatchResult {
  ok: boolean;
  applied: Array<{ path: string; hunks: number; created: boolean }>;
  errors: PatchError[];
}

function stripPrefix(p: string): string {
  const s = p.trim().split("\t")[0]!;
  return s.replace(/^[ab]\//, "");
}

export function parsePatch(text: string): { files: FilePatch[]; errors: string[] } {
  const lines = text.split("\n");
  const files: FilePatch[] = [];
  const errors: string[] = [];
  let cur: FilePatch | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("--- ")) {
      const oldPath = stripPrefix(line.slice(4));
      const next = lines[i + 1] ?? "";
      if (!next.startsWith("+++ ")) {
        errors.push(`第 ${i + 1} 行: "--- " 之后缺少 "+++ "`);
        i += 1;
        continue;
      }
      const newPath = stripPrefix(next.slice(4));
      const create = oldPath === "/dev/null";
      const path = create ? newPath : newPath || oldPath;
      if (!path || path === "/dev/null") {
        errors.push(`第 ${i + 1} 行: 无法确定目标路径`);
        i += 2;
        continue;
      }
      cur = { path, hunks: [], create };
      files.push(cur);
      i += 2;
      continue;
    }
    if (line.startsWith("@@")) {
      if (!cur) {
        errors.push(`第 ${i + 1} 行: hunk 出现在文件头之前`);
        i += 1;
        continue;
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) {
        errors.push(`第 ${i + 1} 行: 无法解析 hunk 头 "${line.slice(0, 40)}"`);
        i += 1;
        continue;
      }
      const hunk: Hunk = { oldStart: Number(m[1]), oldLines: [], newLines: [] };
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("--- ")) {
        const l = lines[i]!;
        if (l.startsWith("\\")) { i += 1; continue; } // \ No newline at end of file
        if (l.startsWith("+")) hunk.newLines.push(l.slice(1));
        else if (l.startsWith("-")) hunk.oldLines.push(l.slice(1));
        else if (l === "") break; // 补丁文本末尾换行，不是上下文行（空上下文行写作单个空格）
        else if (l.startsWith(" ")) { hunk.oldLines.push(l.slice(1)); hunk.newLines.push(l.slice(1)); }
        else { errors.push(`第 ${i + 1} 行: hunk 内容缺少 +/-/空格 前缀`); }
        i += 1;
      }
      cur.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  for (const f of files) if (f.hunks.length === 0 && !f.create) errors.push(`文件 ${f.path}: 没有任何 hunk`);
  return { files, errors };
}

/** 在 target 中找 oldLines 的首次精确匹配；hint 只用于提前命中，不限制搜索范围。 */
function locate(target: readonly string[], oldLines: readonly string[], hint: number): number {
  if (oldLines.length === 0) return Math.min(hint, target.length);
  const at = (start: number): boolean => {
    if (start < 0 || start + oldLines.length > target.length) return false;
    for (let k = 0; k < oldLines.length; k += 1) if (target[start + k] !== oldLines[k]) return false;
    return true;
  };
  if (at(hint)) return hint;
  for (let s = 0; s + oldLines.length <= target.length; s += 1) if (at(s)) return s;
  return -1;
}

function nearest(target: readonly string[], needle: string): { line: number; text: string } {
  const key = needle.trim();
  for (let i = 0; i < target.length; i += 1) if (target[i]!.trim() === key) return { line: i + 1, text: target[i]!.slice(0, 120) };
  return { line: 0, text: "" };
}

/** 安全路径：拒绝绝对路径、`..` 越界与空段。 */
function safePath(root: string, p: string): string | null {
  if (!p || p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return null;
  const norm = normalize(p).split(sep).join("/");
  if (norm === ".." || norm.startsWith("../")) return null;
  return join(root, norm);
}

export function applyPatch(root: string, text: string, opts: { dryRun?: boolean } = {}): PatchResult {
  const parsed = parsePatch(text);
  const errors: PatchError[] = parsed.errors.map((reason) => ({ path: "-", hunk: 0, reason, nearestLine: 0, nearestText: "" }));
  const applied: PatchResult["applied"] = [];
  /** 两阶段：先全部计算成功，再统一写盘——避免「前 2 个文件改了、第 3 个失败」的半成品状态。 */
  const pending: Array<{ full: string; content: string }> = [];

  for (const fp of parsed.files) {
    const full = safePath(root, fp.path);
    if (!full) {
      errors.push({ path: fp.path, hunk: 0, reason: "非法路径（不允许绝对路径或 .. 越界）", nearestLine: 0, nearestText: "" });
      continue;
    }
    if (!fp.create && !existsSync(full)) {
      errors.push({ path: fp.path, hunk: 0, reason: "文件不存在（新建请用 /dev/null 形式）", nearestLine: 0, nearestText: "" });
      continue;
    }
    const original = fp.create ? [] : readFileSync(full, "utf8").split("\n");
    const target = [...original];
    let cursor = 0;
    let failed = false;
    for (const [idx, h] of fp.hunks.entries()) {
      const hint = Math.max(0, h.oldStart - 1);
      const at = locate(target, h.oldLines, Math.max(cursor, hint));
      if (at < 0) {
        const near = nearest(target, h.oldLines[0] ?? "");
        errors.push({
          path: fp.path,
          hunk: idx + 1,
          reason: `补丁块未匹配：期望首行 ${JSON.stringify((h.oldLines[0] ?? "").slice(0, 100))}`,
          nearestLine: near.line,
          nearestText: near.text,
        });
        failed = true;
        break;
      }
      target.splice(at, h.oldLines.length, ...h.newLines);
      cursor = at + h.newLines.length;
    }
    if (failed) continue;
    // 新建文件补一个行尾换行；修改文件则沿用 split/join 对原尾换行的保留行为。
    const content = target.join("\n");
    pending.push({ full, content: fp.create && !content.endsWith("\n") ? `${content}\n` : content });
    applied.push({ path: fp.path, hunks: fp.hunks.length, created: fp.create });
  }

  if (errors.length === 0 && !opts.dryRun) {
    for (const p of pending) {
      mkdirSync(dirname(p.full), { recursive: true });
      writeFileSync(p.full, p.content);
    }
  }
  // 任一文件失败 → 一个字节都不写，返回 ok:false，让调用方拿到干净的失败语义。
  return { ok: errors.length === 0, applied: errors.length === 0 ? applied : [], errors };
}

/** 人类/模型可读的结果摘要：失败必须带「下一步怎么做」。 */
export function formatPatchResult(r: PatchResult, dryRun: boolean): string {
  if (r.errors.length === 0) {
    const list = r.applied.map((a) => `${a.created ? "新建" : "修改"} ${a.path}（${a.hunks} 块）`).join("；");
    return `${dryRun ? "[dry-run] 可应用" : "已应用"}：${list || "（无变更）"}`;
  }
  const lines = [`补丁失败（${r.errors.length} 项），未写入任何文件：`];
  for (const e of r.errors) {
    lines.push(`- ${e.path} 第 ${e.hunk} 块：${e.reason}`);
    if (e.nearestLine > 0) lines.push(`  最接近 line ${e.nearestLine}: ${e.nearestText}`);
  }
  lines.push("下一步：用 file_read 读取上述位置，按实际内容重新生成补丁（上下文行必须逐字一致）。");
  return lines.join("\n");
}
