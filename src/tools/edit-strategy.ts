/**
 * W2-04 · 编辑降级链
 * ----------------------------------------------------------
 * `file_edit` 的失败绝大多数不是「模型不知道改什么」，而是「贴的原文差一个空格/缩进」。
 * 这里给出三级匹配，但有一条硬约束：**降级只在唯一命中时生效**。
 * 模糊匹配多处命中时宁可失败并报位置，也不猜——错改比不改更难发现。
 *
 * 每次降级都通过 `mode` 回传，最终写进 tool result（Trajectory 可归因）。
 */
export type EditMode = "exact" | "whitespace" | "block";

export interface EditOk {
  ok: true;
  text: string;
  mode: EditMode;
  /** 降级说明；exact 时为空 */
  note: string;
}

export interface EditFail {
  ok: false;
  reason: string;
  nearestLine: number;
  nearestText: string;
}

export type EditResult = EditOk | EditFail;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function nearestIn(text: string, needle: string): { line: number; text: string } {
  const key = needle.trim();
  if (!key) return { line: 0, text: "" };
  const lines = text.split("\n");
  let best = { line: 0, text: "" };
  let bestScore = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i]!.trim();
    if (t === key) return { line: i + 1, text: lines[i]!.slice(0, 140) };
    // 前缀匹配作为次优：给出「大概在这一行附近」
    let score = 0;
    while (score < key.length && score < t.length && key[score] === t[score]) score += 1;
    if (score > bestScore && score >= Math.min(8, Math.floor(key.length / 2))) {
      bestScore = score;
      best = { line: i + 1, text: lines[i]!.slice(0, 140) };
    }
  }
  return best;
}

/** 空白归一化：把原文的空白序列视为 \s+，只在唯一命中时替换。 */
function whitespaceMatch(text: string, oldText: string): { start: number; end: number } | "multiple" | null {
  const parts = oldText.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const pattern = new RegExp(parts.map(escapeRe).join("\\s+"), "g");
  const hits = [...text.matchAll(pattern)];
  if (hits.length === 0) return null;
  if (hits.length > 1) return "multiple";
  const m = hits[0]!;
  return { start: m.index!, end: m.index! + m[0].length };
}

/** 块级匹配：逐行 trim 比较连续块，唯一命中才算数。 */
function blockMatch(text: string, oldText: string): { startLine: number; endLine: number } | "multiple" | null {
  const target = oldText.split("\n").map((l) => l.trim()).filter((l, i, a) => !(l === "" && (i === 0 || i === a.length - 1)));
  if (target.length === 0) return null;
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0; i + target.length <= lines.length; i += 1) {
    let all = true;
    for (let k = 0; k < target.length; k += 1) {
      if (lines[i + k]!.trim() !== target[k]) { all = false; break; }
    }
    if (all) starts.push(i);
  }
  if (starts.length === 0) return null;
  if (starts.length > 1) return "multiple";
  return { startLine: starts[0]!, endLine: starts[0]! + target.length };
}

export function applyEdit(text: string, oldText: string, newText: string): EditResult {
  if (!oldText) return { ok: false, reason: "old_text 不能为空", nearestLine: 0, nearestText: "" };

  if (text.includes(oldText)) {
    const first = text.indexOf(oldText);
    // 精确匹配但出现多次：替换第一处极可能改错位置。宁可拒绝并报位置，让模型补充上下文。
    if (text.indexOf(oldText, first + 1) >= 0) {
      const n = nearestIn(text, oldText.split("\n")[0] ?? "");
      return {
        ok: false,
        reason: "old_text 在文件中出现多次，为避免改错已拒绝（请补充前后各一行上下文）",
        nearestLine: n.line,
        nearestText: n.text,
      };
    }
    return { ok: true, text: text.replace(oldText, newText), mode: "exact", note: "" };
  }

  const ws = whitespaceMatch(text, oldText);
  if (ws === "multiple") {
    const n = nearestIn(text, oldText.split("\n")[0] ?? "");
    return { ok: false, reason: "空白归一化后有多处匹配，请补充更多上下文", nearestLine: n.line, nearestText: n.text };
  }
  if (ws) {
    // 跨行替换时，new_text 的第二行起若没带缩进，补上匹配点所在行的缩进，
    // 否则「空白归一化」会把代码顶格——改对了内容却弄坏了结构。
    const lineStart = text.lastIndexOf("\n", ws.start - 1) + 1;
    const lead = text.slice(lineStart, ws.start);
    const indent = /^[ \t]*$/.test(lead) ? lead : "";
    const body = newText.split("\n");
    const needsIndent = indent.length > 0 && body.slice(1).some((l) => l !== "" && !/^[ \t]/.test(l));
    const repl = needsIndent ? body.map((l, i) => (i === 0 || l === "" ? l : indent + l)).join("\n") : newText;
    return {
      ok: true,
      text: text.slice(0, ws.start) + repl + text.slice(ws.end),
      mode: "whitespace",
      note: "（降级：空白差异已归一化）",
    };
  }

  const blk = blockMatch(text, oldText);
  if (blk === "multiple") {
    const n = nearestIn(text, oldText.split("\n")[0] ?? "");
    return { ok: false, reason: "按行去缩进后有多处匹配，请补充更多上下文", nearestLine: n.line, nearestText: n.text };
  }
  if (blk) {
    const lines = text.split("\n");
    // 仅当 new_text 自身没带缩进时才补目标块缩进，避免二次缩进
    const indent = /^[ \t]*/.exec(lines[blk.startLine] ?? "")![0];
    const body = newText.split("\n");
    const needsIndent = body.slice(1).every((l) => l === "" || !/^[ \t]/.test(l));
    const replacement = needsIndent
      ? body.map((l, i) => (i === 0 || l === "" ? l : indent + l)).join("\n")
      : newText;
    const out = [...lines.slice(0, blk.startLine), ...replacement.split("\n"), ...lines.slice(blk.endLine)];
    return { ok: true, text: out.join("\n"), mode: "block", note: "（降级：按行匹配，已对齐缩进）" };
  }

  const n = nearestIn(text, oldText.split("\n")[0] ?? "");
  return {
    ok: false,
    reason: "未找到要替换的文本（精确 / 空白归一化 / 去缩进 均未命中）",
    nearestLine: n.line,
    nearestText: n.text,
  };
}

/** 失败时的可操作提示：给位置、给下一步，而不是一句 failed。 */
export function formatEditFailure(f: EditFail): string {
  const where = f.nearestLine > 0 ? `\n最接近 line ${f.nearestLine}: ${f.nearestText}` : "";
  return `${f.reason}${where}\n下一步：用 file_read 读取该位置，按实际内容重新提供 old_text（可只贴关键几行）。`;
}
