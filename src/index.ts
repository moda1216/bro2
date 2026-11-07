/**
 * Agent OS · 组装根（Composition Root）
 *
 * 所有组件通过 Runtime 依赖注入容器连接，替换任意实现只需换一次注册。
 * 这是「内核极小，一切可替换」的落地点，也是零第三方依赖的启动入口。
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Runtime, loadConfig } from "./kernel/runtime.ts";
import type { RuntimeConfig } from "./kernel/runtime.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ToolRuntime } from "./tools/runtime.ts";
import { PermissionPolicy } from "./governance/permissions.ts";
import { ApprovalManager } from "./governance/approval.ts";
import { Guards } from "./governance/guards.ts";
import { PresetRegistry } from "./cognition/preset.ts";
import { SkillRegistry } from "./cognition/skills.ts";
import { PlanManager } from "./cognition/plan.ts";
import { MemoryStore } from "./memory/store.ts";
import { ContextBuilder } from "./context/builder.ts";
import { BudgetManager } from "./context/budget.ts";
import { ProviderRouter } from "./models/router.ts";
import { MockProvider } from "./models/mock.ts";
import type { MockScript } from "./models/mock.ts";
import { OpenAICompatProvider } from "./models/openai-compat.ts";
import type { LLMProvider } from "./models/base.ts";
import { SessionManager } from "./kernel/session.ts";
import type { Session } from "./kernel/session.ts";
import { Trajectory } from "./kernel/trajectory.ts";
import { AgentLoop } from "./kernel/loop.ts";
import type { RunOptions, RunResult } from "./kernel/loop.ts";
import { Tracer } from "./observability/tracing.ts";
import { SubAgentRunner } from "./delegation/subagent.ts";
import type { SpawnFn, SpawnContext } from "./delegation/subagent.ts";
import { AutomationScheduler } from "./delegation/automation.ts";
import { registerBuiltinTools } from "./tools/builtins/index.ts";
import { BUILTIN_PLUGINS } from "./tools/plugin.ts";
import type { Event, EventDraft } from "./kernel/events.ts";
import type { StreamChunk } from "./models/base.ts";
import { parsePolicy } from "./runtime/policy.ts";
import type { BehaviorPolicy } from "./runtime/policy.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Agent 身份名：单一常量来源，config.name 可覆盖。 */
export const AGENT_NAME = "bro2";

export interface AgentOSOptions {
  root?: string;
  /** 覆盖配置（浅层合并到各节）。 */
  config?: Partial<RuntimeConfig>;
  /** 注入确定性 Mock 脚本，用于演示与测试。 */
  mockScript?: MockScript;
  /** headless / CI：自动批准高危操作。 */
  autoApprove?: boolean;
  /** 完全替换默认模型（测试用）。 */
  providerOverride?: LLMProvider;
  /** 默认加载的插件。 */
  plugins?: string[];
  /**
   * 是否应用已通过门禁的演进状态（data/evolve/state.json）。默认 true。
   * 评测器必须显式设为 false：验证器不得受被测系统的运行时演进状态影响，
   * 否则「改进」可以通过改运行时配置反作用于评测，构成 reward hacking。
   */
  evolvedState?: boolean;
}

