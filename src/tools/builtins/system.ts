/**
 * 内置工具 · Shell / 计算 / HTTP / 时间
 * calc 使用手写递归下降解析器，绝不使用 eval / new Function。
 */
import { spawn } from "node:child_process";
import { defineTool, RiskLevel } from "../registry.ts";
import type { ToolDef } from "../registry.ts";
import type { PermissionPolicy } from "../../governance/permissions.ts";

export const shell = defineTool({
  name: "shell",
  description: "在工作区沙箱内执行 shell 命令，返回 stdout/stderr。高危命令会被拦截或需审批。",
  risk: RiskLevel.Write,
  pathArgs: ["cwd"],
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      cwd: { type: "string", description: "工作目录，缺省为工作区根", default: "." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  timeoutMs: 30000,
  handler: (args, ctx) => {
    const policy = ctx.runtime.require<PermissionPolicy>("permissions");
    const cwdCheck = policy.validatePath(args.cwd ?? ".");
    if (!cwdCheck.ok) throw new Error(cwdCheck.reason);
    const cwd = cwdCheck.resolved;
    return new Promise<string>((resolve) => {
      const child = spawn("sh", ["-c", args.command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      let out = "";
      let err = "";
      const max = 20000;
      child.stdout?.on("data", (d: Buffer) => { if (out.length < max) out += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { if (err.length < max) err += d.toString(); });
      child.on("error", (e) => resolve(`执行失败: ${e.message}`));
      child.on("close", (code) => {
        const tail = out.length >= max ? "\n…[stdout 已截断]" : "";
        resolve(
          `退出码: ${code}\n--- stdout ---\n${out || "(空)"}${tail}\n--- stderr ---\n${err || "(空)"}`,
        );
      });
    });
  },
});

/* ---------------- 安全表达式解析器 ---------------- */
type Tok =
  | { t: "num"; v: number }
  | { t: "op"; v: string }
  | { t: "id"; v: string }
  | { t: "lparen" | "rparen" | "lbracket" | "rbracket" | "comma" };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j]!)) j += 1;
      const n = Number(s.slice(i, j));
      if (!Number.isFinite(n)) throw new Error(`非法数字: ${s.slice(i, j)}`);
      out.push({ t: "num", v: n });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j]!)) j += 1;
      out.push({ t: "id", v: s.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/^%".includes(c)) { out.push({ t: "op", v: c }); i += 1; continue; }
    if (c === "(") { out.push({ t: "lparen" }); i += 1; continue; }
    if (c === ")") { out.push({ t: "rparen" }); i += 1; continue; }
    if (c === "[") { out.push({ t: "lbracket" }); i += 1; continue; }
    if (c === "]") { out.push({ t: "rbracket" }); i += 1; continue; }
    if (c === ",") { out.push({ t: "comma" }); i += 1; continue; }
    throw new Error(`非法字符: ${c}`);
  }
  return out;
}

type Value = number | number[];

const FUNCS: Record<string, (args: Value[]) => number> = {
  sum: (a) => flat(a).reduce((x, y) => x + y, 0),
  avg: (a) => { const v = flat(a); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; },
  min: (a) => Math.min(...flat(a)),
  max: (a) => Math.max(...flat(a)),
  len: (a) => flat(a).length,
  abs: (a) => Math.abs(num(a[0])),
  round: (a) => Math.round(num(a[0])),
  sqrt: (a) => Math.sqrt(num(a[0])),
  pow: (a) => Math.pow(num(a[0]), num(a[1])),
  log: (a) => Math.log(num(a[0])),
};

function flat(a: Value[]): number[] {
  return a.flatMap((v) => (Array.isArray(v) ? v : [v]));
}
function num(v: Value | undefined): number {
  if (v === undefined || Array.isArray(v)) throw new Error("需要标量数值");
  return v;
}

