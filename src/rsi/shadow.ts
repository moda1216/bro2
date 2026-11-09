/**
 * bro2 · 可改进状态持久化 + 影子运行时副本
 *
 * 每个候选不是"改当前进程"，而是在临时目录构造一份完整的新版本 agent root
 * （config + presets + skills），再交给独立的评测器验证。这与 DGM 的变体评估一致：
 * 未通过门禁的候选从未接触真实运行时，天然可回滚。
 */
import {
  mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync,
  readdirSync, copyFileSync, renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvolvableState, EvolutionStrategy, MetaState } from "./types.ts";
import { DEFAULT_STATE, DEFAULT_STRATEGY, DEFAULT_META, parseMeta } from "./types.ts";
import { DEFAULT_POLICY } from "../runtime/policy.ts";

/** 兼容旧版 state.json（无 policy 字段）：补齐保守默认，避免 undefined 进入内核。 */
function normalizeState(s: EvolvableState): EvolvableState {
  return { ...s, policy: { ...DEFAULT_POLICY, ...(s.policy ?? {}) }, skillOverlays: s.skillOverlays ?? {} };
}

/**
 * scratchDir：meta RSI 影子评测时把账本/incidents/报告隔离到临时目录，
 * 避免污染真实只增账本。train/holdout 始终读真实 root 的写保护任务集。
 */
export function evolvePaths(root: string, scratchDir?: string): {
  dir: string;
  state: string;
  strategy: string;
  ledger: string;
  incidents: string;
  train: string;
  holdout: string;
  ood: string;
  report: string;
} {
  const dir = scratchDir ?? join(root, "data", "evolve");
  return {
    dir,
    state: join(dir, "state.json"),
    strategy: join(dir, "strategy.json"),
    ledger: join(dir, "ledger.jsonl"),
    incidents: join(dir, "incidents.jsonl"),
    train: join(root, "data", "evolve", "train.jsonl"),
    holdout: join(root, "data", "evolve", "holdout.jsonl"),
    ood: join(root, "data", "evolve", "ood.jsonl"),
    report: scratchDir ? join(scratchDir, "evolve-report.json") : join(root, "data", "evolve-report.json"),
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function loadState(root: string): EvolvableState {
  const p = evolvePaths(root).state;
  if (!existsSync(p)) {
    atomicWriteJson(p, DEFAULT_STATE);
    return JSON.parse(JSON.stringify(DEFAULT_STATE)) as EvolvableState;
  }
  try {
    return normalizeState(JSON.parse(readFileSync(p, "utf8")) as EvolvableState);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE)) as EvolvableState;
  }
}

export function loadStrategy(root: string): EvolutionStrategy {
  const p = evolvePaths(root).strategy;
  if (!existsSync(p)) {
    atomicWriteJson(p, DEFAULT_STRATEGY);
    return JSON.parse(JSON.stringify(DEFAULT_STRATEGY)) as EvolutionStrategy;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as EvolutionStrategy;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STRATEGY)) as EvolutionStrategy;
  }
}

export function saveState(root: string, state: EvolvableState): void {
  atomicWriteJson(evolvePaths(root).state, state);
}

export function saveStrategy(root: string, strategy: EvolutionStrategy): void {
  atomicWriteJson(evolvePaths(root).strategy, strategy);
}

export function freshDefaultState(): EvolvableState {
  return JSON.parse(JSON.stringify(DEFAULT_STATE)) as EvolvableState;
}

export function freshDefaultStrategy(): EvolutionStrategy {
  return JSON.parse(JSON.stringify(DEFAULT_STRATEGY)) as EvolutionStrategy;
}

// ---- meta 状态持久化：放在 shadow.ts 避免 loop.ts ↔ meta.ts 的循环依赖 ----

export function metaStatePath(root: string): string {
  return join(root, "data", "evolve", "meta-state.json");
}

/** 已通过冻结 fitness 晋升的元改进，会在下一次 evolve 中真正作用于改进机制。 */
export function loadMetaState(root: string): MetaState {
  const p = metaStatePath(root);
  if (!existsSync(p)) return { ...DEFAULT_META };
  try { return parseMeta(JSON.parse(readFileSync(p, "utf8"))); } catch { return { ...DEFAULT_META }; }
}

export function saveMetaState(root: string, meta: MetaState): void {
  const p = metaStatePath(root);
  atomicWriteJson(p, meta);
}

/** 构造一份应用了候选状态的新版本 agent root。调用方负责 rmSync 清理。 */
export function makeShadowRoot(root: string, state: EvolvableState): string {
  const shadow = mkdtempSync(join(tmpdir(), "bro2-shadow-"));
  mkdirSync(join(shadow, "skills"), { recursive: true });
  mkdirSync(join(shadow, "presets"), { recursive: true });

  // 1) 配置：候选 budget 覆盖基准配置（storage / permission 由评测器再覆盖为隔离路径）
  const cfgPath = join(root, "agentos.config.json");
  const cfg: Record<string, unknown> = existsSync(cfgPath)
    ? JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>
    : {};
  const baseBudget = (cfg.budget ?? {}) as Record<string, unknown>;
  cfg.budget = { ...baseBudget, ...state.budget };
  // 策略面同样写入影子 config，评测器启动时会经 parsePolicy 解析成真实代码分支
  cfg.policy = { ...(state.policy ?? {}) };
  writeFileSync(join(shadow, "agentos.config.json"), JSON.stringify(cfg, null, 2));

  // 2) Preset（保持与真实运行时一致）
  const presetDir = join(root, "presets");
  if (existsSync(presetDir)) {
    for (const f of readdirSync(presetDir)) {
      if (f.endsWith(".json")) copyFileSync(join(presetDir, f), join(shadow, "presets", f));
    }
  }

  // 3) 技能库，并追加候选 overlay（操作级指导）
  const skillDir = join(root, "skills");
  if (existsSync(skillDir)) {
    for (const d of readdirSync(skillDir)) {
      const src = join(skillDir, d, "SKILL.md");
      if (!existsSync(src)) continue;
      mkdirSync(join(shadow, "skills", d), { recursive: true });
      copyFileSync(src, join(shadow, "skills", d, "SKILL.md"));
    }
  }
  for (const [name, overlay] of Object.entries(state.skillOverlays)) {
    const dir = join(shadow, "skills", name);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "SKILL.md");
    const base = existsSync(p)
      ? readFileSync(p, "utf8")
      : `---\nname: ${name}\ndescription: bro2 演进生成的操作级指导\ntags: evolved\n---\n\n`;
    writeFileSync(p, `${base}\n\n<!-- bro2-evolved-overlay -->\n${overlay}\n`);
  }
  return shadow;
}
