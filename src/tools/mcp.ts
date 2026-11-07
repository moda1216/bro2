/**
 * L2 工具层 · 连接器 / MCP 风格桥接
 *
 * 外部工具源（stdio 子进程或 HTTP JSON-RPC）通过 tools/list + tools/call
 * 挂载到同一个 ToolRegistry，与内置工具走完全相同的权限、Hook、轨迹管线。
 * 零第三方依赖实现 JSON-RPC 2.0。
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { newId } from "../kernel/events.ts";
import { defineTool, RiskLevel } from "./registry.ts";
import type { ToolDef, ToolRegistry } from "./registry.ts";
import type { JSONSchema } from "./schema.ts";
import type { Runtime } from "../kernel/runtime.ts";

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface Connector {
  readonly name: string;
  listTools(): Promise<ConnectorTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): void;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** HTTP JSON-RPC 连接器。 */
export class HttpConnector implements Connector {
  readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(options: { name: string; url: string; headers?: Record<string, string> }) {
    this.name = options.name;
    this.url = options.url;
    this.headers = options.headers ?? {};
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok) throw new Error(`连接器 HTTP ${res.status}`);
    const data = (await res.json()) as JsonRpcResponse;
    if (data.error) throw new Error(`连接器错误 ${data.error.code}: ${data.error.message}`);
    return data.result;
  }

  async listTools(): Promise<ConnectorTool[]> {
    const r = (await this.request("tools/list", {})) as { tools?: ConnectorTool[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return (r.content ?? []).map((c) => c.text ?? "").join("\n") || "(连接器无返回内容)";
  }

  close(): void {
    // 无状态 HTTP 连接器无需清理
  }
}

/** stdio JSON-RPC 连接器：子进程 + 行分隔协议，按 id 匹配异步响应。 */
export class StdioConnector implements Connector {
  readonly name: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  constructor(options: { name: string; command: string; args?: string[]; cwd?: string }) {
    this.name = options.name;
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", () => undefined);
    this.child.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("连接器子进程已退出"));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id !== "number") continue; // 通知消息，忽略
        const p = this.pending.get(msg.id);
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`连接器错误 ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } catch {
        // 非 JSON 行（日志）忽略
      }
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.child.killed) return Promise.reject(new Error("连接器已关闭"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`连接器请求超时: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async listTools(): Promise<ConnectorTool[]> {
    const r = (await this.request("tools/list", {})) as { tools?: ConnectorTool[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return (r.content ?? []).map((c) => c.text ?? "").join("\n") || "(连接器无返回内容)";
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("连接器关闭"));
    }
    this.pending.clear();
    this.child.kill();
  }
}

/** 把连接器工具挂载进注册表，返回可逆卸载函数。 */
export async function mountConnector(runtime: Runtime, registry: ToolRegistry, connector: Connector): Promise<() => void> {
  const defs = await connector.listTools();
  const disposers: Array<() => void> = [];
  try {
    for (const t of defs) {
      const tool: ToolDef = defineTool({
        name: `${connector.name}.${t.name}`,
        description: `[连接器 ${connector.name}] ${t.description}`,
        parameters: t.inputSchema,
        risk: RiskLevel.Safe,
        source: connector.name,
        handler: async (args) => connector.callTool(t.name, args),
      });
      disposers.push(registry.register(tool));
    }
  } catch (err) {
    for (const d of disposers.reverse()) d();
    connector.close();
    throw err;
  }
  runtime.register(`connector.${connector.name}`, { name: connector.name, tools: defs.length });
  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch { /* ignore */ }
    }
    connector.close();
  };
}

export { newId };
