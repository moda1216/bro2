/**
 * L7 交互层 · 流式 CLI
 * 支持 /commands、@文件引用、实时工具回显、交互审批与 headless 单次执行。
 */
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EventType } from "../kernel/events.ts";
import type { Event } from "../kernel/events.ts";
import { ApprovalDecision } from "../governance/approval.ts";
import type { AgentOS } from "../index.ts";
import type { RunOptions, RunResult } from "../kernel/loop.ts";

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

export interface CLIOptions {
  preset?: string;
  model?: string;
  autoApprove?: boolean;
  /** 单次任务，执行完退出（CI 友好）。 */
  task?: string;
  quiet?: boolean;
}

export async function runCLI(os: AgentOS, options: CLIOptions = {}): Promise<void> {
  let session = os.createSession(options.preset ?? "standard");
  if (options.model) os.router.setDefault(options.model);
  os.approvals.setAutoApprove(options.autoApprove ?? false);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let approvalChain: Promise<void> = Promise.resolve();

  os.approvals.onRequest((req) => {
    approvalChain = approvalChain.then(async () => {
      if (os.approvals.isAutoApprove) {
        os.approvals.resolve(req.id, ApprovalDecision.Approve);
        return;
      }
      process.stdout.write(`\n${C.yellow}${C.bold}⚠ 需要审批${C.reset} ${req.toolName}\n理由: ${req.reason}\n参数: ${JSON.stringify(req.arguments).slice(0, 300)}\n`);
      const a = (await rl.question("批准? [y=本次 / a=本会话始终 / n=拒绝]: ")).trim().toLowerCase();
      const decision = a === "a" ? ApprovalDecision.Always : a === "y" ? ApprovalDecision.Approve : ApprovalDecision.Deny;
      os.approvals.resolve(req.id, decision);
      process.stdout.write(`${C.dim}→ 已${decision === ApprovalDecision.Deny ? "拒绝" : "批准"}${C.reset}\n`);
    }).catch(() => undefined);
  });

  const onEvent = (e: Event): void => {
    if (options.quiet) return;
    if (e.type === EventType.ToolCall) {
      const calls = (e.payload.calls as Array<{ name: string; arguments: Record<string, unknown> }>) ?? [];
      for (const c of calls) {
        process.stdout.write(`${C.cyan}  ↳ ${c.name}${C.reset}${C.dim}(${JSON.stringify(c.arguments).slice(0, 180)})${C.reset}\n`);
      }
    } else if (e.type === EventType.ToolResult) {
      const r = e.payload.result as { name?: string; ok?: boolean; output?: string; error?: string; elapsedMs?: number };
      const text = r?.ok ? String(r.output ?? "").slice(0, 220).replace(/\n/g, " ") : String(r.error ?? "");
      process.stdout.write(`${r?.ok ? C.green : C.red}    ${r?.ok ? "✓" : "✗"} ${r?.name ?? "?"} ${r?.elapsedMs ?? 0}ms${C.reset} ${C.dim}${text}${C.reset}\n`);
    } else if (e.type === EventType.Guard || e.type === EventType.Error) {
      process.stdout.write(`${C.red}  ! ${JSON.stringify(e.payload).slice(0, 220)}${C.reset}\n`);
    } else if (e.type === EventType.Compaction) {
      process.stdout.write(`${C.dim}  … 上下文已压缩 (移除 ${String(e.payload.removed)} 条)${C.reset}\n`);
    }
  };

  // 订阅全局事件总线（工具结果由 ToolRuntime 直接发布，不经 loop 的 onEvent）
  os.runtime.bus.on("*", (e: Event) => {
    if (e.sessionId === session.id) onEvent(e);
  });

  const runTask = async (text: string): Promise<RunResult> => {
    process.stdout.write(`\n${C.bold}agent${C.reset}${C.dim} [${session.preset} / ${os.router.defaultName}]${C.reset}: `);
    let streamed = false;
    const opts: Partial<RunOptions> = {
      onChunk: (c) => {
        if (c.kind === "text" && c.text) {
          streamed = true;
          process.stdout.write(c.text);
        }
      },
    };
    const result = await os.run(session.id, text, opts);
    if (!streamed) process.stdout.write(result.answer);
    process.stdout.write("\n");
    process.stdout.write(`${C.dim}[${result.stoppedBy} · ${result.steps + 1} 步 · ${result.toolCallCount} 次工具 · ${result.usage.totalTokens} tokens]${C.reset}\n`);
    return result;
  };

  const expandFiles = (text: string): string => {
    return text.replace(/@([\w./\-]+\.[\w]+)/g, (_m, p: string) => {
      const full = resolve(os.root, p);
      if (!existsSync(full)) return `[文件不存在: ${p}]`;
      const content = readFileSync(full, "utf8").slice(0, 8000);
      return `\n\n--- 引用文件 ${p} ---\n${content}\n--- 引用结束 ---`;
    });
  };

  const help = (): void => {
    process.stdout.write(`
${C.bold}命令${C.reset}
  /help                 显示帮助
  /tools                列出工具
  /presets              列出 Preset
  /preset <name>        新建会话并切换 Preset
  /model <name>         切换模型 (mock / openai)
  /new [preset]         新建会话
  /sessions             列出会话
  /fork                 从当前会话分叉
  /trace [n]            查看最近 n 条轨迹
  /metrics              实时指标
  /plugins              插件列表
  /install <name>       热安装插件
  /approvals            待审批
  /quit                 退出
  输入中可用 ${C.cyan}@path/file${C.reset} 引用文件内容。
\n`);
  };

  if (options.task) {
    const r = await runTask(expandFiles(options.task));
    rl.close();
    await os.shutdown();
    if (r.stoppedBy !== "completed") process.exitCode = 1;
    return;
  }

  process.stdout.write(`${C.bold}${os.name}${C.reset} ${C.dim}· 通用 Agent 运行时 · 输入 /help 查看命令${C.reset}\n`);
  process.stdout.write(`${C.dim}会话 ${session.id} · Preset ${session.preset} · 模型 ${os.router.defaultName} · 工具 ${os.registry.size} 个${C.reset}\n\n`);

  while (true) {
    let line: string;
    try {
      line = (await rl.question(`${C.green}you${C.reset} > `)).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === "/quit" || line === "/exit") break;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "/help": help(); break;
        case "/tools":
          process.stdout.write(os.registry.list().map((t) => `  ${C.cyan}${t.name.padEnd(22)}${C.reset} [${t.risk}] ${t.description.slice(0, 90)}`).join("\n") + "\n");
          break;
        case "/presets":
          process.stdout.write(os.presets.list().map((p) => `  ${p.name.padEnd(12)} ${p.description} ${C.dim}(${p.tools.join(",")})${C.reset}`).join("\n") + "\n");
          break;
        case "/preset":
        case "/new": {
          const name = arg || "standard";
          if (!os.presets.get(name)) { process.stdout.write(`${C.red}未知 Preset: ${name}${C.reset}\n`); break; }
          session = os.createSession(name);
          process.stdout.write(`${C.green}已新建会话 ${session.id} (${name})${C.reset}\n`);
          break;
        }
        case "/model":
          try { os.router.setDefault(arg); process.stdout.write(`模型 → ${arg}\n`); }
          catch (err) { process.stdout.write(`${C.red}${err instanceof Error ? err.message : String(err)}${C.reset}\n`); }
          break;
        case "/sessions":
          process.stdout.write(os.sessions.list().slice(0, 20).map((m) => `  ${m.id} [${m.status}] ${m.title}`).join("\n") + "\n");
          break;
        case "/fork": {
          const child = os.sessions.fork(session.id);
          session.close();
          if (child) { session = child; process.stdout.write(`已分叉 → ${session.id}\n`); }
          break;
        }
        case "/trace": {
          const n = Number(arg) || 20;
          const events = session.trajectory.events().slice(-n);
          process.stdout.write(events.map((e) => `  #${e.seq} [s${e.step}] ${e.type} ${JSON.stringify(e.payload).slice(0, 140)}`).join("\n") + "\n");
          break;
        }
        case "/metrics": {
          const m = os.tracer.snapshot();
          process.stdout.write(`  事件 ${m.events} · 工具 ${m.toolCalls} (失败 ${m.toolFailures}) · 审批 ${m.approvals} · token ${m.inputTokens}+${m.outputTokens} · 平均耗时 ${m.avgToolLatencyMs}ms\n`);
          break;
        }
        case "/plugins":
          process.stdout.write(`  已加载: ${os.runtime.pluginNames().join(", ") || "无"}\n  可安装: ${Object.keys(os.runtime.get<Record<string, unknown>>("pluginCatalog") ?? {}).join(", ")}\n`);
          break;
        case "/install": {
          const catalog = os.runtime.get<Record<string, { name: string; setup: (r: unknown) => void }>>("pluginCatalog") ?? {};
          const def = catalog[arg];
          if (!def) { process.stdout.write(`${C.red}未知插件${C.reset}\n`); break; }
          try { await os.runtime.loadPlugin(def as never); process.stdout.write(`${C.green}已加载 ${arg}${C.reset}\n`); }
          catch (err) { process.stdout.write(`${C.red}失败: ${err instanceof Error ? err.message : String(err)}${C.reset}\n`); }
          break;
        }
        case "/approvals": {
          const list = os.approvals.list();
          process.stdout.write(list.length ? list.map((a) => `  ${a.id} ${a.toolName} ${a.reason}`).join("\n") + "\n" : "  （无待审批）\n");
          break;
        }
        default: process.stdout.write(`未知命令: ${cmd}\n`);
      }
      continue;
    }

    try {
      await runTask(expandFiles(line));
    } catch (err) {
      process.stdout.write(`${C.red}错误: ${err instanceof Error ? err.message : String(err)}${C.reset}\n`);
    }
  }

  rl.close();
  await os.shutdown();
}
