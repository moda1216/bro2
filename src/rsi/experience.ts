/**
 * bro2 · 经验库（P2 · 两大设计目标共享的「复利中枢」）
 *
 * 为什么需要它：现有 RSI 是「每轮重新搜索」——Ledger.stats() 只按算子聚合
 * 成功率，meta 层只有 7 个固定枚举候选，都没有把「这次为什么有效」沉淀成
 * 下次可直接复用的先验。两大设计目标因此缺同一块底座：
 *
 *   目标 1「越用改进越快」：把探测过的有效编辑按失败模式指纹存档，Propose
 *     阶段直接命中 → 收敛所需探测次数随使用递减（复利，见 compound.ts）。
 *   目标 2「越用越省/越稳」：把每次路由与端点的实际结果存档，学习型路由
 *     据此判断「哪类请求本地就够 / 哪个上游靠谱」，跨会话累积
 *     （见 src/models/route-experience.ts）。
 *
 * 治理红线（继承 bro2 RSI，任何经验机制不得绕过）：
 *   1) 经验只影响 Propose 的候选裁剪 / 路由先验，绝不参与接受判定；
 *      判定仍走 behavioralContrast 的全量行为对比（防 reward hacking 复用）。
 *   2) 经验必须带适用条件 `applicableTo`，且可被 `invalidate()` 失效；
 *      OOD 退化时失效而非删除，防止把经验库做成记任务集（防过拟合）。
 *   3) 指纹只由失败模式类别 / 请求结构特征构成，禁止编码任务 id 或答案。
 *   4) 事件式只增账本：原子追加 + fsync + 残缺末行容错，读取时折叠成快照
 *      ——与 Trajectory / Ledger 完全一致的单一事实源约定。
 *
 * 诚实边界：本模块度量的是「搜索成本」与「路由质量」，不是能力分数，
 * 也不改变 leadership.verdict。经验不灵时必须回退完整探测，不得硬信经验。
 */
import {
  existsSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync,
} from "node:fs";
import { dirname } from "node:path";
import { failureSignals } from "./contrast.ts";
import type { RunSummary } from "./contrast.ts";
import type { LLMRequest } from "../models/base.ts";

/** 经验域：harness 编辑 / 路由决策 / 端点质量。三者共享同一套只增账本。 */
export type ExperienceDomain = "harness-edit" | "routing" | "endpoint";

export type ExperienceOutcome = "success" | "failure";

/** 一条只增事件。快照由 fold() 计算得出，绝不原地改写历史。 */
export interface ExperienceEvent {
  seq: number;
  ts: string;
  kind: "outcome" | "invalidation";
  domain: ExperienceDomain;
  signature: string;
  prescription: string;
  outcome?: ExperienceOutcome;
  applicableTo?: string[];
  source?: string;
  reason?: string;
}

/** 折叠后的经验快照（内存派生视图，不是第二套状态源）。 */
export interface ExperienceEntry {
  id: string;
  domain: ExperienceDomain;
  signature: string;
  prescription: string;
  applicableTo: string[];
  successes: number;
  failures: number;
  invalidations: string[];
  source: string;
  lastTs: string;
}

// ------------------------------------------------------------ 指纹（防记忆任务集）

/**
 * 失败模式指纹：只取**类别 + 量级桶 + 是否调用工具**，绝不编码任务 id / 答案。
 * 开放世界无真值时 `answer` 信号恒为 true，属恒定噪声，故剔除；`other` 同理。
 */
export function failureSignature(s: RunSummary): string {
  const kinds = failureSignals(s)
    .filter((k) => k !== "answer" && k !== "other")
    .sort();
  const scale = s.toolErrors + s.loopAdvisories + s.groundingRejects + s.protocolViolations;
  const bucket = scale === 0 ? "none" : scale <= 2 ? "low" : scale <= 6 ? "mid" : "high";
  return `F:${kinds.join("+") || "clean"}|${bucket}|${s.toolCalls === 0 ? "no-tool" : "tooled"}`;
}

