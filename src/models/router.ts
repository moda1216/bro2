/**
 * L1 模型层 · 多 Provider 路由、降级与熔断
 */
import type { LLMProvider, LLMRequest, LLMResponse } from "./base.ts";

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
      try {
        const res = await p.complete(req);
        this.failures.delete(name);
        return { ...res, provider: `${name}${res.provider !== name ? `/${res.provider}` : ""}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${name}: ${msg}`);
        if (req.signal?.aborted) throw err;
        const state = this.failures.get(name) ?? { count: 0, cooldownUntil: 0 };
        state.count += 1;
        if (state.count >= this.circuitThreshold) state.cooldownUntil = Date.now() + this.cooldownMs;
        this.failures.set(name, state);
      }
    }
    throw new Error(`全部模型均不可用 → ${errors.join(" | ")}`);
  }
}
