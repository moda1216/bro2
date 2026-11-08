/**
 * L1 模型层 · 多 Provider 路由、降级与熔断
 */
import type { LLMProvider, LLMRequest, LLMResponse } from "./base.ts";
import { EMPTY_STATS, isStatsProvider, type InferenceStats } from "./cache.ts";

interface FailureState {
  count: number;
  cooldownUntil: number;
}

export class ProviderRouter implements LLMProvider {
  readonly name = "router";
  private readonly providers = new Map<string, LLMProvider>();
  private readonly failures = new Map<string, FailureState>();
  private current: string;
  private readonly circuitThreshold = 3;
  private readonly cooldownMs = 30000;
  /** 同 provider 瞬时故障重试：免费端点 429/5xx 是常态，适配器层重试耗尽后路由层再兜一轮。 */
  private retryCfg = { attempts: 0, baseMs: 500 };
  private retryTotal = 0;
  /** 空/半截响应守卫：拦住「200 但内容为空」这类绕过 catch 的静默故障。可消融。 */
  private emptyGuard = true;
  private emptyGuardHits = 0;
  /** 严格模式：禁止降级到其它 provider。评测真实模型时必须开启，否则 Mock 会掩盖失败。 */
  private strictMode = false;

  constructor(defaultName = "mock") {
    this.current = defaultName;
  }