/**
 * 请求特征指纹：只取「任务结构」（是否有工具 / 长度桶 / 轮次桶），不取内容文本。
 *
 * 刻意**不含末条角色**：`cheapToLocalPolicy` 用末条角色判断当前回合并据此走
 * local/remote，若经验指纹也含同一特征，两者视角完全重合，经验就永远无法
 * 覆盖启发式判断、学习型路由也就没有增益。这里让经验站在「这类任务结构
 * 本地是否够用」的视角，与「当前回合」视角正交；是否采信由
 * `minSamples` + `minLocalSuccessRate` 双重冷启动保护把关。
 */
export function requestSignature(req: LLMRequest): string {
  const hasTools = (req.tools?.length ?? 0) > 0;
  const last = req.messages[req.messages.length - 1];
  const len = last?.content?.length ?? 0;
  const size = len < 200 ? "short" : len < 600 ? "mid" : "long";
  const turns = req.messages.length <= 2 ? "few" : req.messages.length <= 6 ? "some" : "many";
  return `R:${hasTools ? "tools" : "no-tools"}|${size}|${turns}`;
}

/** 端点质量指纹：按上游名归一，跨会话累积该端点的历史成败。 */
export function endpointSignature(name: string): string {
  return `E:${name.trim().toLowerCase()}`;
}

// ------------------------------------------------------------ 只增账本

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  // 崩溃可能留下半行 JSON：丢弃末行而不是让整个账本不可读
  if (text.length > 0 && !text.endsWith("\n") && lines.length > 0) lines.pop();
  return lines;
}

