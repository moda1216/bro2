/**
 * W2-03 · 结构化诊断
 * ----------------------------------------------------------
 * 模型最需要的不是 200 行测试输出，而是「哪个测试、哪一行、错在哪」。
 * 这里把三类常见输出解析成统一结构：
 *  - node:test（`not ok N - name` + error 块）
 *  - Python unittest（`FAIL:` / `ERROR:`）
 *  - tsc / eslint 风格（`file(line,col): error ...`）
 * 未识别的输出原样保留尾部，绝不假装解析成功。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Diagnostic {
  kind: "test" | "type" | "lint";
  name: string;
  file?: string;
  line?: number;
  message: string;
}

export interface DiagResult {
  ok: boolean;
  command: string;
  code: number | null;
  total: number | null;
  failed: number | null;
  diagnostics: Diagnostic[];
  /** 未解析的原始输出尾部，供人工核对 */
  raw: string;
}

/** 从项目文件推断测试命令；推不出就返回 null（调用方必须如实说「不知道怎么跑」）。 */
export function detectTestCommand(root: string): string | null {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return "npm test --silent";
    } catch {
      /* 坏 package.json 不值得让诊断工具崩掉 */
    }
  }
  if (existsSync(join(root, "tests"))) return "python3 -m unittest discover -s tests -t .";
  if (existsSync(join(root, "pyproject.toml"))) return "python3 -m pytest -q";
  return null;
}

export function parseDiagnostics(out: string): { diagnostics: Diagnostic[]; total: number | null; failed: number | null } {
  const lines = out.split("\n");
  const diagnostics: Diagnostic[] = [];
  let total: number | null = null;
  let failed: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;

    const node = /^not ok \d+ - (.+)$/.exec(l.trim());
    if (node) {
      let message = "";
      let inBlock = false;
      const parts: string[] = [];
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
        const m = /^\s+(error|code|failureType):\s*(.*)$/.exec(lines[j]!);
        if (m) {
          const v = (m[2] ?? "").trim();
          // YAML 块标记（|- / | / >）不是错误内容，真正的消息在后续行
          if (!v || v === "|-" || v === "|" || v === ">") { inBlock = true; continue; }
          message = v;
          break;
        }
        if (inBlock) {
          const t = lines[j]!.trim();
          if (!t) continue;
          if (t === "..." || t === "---") break;
          parts.push(t);
          if (parts.length >= 3) break;
        }
      }
      if (parts.length > 0) message = parts.join(" ");
      diagnostics.push({ kind: "test", name: node[1]!.trim(), message });
      continue;
    }

    const py = /^(FAIL|ERROR):\s+(\S+)\s+\(([^)]+)\)/.exec(l);
    if (py) {
      diagnostics.push({ kind: "test", name: py[2]!, message: `${py[1]} in ${py[3]}` });
      continue;
    }

    const tsc = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s*(.+)$/.exec(l);
    if (tsc) {
      diagnostics.push({ kind: "type", name: tsc[4]!, file: tsc[1]!, line: Number(tsc[2]), message: tsc[5]!.trim() });
      continue;
    }

    const generic = /^(.+?):(\d+):(\d+):\s+(?:error|warning)\s+(.+)$/.exec(l);
    if (generic) {
      diagnostics.push({ kind: "lint", name: "lint", file: generic[1]!, line: Number(generic[2]), message: generic[4]!.trim() });
      continue;
    }

    const summary = /^# (tests|fail)\s+(\d+)/.exec(l);
    if (summary) {
      if (summary[1] === "tests") total = Number(summary[2]);
      else failed = Number(summary[2]);
    }
  }
  if (failed === null) failed = diagnostics.length;
  return { diagnostics, total, failed };
}

function run(cwd: string, command: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT 会让子进程的 node --test 认为自己是父测试的子任务，
    // 从而吞掉失败退出码——诊断工具绝不能继承它。
    const env: Record<string, string> = { ...process.env, NO_COLOR: "1", PYTHONDONTWRITEBYTECODE: "1" } as Record<string, string>;
    delete env.NODE_TEST_CONTEXT;
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    const append = (d: Buffer) => { if (out.length < 60_000) out += d.toString(); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, out }); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, out }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

export async function runDiagnostics(
  root: string,
  opts: { command?: string; timeoutMs?: number } = {},
): Promise<DiagResult> {
  const command = opts.command ?? detectTestCommand(root);
  if (!command) {
    return { ok: false, command: "", code: null, total: null, failed: null, diagnostics: [], raw: "未识别项目类型：请显式提供 command 参数" };
  }
  const { code, out } = await run(root, command, opts.timeoutMs ?? 120_000);
  const parsed = parseDiagnostics(out);
  return {
    ok: code === 0,
    command,
    code,
    total: parsed.total,
    failed: parsed.failed,
    diagnostics: parsed.diagnostics,
    raw: out.trim().slice(-1500),
  };
}

/** 面向模型的紧凑输出：失败项在前，原始尾部只在没有解析结果时给出。 */
export function formatDiagnostics(r: DiagResult): string {
  if (r.ok) return `诊断通过：\`${r.command}\`${r.total !== null ? `（${r.total} 项）` : ""}`;
  if (r.diagnostics.length === 0) {
    return `诊断失败（exit=${r.code ?? "timeout"}）：\`${r.command}\`\n--- 输出尾部 ---\n${r.raw || "(空)"}`;
  }
  const head = r.total !== null
    ? `${r.failed} / ${r.total} 项失败：`
    : `${r.diagnostics.length} 项问题：`;
  const lines = [head];
  for (const d of r.diagnostics.slice(0, 20)) {
    const loc = d.file ? ` ${d.file}${d.line ? `:${d.line}` : ""}` : "";
    lines.push(`- [${d.kind}] ${d.name}${loc}${d.message ? ` — ${d.message}` : ""}`);
  }
  if (r.diagnostics.length > 20) lines.push(`… 还有 ${r.diagnostics.length - 20} 项`);
  return lines.join("\n");
}