export interface AgentOS {
  name: string;
  root: string;
  config: RuntimeConfig;
  runtime: Runtime;
  loop: AgentLoop;
  sessions: SessionManager;
  presets: PresetRegistry;
  skills: SkillRegistry;
  registry: ToolRegistry;
  permissions: PermissionPolicy;
  approvals: ApprovalManager;
  guards: Guards;
  memory: MemoryStore;
  plans: PlanManager;
  tracer: Tracer;
  router: ProviderRouter;
  /** 当前生效的行为策略（含已落地的演进结果），供状态接口与评测断言。 */
  policy: BehaviorPolicy;
  /** 已注册的模型实例，供 doctor / eval 直接探测能力（模型无关）。 */
  providers: Map<string, LLMProvider>;
  scheduler: AutomationScheduler;
  subagents: SubAgentRunner;
  createSession(preset?: string): Session;
  getSession(id: string): Session | undefined;
  run(sessionId: string, text: string, opts?: Partial<RunOptions>): Promise<RunResult>;
  spawn(preset: string, task: string, ctx: SpawnContext): Promise<string>;
  shutdown(): Promise<void>;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function createAgentOS(options: AgentOSOptions = {}): AgentOS {
  const root = options.root ?? PROJECT_ROOT;
  const configPath = join(root, "agentos.config.json");
  const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) as unknown : {};
  let config = loadConfig(raw) as RuntimeConfig;
  // 运行时自动落地「已通过门禁」的演进状态；显式 config 覆盖优先，保证评测隔离。
  if (options.evolvedState !== false) {
    const statePath = join(root, "data", "evolve", "state.json");
    if (existsSync(statePath)) {
      try {
        const evolved = JSON.parse(readFileSync(statePath, "utf8")) as {
          budget?: Record<string, unknown>;
          policy?: Record<string, unknown>;
        };
        if (evolved.budget && typeof evolved.budget === "object") {
          config.budget = { ...config.budget, ...evolved.budget } as RuntimeConfig["budget"];
        }
        // 已通过门禁的策略改进同时落地到运行时（评测器用 evolvedState:false 隔离）
        if (evolved.policy && typeof evolved.policy === "object") {
          config.policy = { ...(config.policy ?? {}), ...evolved.policy } as Partial<BehaviorPolicy>;
        }
      } catch {
        // 演进状态损坏时静默回退到基准配置，不阻塞启动
      }
    }
  }
  if (options.config) config = deepMerge(config, options.config);
  if (process.env.AGENTOS_MODEL) config.model.default = process.env.AGENTOS_MODEL;
  // 严格白名单解析：任何非法值回退保守默认，绝不把配置污染带进内核。
  const policy: BehaviorPolicy = parsePolicy(config.policy);

  // 路径全部相对项目根解析，避免 cwd 漂移
  const abs = (p: string): string => resolve(root, p);
  const storageDir = abs(config.storage.dir);
  const workspace = abs(config.permission.workspace);
  const allowedPaths = config.permission.allowedPaths.map(abs);
  config.storage.dir = storageDir;
  config.permission.workspace = workspace;
  config.permission.allowedPaths = allowedPaths;
  for (const p of [storageDir, workspace, join(storageDir, "sessions"), join(storageDir, "memory"), ...allowedPaths]) {
    mkdirSync(p, { recursive: true });
  }

  // ---- 内核 ----
  const runtime = new Runtime(config);
  const registry = new ToolRegistry();
  const sessions = new SessionManager(join(storageDir, "sessions"));
  const activeSessions = new Map<string, Session>();
  const globalTraj = new Trajectory(join(storageDir, "system.jsonl"));

  const record = (draft: EventDraft): Event => {
    const s = activeSessions.get(draft.sessionId);
    return (s ? s.trajectory : globalTraj).append(draft);
  };

  // ---- 治理 ----
  const permissions = new PermissionPolicy({
    level: config.permission.level,
    workspace,
    allowedPaths,
    autoApproveSafe: config.permission.autoApproveSafe,
  });
  const approvals = new ApprovalManager({
    bus: runtime.bus,
    record,
    autoApprove: options.autoApprove ?? false,
  });
  const guards = new Guards({
    maxSteps: config.budget.maxSteps,
    maxTokens: config.budget.maxTokens,
    maxSeconds: config.budget.maxSeconds,
    loopDetectionThreshold: config.budget.loopDetectionThreshold,
    loopMode: policy.loopDetection,
  });

  // ---- 认知与记忆 ----
  const presets = new PresetRegistry(join(root, "presets"));
  const skills = new SkillRegistry([join(root, "skills")]);
  const plans = new PlanManager();
  const memory = new MemoryStore(join(storageDir, "memory"));
  const contextBuilder = new ContextBuilder();
  // 压缩阈值必须低于 Guards 的 token 硬熔断，且可独立配置：
  // 若共用同一数值，压缩永远来不及生效（累计 usage 先触顶）。
  const budget = new BudgetManager(
    config.budget.compactTokens ?? Math.floor(config.budget.maxTokens * 0.6),
    8,
    policy.compaction,
  );

