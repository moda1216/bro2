/**
 * W1 · 隐藏测试执行器
 * ----------------------------------------------------------
 * 职责边界（少而精）：
 *  - 只做两件事：把 fixture 仓库铺进隔离工作区、在工作区里跑隐藏命令；
 *  - 不判分、不聚合、不改任务语义——判分仍由 observability/eval.ts 唯一负责；
 *  - 隐藏命令**只在任务结束后执行**，被测 agent 的轨迹里看不到它们。
 *
 * 为什么用内联 shell 命令而不是隐藏测试文件：
 *  - 文件一旦落盘就可能被 agent 读到（`file_list`/`search_files`），隐藏性失效；
 *  - 内联命令随任务 JSON 走，不进入工作区，也没有清理负担。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 不复制进工作区的目录：依赖、版本库、缓存、构建产物。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "dist", "build", ".pytest_cache"]);

export interface HiddenResult {
  command: string;
  /** 退出码；超时记为 null */
  code: number | null;
  ok: boolean;
  /** 截断后的输出（stdout + stderr），仅用于失败诊断 */
  output: string;
}

/** 把 fixture 仓库复制到目标目录（目标必须已存在或可创建）。 */
export function stageRepo(fixtureRoot: string, repo: string, dest: string): void {
  const src = join(fixtureRoot, repo);
  if (!existsSync(src)) throw new Error(`fixture 仓库不存在: ${src}`);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (path) => !SKIP_DIRS.has(path.split(/[\\/]/).pop() ?? ""),
  });
}

/** 跑一条命令；超时强杀，绝不留下悬挂进程。 */
function runOne(cwd: string, command: string, timeoutMs: number): Promise<HiddenResult> {
  return new Promise((resolve) => {
    // 与 diagnostics 同因：不能把父测试的 NODE_TEST_CONTEXT 传给被测命令。
    const env: Record<string, string> = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1" } as Record<string, string>;
    delete env.NODE_TEST_CONTEXT;
    const child = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let out = "";
    const append = (d: Buffer) => { if (out.length < 8000) out += d.toString(); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ command, code: null, ok: false, output: `超时（>${timeoutMs}ms）\n${tail(out)}` });
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ command, code: null, ok: false, output: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, code, ok: code === 0, output: tail(out) });
    });
  });
}

function tail(s: string, n = 600): string {
  const t = s.trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}

/** 顺序执行全部隐藏命令（失败也继续跑完，便于一次暴露多个问题）。 */
export async function runHiddenTests(
  cwd: string,
  commands: readonly string[],
  timeoutMs = 60_000,
): Promise<HiddenResult[]> {
  const out: HiddenResult[] = [];
  for (const command of commands) out.push(await runOne(cwd, command, timeoutMs));
  return out;
}

/**
 * 把隐藏测试结果转成评测原因：**通过时返回空数组**。
 * 失败必须给出命令与输出尾部，否则「为什么没过」只能靠猜，等于没有证据。
 */
export function hiddenReasons(results: readonly HiddenResult[]): string[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => `隐藏测试失败${r.code === null ? "" : ` (exit=${r.code})`}: ${r.command} → ${r.output}`);
}