  register(name: string, provider: LLMProvider): () => void {
    this.providers.set(name, provider);
    return () => this.providers.delete(name);
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) throw new Error(`未注册的模型: ${name}`);
    this.current = name;
  }

  get defaultName(): string {
    return this.current;
  }

  setStrict(v: boolean): void {
    this.strictMode = v;
  }

  /** attempts=0 表示关闭（用于消融对照：唯一变量就是「路由层重试」）。 */
  setRetry(cfg: { attempts: number; baseMs: number }): void {
    this.retryCfg = { attempts: Math.max(0, cfg.attempts), baseMs: Math.max(0, cfg.baseMs) };
  }

  /** 本次运行以来路由层实际执行的重试次数（评测归因用）。 */
  get retryAttempts(): number {
    return this.retryTotal;
  }

  /** emptyGuard=false 用于消融对照（唯一变量 = 是否拦半截响应）。 */
  setEmptyGuard(v: boolean): void {
    this.emptyGuard = v;
  }

  /** 空响应守卫实际拦下的次数（归因：证明机制真的动了，不是哑弹）。 */
  get emptyGuardHitCount(): number {
    return this.emptyGuardHits;
  }

  get strict(): boolean {
    return this.strictMode;
  }

  list(): Array<{ name: string; active: boolean; failures: number; coolingDown: boolean }> {
    return [...this.providers.keys()].map((name) => {
      const f = this.failures.get(name) ?? { count: 0, cooldownUntil: 0 };
      return {
        name,
        active: name === this.current,
        failures: f.count,
        coolingDown: f.cooldownUntil > Date.now(),
      };
    });
  }

  private order(): string[] {
    if (this.strictMode) return [this.current];
    return [this.current, ...[...this.providers.keys()].filter((n) => n !== this.current)];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const errors: string[] = [];
    for (const name of this.order()) {
      const f = this.failures.get(name);
      if (f && f.cooldownUntil > Date.now()) {
        errors.push(`${name}: 熔断冷却中`);
        continue;
      }
      const p = this.providers.get(name);
      if (!p) continue;
      // 瞬时故障先在原地退避重试（不计熔断）；重试耗尽才计入熔断并切下一个。
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await p.complete(req);
          // 半截/空响应不抛错，必须在这里主动转成可重试错误，否则会一路冒充合法终答。
          if (this.emptyGuard && isEmptyResponse(res)) {
            this.emptyGuardHits += 1;
            throw new EmptyResponseError();
          }
          this.failures.delete(name);
          return { ...res, provider: `${name}${res.provider !== name ? `/${res.provider}` : ""}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (req.signal?.aborted) throw err;
          if (attempt < this.retryCfg.attempts && isTransientError(err)) {
            this.retryTotal += 1;
            // 服务端带 Retry-After 时尊重其指示，不盲目指数退避。
            const ra = (err as { retryAfterMs?: number }).retryAfterMs;
            const wait = typeof ra === "number" ? ra : this.retryCfg.baseMs * 2 ** attempt;
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          errors.push(`${name}: ${msg}`);
          const state = this.failures.get(name) ?? { count: 0, cooldownUntil: 0 };
          state.count += 1;
          if (state.count >= this.circuitThreshold) state.cooldownUntil = Date.now() + this.cooldownMs;
          this.failures.set(name, state);
          break;
        }
      }
    }
    throw new Error(`全部模型均不可用 → ${errors.join(" | ")}`);
  }

  /** 委托给当前默认 provider 的推理效率统计（Hybrid/Cached 会返回真实指标）。 */
  inferenceStats(): InferenceStats {
    const p = this.providers.get(this.current);
    if (p && isStatsProvider(p)) return p.inferenceStats();
    return EMPTY_STATS;
  }
}

// ---------------------------------------------------------------- 故障注入
export type FaultKind =
  | "rate-limit" | "server-error" | "malformed-args"
  | "timeout" | "retry-after" | "empty-response";

export interface ProviderFault {
  kind: FaultKind;
  /** 前几次调用注入故障；之后完全透传 */
  times: number;
  /** timeout：模拟挂起时长 ms（默认 120，上限 1000，避免拖慢评测） */
  stallMs?: number;
  /** retry-after：服务端要求的等待 ms（默认 200，上限 1000） */
  retryAfterMs?: number;
}

/** 端点返回 200 但内容为空/半截：不抛错，绕过所有基于 catch 的重试。 */
export class EmptyResponseError extends Error {
  constructor() {
    super("empty response from provider (possible truncated stream)");
    this.name = "EmptyResponseError";
  }
}

/** 空响应判定：无文本、无工具调用、无 token 计入。宁可误拦也不把半截响应当合法终答。 */
export function isEmptyResponse(res: LLMResponse): boolean {
  // 正常响应 content 与 toolCalls 至少有一个非空；两者皆空 = 半截/空响应。
  // 不依赖 usage：真实端点断流时可能仍上报部分 token。
  return res.content.trim() === "" && res.toolCalls.length === 0;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export interface FlakyProvider extends LLMProvider {
  /** 已实际注入的故障次数（< times 说明任务太短，结论不可信） */
  readonly injected: number;
}

const FAULT_ERRORS: Partial<Record<FaultKind, string>> = {
  "rate-limit": "HTTP 429: rate limit exceeded (injected fault)",
  "server-error": "HTTP 500: internal server error (injected fault)",
  "retry-after": "HTTP 429: rate limit exceeded (Retry-After) (injected fault)",
  timeout: "fetch failed: ETIMEDOUT connection timed out (injected fault)",
};

/**
 * 用故障包装任意 provider。错误消息刻意与 OpenAICompat 的真实错误同构
 * （"HTTP 429: ..."），保证重试判定走的代码路径与真实限流完全一致——
 * 不许为测试单独开一条「假装是 429」的捷径。
 */
export function wrapFlaky(base: LLMProvider, fault: ProviderFault): FlakyProvider {
  if (!Number.isInteger(fault.times) || fault.times < 1) {
    throw new Error(`fault.times 必须是正整数，收到: ${fault.times}`);
  }
  let calls = 0;
  let injected = 0;
  return {
    name: base.name,
    get injected() {
      return injected;
    },
    async complete(req: LLMRequest): Promise<LLMResponse> {
      calls += 1;
      if (calls <= fault.times) {
        injected += 1;
        // 空/半截响应：不抛错，返回一个 200 但内容为空的 LLMResponse。
        // 只有「空响应守卫」能识别并重试——这是对 catch 型重试的盲区补强。
        if (fault.kind === "empty-response") {
          return {
            content: "", toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            model: base.name, durationMs: 0, provider: base.name,
          };
        }
        if (fault.kind === "timeout") {
          // 真实超时是「挂起」，但真挂 120s 会把评测拖垮。这里短 stall 后用
          // 与真实超时同构的错误消息抛错：harness 要判的是错误分类与重试，不是等待时长。
          await new Promise((r) => setTimeout(r, clamp(fault.stallMs ?? 120, 0, 1000)));
          throw new Error(FAULT_ERRORS.timeout);
        }
        if (fault.kind === "retry-after") {
          // 服务端明确要求等待：错误对象带 retryAfterMs，路由层应尊重而非盲目指数退避。
          const ms = clamp(fault.retryAfterMs ?? 200, 0, 1000);
          throw Object.assign(new Error(`${FAULT_ERRORS["retry-after"]}`), { retryAfterMs: ms });
        }
        if (fault.kind === "malformed-args") {
          // 畸形参数不是「替代模型回答」，而是污染真实回答：
          // 先让底层模型正常跑，再把第一个工具调用的标量参数全部字符串化
          // （5 → "5"、true → "true"——弱/免费模型最常见的参数类型错误）。
          // 模型没说工具调用时本次不注入（injected 不计），避免空转消耗额度。
          const res = await base.complete(req);
          if (res.toolCalls.length === 0) {
            injected -= 1;
            calls -= 1; // 没注进去就下一次再注，保证 times 次故障一定发生
            return res;
          }
          const [first, ...restCalls] = res.toolCalls;
          const entries = Object.entries(first!.arguments);
          // 优先注入「参数名拼错」（repair 策略的真实修复分支）：
          // 把第一个长度 ≥3 的键去掉尾字符，如 path → pat、command → comman。
          // 没有可拼错的键时退化为标量字符串化（fail/repair 下都会报错，仍消耗一步）。
          const idx = entries.findIndex(([k]) => k.length >= 3);
          let corrupted: Record<string, unknown>;
          if (idx >= 0) {
            corrupted = Object.fromEntries(
              entries.map(([k, v], i) => [i === idx ? k.slice(0, -1) : k, v]),
            );
          } else {
            corrupted = Object.fromEntries(
              entries.map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? String(v) : v]),
            );
          }
          return {
            ...res,
            toolCalls: [{ ...first!, arguments: corrupted }, ...restCalls],
          };
        }
        throw new Error(FAULT_ERRORS[fault.kind] ?? `injected ${fault.kind}`);
      }
      return base.complete(req);
    },
  };
}

/** 瞬时故障判定：与 OpenAICompat 的可重试错误口径一致（429 / 5xx / 网络层）。 */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if ((err as { fatal?: boolean }).fatal === true) return false;
  if (err instanceof EmptyResponseError) return true;
  return /HTTP 429|HTTP 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|empty response|truncated/i.test(msg);
}