  // ---- 模型 ----
  // 全部 provider 走同一个 OpenAICompat 适配器：云端 API、vLLM、LM Studio、
  // 本地 Ollama 只是 baseUrl / 认证策略不同，内核不感知差异。
  const router = new ProviderRouter(config.model.default);
  const providers = new Map<string, LLMProvider>();
  const mock = new MockProvider(options.mockScript ? { script: options.mockScript } : { strategy: "heuristic" });
  router.register("mock", mock);
  providers.set("mock", mock);

  // 把配置中的 ${VAR} 占位符按环境变量展开（如 model: "${OPENROUTER_MODEL}"）
  const expand = (v: unknown): string => {
    if (typeof v !== "string") return "";
    return v.replace(/\$\{([^}]+)\}/g, (_m, name: string) => process.env[name] ?? "");
  };
  // ollama / openai 保留历史 env 覆盖（OLLAMA_* / OPENAI_*），其余 provider 直接读配置
  const envBaseFor = (name: string, cfg: Record<string, unknown>): string => {
    if (name === "ollama") return process.env.OLLAMA_BASE_URL ?? expand(cfg.baseUrl);
    if (name === "openai") return process.env.OPENAI_BASE_URL ?? expand(cfg.baseUrl);
    return expand(cfg.baseUrl);
  };
  const envModelFor = (name: string, cfg: Record<string, unknown>): string => {
    if (name === "ollama") return process.env.OLLAMA_MODEL ?? expand(cfg.model);
    if (name === "openai") return process.env.OPENAI_MODEL ?? expand(cfg.model);
    return expand(cfg.model);
  };

  const buildCompat = (name: string, cfg: Record<string, unknown>): OpenAICompatProvider => {
    const keyEnv = String(cfg.apiKeyEnv ?? (name === "ollama" ? "OLLAMA_API_KEY" : "OPENAI_API_KEY"));
    return new OpenAICompatProvider({
      name,
      baseUrl: envBaseFor(name, cfg) || (name === "ollama" ? "http://127.0.0.1:11434/v1" : ""),
      apiKey: process.env[keyEnv] ?? "",
      model: envModelFor(name, cfg) || (name === "ollama" ? "llama3.1:8b" : ""),
      timeoutMs: Number(cfg.timeoutMs ?? 120000),
      maxRetries: Number(cfg.maxRetries ?? 2),
      apiKeyOptional: cfg.apiKeyOptional === true,
      includeUsage: cfg.includeUsage !== false,
    });
  };

  // 遍历配置中的所有 OpenAI 兼容 provider（云端 API / vLLM / Ollama / 免费 LLM API 等），
  // 内核不感知差异，统一走 OpenAICompat 适配器。
  for (const [name, raw] of Object.entries(config.model.providers ?? {})) {
    if (name === "mock") continue;
    const cfg = (raw ?? {}) as Record<string, unknown>;
    if (cfg.type !== "openai") continue;
    const p = buildCompat(name, cfg);
    router.register(name, p);
    providers.set(name, p);
  }

  if (options.providerOverride) {
    router.register("override", options.providerOverride);
    router.setDefault("override");
    providers.set("override", options.providerOverride);
  }

  // ---- 工具运行时 ----
  const toolRuntime = new ToolRuntime({
    registry,
    hooks: runtime.hooks,
    bus: runtime.bus,
    defaultTimeoutMs: config.budget.toolTimeoutMs,
    maxOutputChars: config.budget.maxToolOutputChars,
    record,
    malformedArgs: policy.malformedArgs,
    parallel: policy.parallel,
  });

  // ---- 可观测性 ----
  const tracer = new Tracer(runtime.bus);

  // ---- 协作层（spawn 通过闭包复用主循环，避免循环依赖）----
  let loopRef: AgentLoop | undefined;
  const spawn: SpawnFn = async (presetName: string, task: string, ctx: SpawnContext): Promise<string> => {
    if (!loopRef) throw new Error("AgentLoop 尚未初始化");
    const child = sessions.create(presetName, `子任务: ${task.slice(0, 24)}`);
    activeSessions.set(child.id, child);
    const result = await loopRef.run({
      session: child,
      text: task,
      presetName,
      depth: ctx.depth,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      extraInject: "你是子 Agent：请聚焦给定的子任务，直接给出结论，不要派生更多子 Agent。",
    });
    return result.answer;
  };
  const subagents = new SubAgentRunner({ spawn, maxDepth: 2, concurrency: 3 });
  const scheduler = new AutomationScheduler({
    executor: async (job) => {
      if (!loopRef) return "运行时未就绪";
      const s = sessions.create(job.preset, `定时: ${job.name}`);
      activeSessions.set(s.id, s);
      const r = await loopRef.run({ session: s, text: job.task, presetName: job.preset });
      return r.answer;
    },
    record,
  });

  // ---- 注册服务（全部可替换）----
  const services: Array<[string, unknown]> = [
    ["registry", registry],
    ["toolRuntime", toolRuntime],
    ["permissions", permissions],
    ["approvals", approvals],
    ["guards", guards],
    ["presets", presets],
    ["skills", skills],
    ["plans", plans],
    ["memory", memory],
    ["contextBuilder", contextBuilder],
    ["budget", budget],
    ["router", router],
    ["sessions", sessions],
    ["tracer", tracer],
    ["subagents", subagents],
    ["scheduler", scheduler],
    ["pluginCatalog", BUILTIN_PLUGINS],
    ["policy", policy],
    ["spawn", spawn],
    ["record", record],
  ];
  for (const [k, v] of services) runtime.register(k, v);

  registerBuiltinTools(runtime, registry);

  // 默认加载只读审计插件（演示可逆副作用），其余由 plugin_install 热插拔
  for (const name of options.plugins ?? ["tool-audit"]) {
    const def = BUILTIN_PLUGINS[name];
    if (def) void runtime.loadPlugin(def).catch(() => undefined);
  }

  const loop = new AgentLoop({
    runtime,
    hooks: runtime.hooks,
    provider: router,
    registry,
    toolRuntime,
    permissions,
    approvals,
    guards,
    presets,
    skills,
    plans,
    memory,
    contextBuilder,
    budget,
    policy,
  });
  loopRef = loop;
  scheduler.start();

  const os: AgentOS = {
    name: config.name ?? AGENT_NAME,
    root,
    config,
    runtime,
    loop,
    sessions,
    presets,
    skills,
    registry,
    permissions,
    approvals,
    guards,
    memory,
    plans,
    tracer,
    router,
    policy,
    providers,
    scheduler,
    subagents,
    createSession(preset = "standard"): Session {
      const s = sessions.create(preset);
      activeSessions.set(s.id, s);
      return s;
    },
    getSession(id: string): Session | undefined {
      const cached = activeSessions.get(id);
      if (cached) return cached;
      const s = sessions.resume(id);
      if (s) activeSessions.set(id, s);
      return s;
    },
    run(sessionId: string, text: string, opts: Partial<RunOptions> = {}): Promise<RunResult> {
      const s = activeSessions.get(sessionId) ?? os.getSession(sessionId);
      if (!s) throw new Error(`会话不存在: ${sessionId}`);
      activeSessions.set(s.id, s);
      return loop.run({
        session: s,
        text,
        ...opts,
      });
    },
    spawn,
    async shutdown(): Promise<void> {
      scheduler.stop();
      await runtime.unloadAll();
      tracer.close();
      for (const s of activeSessions.values()) s.close();
      activeSessions.clear();
      globalTraj.close();
    },
  };
  return os;
}

export { Runtime, AgentLoop, ToolRegistry, ProviderRouter, MockProvider, SessionManager, Trajectory };
export type { RuntimeConfig, RunOptions, RunResult, Session, Event, StreamChunk };
