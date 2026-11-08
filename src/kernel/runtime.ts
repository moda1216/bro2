/**
 * L0 内核 · Runtime 依赖注入容器（"一切可替换"的最小实现）
 *
 * 关键能力：可逆副作用。插件 setup 期间所有 service / hook / listener 注册
 * 都被收集为 disposer；插件卸载或加载失败时全部回滚，保证热插拔不留残骸。
 */
import { EventBus } from "./events.ts";
import { HookManager } from "./hooks.ts";
import type { Event } from "./events.ts";
import type { BehaviorPolicy } from "../runtime/policy.ts";

export interface RuntimeConfig {
  /** Agent 身份名，与 package.json / Web UI / CLI 保持一致。 */
  name?: string;
  storage: { dir: string };
  permission: {
    level: "read-only" | "workspace-write" | "danger-full-access";
    workspace: string;
    allowedPaths: string[];
    autoApproveSafe: boolean;
  };
  budget: {
    maxSteps: number;
    maxTokens: number;
    maxSeconds: number;
    maxConcurrentTools: number;
    toolTimeoutMs: number;
    loopDetectionThreshold: number;
    maxToolOutputChars: number;
    /** 上下文压缩阈值。应低于 maxTokens 硬熔断，否则压缩来不及生效就被终止。 */
    compactTokens?: number;
  };
  model: {
    default: string;
    providers: Record<string, Record<string, unknown>>;
    /** 路由层瞬时故障重试（429/5xx/网络）。attempts=0 关闭，用于消融对照。 */
    retry?: { attempts: number; baseMs: number };
  };
  server: { host: string; port: number };
  /** 行为策略分派层；缺省时由 parsePolicy 回退到保守默认。 */
  policy?: Partial<BehaviorPolicy>;
}

export interface PluginHandle {
  name: string;
  loaded: boolean;
  unload(): Promise<void>;
}

export interface PluginDefinition {
  name: string;
  setup(runtime: Runtime): void | Promise<void>;
  teardown?(runtime: Runtime): void | Promise<void>;
}

export class Runtime {
  readonly bus = new EventBus();
  readonly hooks = new HookManager();
  readonly config: RuntimeConfig;
  private readonly services = new Map<string, unknown>();
  private readonly plugins = new Map<string, { disposers: Array<() => void>; definition: PluginDefinition }>();
  private collecting: Array<() => void> | null = null;

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  /** 注册服务，返回 disposer（可逆）。 */
  register<T>(key: string, value: T): () => void {
    const had = this.services.has(key);
    const previous = this.services.get(key);
    this.services.set(key, value);
    const disposer = () => {
      if (had) this.services.set(key, previous);
      else this.services.delete(key);
    };
    if (this.collecting) this.collecting.push(disposer);
    return disposer;
  }

  get<T>(key: string): T | undefined {
    return this.services.get(key) as T | undefined;
  }

  require<T>(key: string): T {
    const v = this.services.get(key);
    if (v === undefined) throw new Error(`Runtime 缺少必需服务: ${key}`);
    return v as T;
  }

  keys(): string[] {
    return [...this.services.keys()];
  }

  /** 可逆 Hook 注册：插件卸载时自动撤销，保证「可逆副作用」。 */
  onHook(point: import("./hooks.ts").HookPoint, fn: import("./hooks.ts").HookFn): () => void {
    const d = this.hooks.register(point, fn);
    if (this.collecting) this.collecting.push(d);
    return d;
  }

  /** 可逆事件订阅：注册进入当前插件作用域时自动纳入回滚。 */
  onEvent(type: Parameters<EventBus["on"]>[0], fn: Parameters<EventBus["on"]>[1]): () => void {
    const d = this.bus.on(type, fn);
    if (this.collecting) this.collecting.push(d);
    return d;
  }

  /** 发布一个内核事件（供各层使用，保证 seq 由 Trajectory 统一管理）。 */
  async publish(event: Event): Promise<void> {
    await this.bus.emit(event);
  }

  /** 加载插件：失败时回滚所有已注册副作用。 */
  async loadPlugin(def: PluginDefinition): Promise<PluginHandle> {
    if (this.plugins.has(def.name)) throw new Error(`插件已加载: ${def.name}`);
    const disposers: Array<() => void> = [];
    const prev = this.collecting;
    this.collecting = disposers;
    try {
      await def.setup(this);
    } catch (err) {
      this.collecting = prev;
      for (const d of disposers.reverse()) {
        try { d(); } catch { /* ignore */ }
      }
      throw err;
    }
    this.collecting = prev;
    this.plugins.set(def.name, { disposers, definition: def });
    const self = this;
    return {
      name: def.name,
      loaded: true,
      async unload(): Promise<void> {
        const entry = self.plugins.get(def.name);
        if (!entry) return;
        if (def.teardown) {
          try { await def.teardown(self); } catch { /* 卸载不因 teardown 失败而中断 */ }
        }
        for (const d of entry.disposers.reverse()) {
          try { d(); } catch { /* ignore */ }
        }
        self.plugins.delete(def.name);
      },
    };
  }

  pluginNames(): string[] {
    return [...this.plugins.keys()];
  }

  async unloadAll(): Promise<void> {
    for (const name of [...this.plugins.keys()].reverse()) {
      const entry = this.plugins.get(name);
      if (!entry) continue;
      if (entry.definition.teardown) {
        try { await entry.definition.teardown(this); } catch { /* ignore */ }
      }
      for (const d of entry.disposers.reverse()) {
        try { d(); } catch { /* ignore */ }
      }
      this.plugins.delete(name);
    }
  }
}

/** 把配置中的 ${ENV_VAR} 占位符解析为环境变量，缺失时返回 fallback。 */
export function resolveEnvPlaceholders<T>(value: T, fallback = ""): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => process.env[name] ?? fallback) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvPlaceholders(v, fallback)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveEnvPlaceholders(v, fallback);
    }
    return out as T;
  }
  return value;
}

export function loadConfig(raw: unknown): RuntimeConfig {
  const resolved = resolveEnvPlaceholders(raw) as RuntimeConfig;
  return resolved;
}