function atomicAppend(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface PrioritizeResult<T> {
  /** 优先探测的候选（经验命中的排前；给定 topK 时截断）。 */
  prioritized: T[];
  /** 因截断而推迟探测的候选（经验不灵时回退用）。 */
  deferred: T[];
  /** 命中的经验条数。 */
  hits: number;
}

export interface ExperienceStats {
  events: number;
  entries: number;
  reusable: number;
  invalidated: number;
  /** 进程内检索命中率（跨会话的复用率以 velocity 只增账本为准）。 */
  retrieveCalls: number;
  hitCalls: number;
  reuseRate: number;
}

/**
 * 经验库。构造时只记录路径与序号，不缓存快照——每次读都从只增账本折叠，
 * 保证「新建实例即可读到历史」，这是跨会话复用的关键。
 */
export class ExperienceBank {
  readonly path: string;
  private seq = 0;
  private retrieveCalls = 0;
  private hitCalls = 0;

  constructor(path: string) {
    this.path = path;
    this.seq = readLines(path).length;
  }

  private append(ev: Omit<ExperienceEvent, "seq" | "ts">): ExperienceEvent {
    const full: ExperienceEvent = {
      seq: this.seq,
      ts: new Date().toISOString(),
      ...ev,
    };
    this.seq += 1;
    atomicAppend(this.path, JSON.stringify(full));
    return full;
  }

  /** 记录一次实证结果。**只由行为判定/实际调用结果驱动，绝不接受自报分数。 */
  observeOutcome(
    domain: ExperienceDomain,
    signature: string,
    prescription: string,
    outcome: ExperienceOutcome,
    meta: { applicableTo?: string[]; source?: string } = {},
  ): ExperienceEvent {
    return this.append({
      kind: "outcome", domain, signature, prescription, outcome,
      ...(meta.applicableTo ? { applicableTo: meta.applicableTo } : {}),
      ...(meta.source ? { source: meta.source } : {}),
    });
  }

  /** 标记经验失效（OOD 退化 / 适用条件变化）。只增失效事件，不删历史。 */
  invalidate(
    domain: ExperienceDomain,
    signature: string,
    prescription: string,
    reason: string,
  ): ExperienceEvent {
    return this.append({ kind: "invalidation", domain, signature, prescription, reason });
  }

  events(): ExperienceEvent[] {
    const out: ExperienceEvent[] = [];
    for (const line of readLines(this.path)) {
      try {
        out.push(JSON.parse(line) as ExperienceEvent);
      } catch {
        // 单条损坏不影响账本整体可读
      }
    }
    return out;
  }

  /** 把事件流折叠成当前经验快照。 */
  fold(): ExperienceEntry[] {
    const map = new Map<string, ExperienceEntry>();
    for (const e of this.events()) {
      const id = `${e.domain}|${e.signature}|${e.prescription}`;
      let cur = map.get(id);
      if (!cur) {
        cur = {
          id, domain: e.domain, signature: e.signature, prescription: e.prescription,
          applicableTo: [], successes: 0, failures: 0, invalidations: [], source: "", lastTs: e.ts,
        };
        map.set(id, cur);
      }
      cur.lastTs = e.ts;
      if (e.kind === "invalidation") {
        cur.invalidations.push(e.reason ?? "unspecified");
      } else if (e.outcome === "success") {
        cur.successes += 1;
      } else if (e.outcome === "failure") {
        cur.failures += 1;
      }
      if (e.applicableTo) cur.applicableTo = e.applicableTo;
      if (e.source) cur.source = e.source;
    }
    return [...map.values()];
  }

  /** 仍可复用的经验：未失效、净成功为正。按净成功降序。 */
  private usable(domain: ExperienceDomain, signature: string): ExperienceEntry[] {
    return this.fold()
      .filter((e) =>
        e.domain === domain && e.signature === signature
        && e.invalidations.length === 0 && e.successes > e.failures && e.successes > 0)
      .sort((a, b) => (b.successes - b.failures) - (a.successes - a.failures));
  }

  /** 检索某指纹下的可复用经验，并累计进程内命中率。 */
  retrieve(domain: ExperienceDomain, signature: string): ExperienceEntry[] {
    this.retrieveCalls += 1;
    const found = this.usable(domain, signature);
    if (found.length > 0) this.hitCalls += 1;
    return found;
  }

  /**
   * Propose 阶段裁剪：把经验命中的候选排前，可选只探测 topK 个。
   *
   * **只改变探测顺序与数量，绝不改变判定**（判定仍对实跑候选做全量行为对比）。
   * 未命中的候选进入 deferred，由 compoundProbe 在经验不灵时回退探测。
   */
  prioritize<T>(
    domain: ExperienceDomain,
    signature: string,
    candidates: T[],
    keyOf: (t: T) => string,
    topK?: number,
  ): PrioritizeResult<T> {
    const ranked = this.retrieve(domain, signature);
    const rank = new Map(ranked.map((e, i) => [e.prescription, i]));
    const ordered = [...candidates].sort((a, b) => {
      const ra = rank.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
    const hits = ordered.filter((c) => rank.has(keyOf(c))).length;
    const k = topK && topK > 0 ? Math.min(topK, ordered.length) : ordered.length;
    return {
      prioritized: ordered.slice(0, k),
      deferred: ordered.slice(k),
      hits,
    };
  }

  stats(): ExperienceStats {
    const all = this.fold();
    const reusable = all.filter((e) =>
      e.invalidations.length === 0 && e.successes > e.failures && e.successes > 0).length;
    return {
      events: this.events().length,
      entries: all.length,
      reusable,
      invalidated: all.filter((e) => e.invalidations.length > 0).length,
      retrieveCalls: this.retrieveCalls,
      hitCalls: this.hitCalls,
      reuseRate: this.retrieveCalls > 0 ? this.hitCalls / this.retrieveCalls : 0,
    };
  }
}

/** 默认路径：与 evolve 账本同目录，保持单一事实源。 */
export function experiencePath(root: string): string {
  return `${root.replace(/\/$/, "")}/data/rsi/experience.jsonl`;
}