class Parser {
  private readonly toks: Tok[];
  private pos = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }
  parse(): number {
    const v = this.expr();
    if (this.pos < this.toks.length) throw new Error("表达式末尾有多余内容");
    return num(v);
  }
  private expr(): Value {
    let left = this.term();
    while (true) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
        this.next();
        const right = this.term();
        left = t.v === "+" ? num(left) + num(right) : num(left) - num(right);
      } else break;
    }
    return left;
  }
  private term(): Value {
    let left = this.power();
    while (true) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        this.next();
        const right = this.power();
        const r = num(right);
        if ((t.v === "/" || t.v === "%") && r === 0) throw new Error("除数为零");
        left = t.v === "*" ? num(left) * r : t.v === "/" ? num(left) / r : num(left) % r;
      } else break;
    }
    return left;
  }
  private power(): Value {
    const base = this.unary();
    const t = this.peek();
    if (t?.t === "op" && t.v === "^") {
      this.next();
      return Math.pow(num(base), num(this.power()));
    }
    return base;
  }
  private unary(): Value {
    const t = this.peek();
    if (t?.t === "op" && (t.v === "-" || t.v === "+")) {
      this.next();
      const v = num(this.unary());
      return t.v === "-" ? -v : v;
    }
    return this.atom();
  }
  private atom(): Value {
    const t = this.next();
    if (!t) throw new Error("表达式意外结束");
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "-") return -num(this.unary());
    if (t.t === "lparen") {
      const v = this.expr();
      const close = this.next();
      if (close?.t !== "rparen") throw new Error("缺少右括号");
      return v;
    }
    if (t.t === "lbracket") {
      const arr: number[] = [];
      if (this.peek()?.t !== "rbracket") {
        while (true) {
          arr.push(num(this.expr()));
          const n = this.peek();
          if (n?.t === "comma") { this.next(); continue; }
          break;
        }
      }
      const close = this.next();
      if (close?.t !== "rbracket") throw new Error("缺少 ]");
      return arr;
    }
    if (t.t === "id") {
      const lower = t.v.toLowerCase();
      if (lower === "pi") return Math.PI;
      if (lower === "e") return Math.E;
      const fn = FUNCS[lower];
      if (!fn) throw new Error(`未知函数或常量: ${t.v}`);
      const open = this.next();
      if (open?.t !== "lparen") throw new Error(`${t.v} 后需要 (`);
      const args: Value[] = [];
      if (this.peek()?.t !== "rparen") {
        while (true) {
          args.push(this.expr());
          const n = this.peek();
          if (n?.t === "comma") { this.next(); continue; }
          break;
        }
      }
      const close = this.next();
      if (close?.t !== "rparen") throw new Error("缺少右括号");
      return fn(args);
    }
    throw new Error(`无法解析: ${JSON.stringify(t)}`);
  }
}

export function safeCalc(expression: string): number {
  return new Parser(tokenize(expression)).parse();
}

export const calc = defineTool({
  name: "calc",
  description: "安全计算数学表达式。支持 + - * / ^ %、括号、数组 [1,2,3] 与函数 sum/avg/min/max/len/abs/round/sqrt/pow/log，常量 pi/e。不使用 eval。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "数学表达式，例如 sum([12, 18, 25])" } },
    required: ["expression"],
    additionalProperties: false,
  },
  handler: (args) => {
    try {
      return `${args.expression} = ${safeCalc(args.expression)}`;
    } catch (err) {
      return `计算失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const httpGet = defineTool({
  name: "http_get",
  description: "发起 HTTP GET 请求，返回状态码与响应体（截断）。仅允许 http/https。",
  risk: RiskLevel.Safe,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "完整 URL" },
      max_chars: { type: "integer", description: "响应体最大字符数", default: 4000, minimum: 100, maximum: 20000 },
    },
    required: ["url"],
    additionalProperties: false,
  },
  timeoutMs: 20000,
  handler: async (args, ctx) => {
    let u: URL;
    try { u = new URL(args.url); } catch { return `非法 URL: ${args.url}`; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return `仅支持 http/https，实际: ${u.protocol}`;
    try {
      const res = await fetch(u.toString(), { ...(ctx.signal ? { signal: ctx.signal } : {}) });
      const text = await res.text();
      const limit = args.max_chars ?? 4000;
      return `HTTP ${res.status} ${res.statusText}\ncontent-type: ${res.headers.get("content-type") ?? "-"}\n\n${text.slice(0, limit)}${text.length > limit ? "\n…[响应已截断]" : ""}`;
    } catch (err) {
      return `请求失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const currentTime = defineTool({
  name: "current_time",
  description: "获取当前 ISO 时间与 Unix 时间戳。",
  risk: RiskLevel.Safe,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  handler: () => `ISO: ${new Date().toISOString()}\nUnix(ms): ${Date.now()}\n时区: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
});

export const SYSTEM_TOOLS: ToolDef[] = [shell, calc, httpGet, currentTime];
