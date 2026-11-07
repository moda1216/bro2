/**
 * bro2 · meta RSI（改进机制自身的可验证迭代）
 *
 * 与能力层 RSI 的关系：
 *   L3  EvolvableState → 在 train/holdout 上改进「agent 能力」
 *   L4  MetaState      → 用**冻结的外部 fitness** 改进「如何搜索改进」
 *
 * 三条比能力层更严的约束：
 *  1) 尺子冻结：fitness 由 src/benchmark/scoring.ts 计算，在写保护面内，
 *     元候选只能改 MetaState 的有限枚举，碰不到评分逻辑 / 任务集 / 门禁阈值；
 *  2) 能力不退化是硬前提：finalHoldout 必须 >= 基线，效率提升不能拿能力换；
 *  3) 单调晋升 + 只增元账本：每轮最多晋升 1 个，全部候选（含被拦）留痕。
 *
 * 对应 D2I 的判据「Imp_t → Imp_{t+1}」：本代实证成败确实改变了下一代
 * 如何搜索改进（证据窗口 / 排序 / 算子集 / 平台期 / 破平局判据），
 * 但明确不做 L5（不自动改核心源码、不重训权重、不关闭验证）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runEvolve } from "./loop.ts";
import {
  computeIntegrity, diffIntegrity,
} from "./guardrails.ts";
import {
  DEFAULT_META, META_KEYS, META_ENUMS, META_RANGES, META_DESCRIPTIONS, parseMeta,
} from "./types.ts";
import type { MetaState } from "./types.ts";
import { metaStatePath, loadMetaState, saveMetaState } from "./shadow.ts";
import { measureMetaFitness, metaPromotionOk } from "../benchmark/scoring.ts";
import type { MetaFitness } from "../benchmark/scoring.ts";
import { shortHash } from "./types.ts";

// ---------------------------------------------------------------- 元 patch

export interface MetaPatch {
  id: string;
  key: keyof MetaState;
  from: unknown;
  to: unknown;
  reason: string;
}

export interface MetaCheck {
  ok: boolean;
  severity: "critical" | "warning";
  reason: string;
}

/** 元层写保护：字段名命中即拒绝，防止把验证层级做成可改进的"能力面"。 */
const META_FORBIDDEN = /gate|threshold|task|holdout|train|eval|score|integrity|fitness|ledger|verifier|scoring/i;

export function checkMetaPatch(patch: MetaPatch, current: MetaState): MetaCheck {
  const k = patch.key;
  // 禁用词先判：伪造 gate/eval/task 类字段要明确报"验证面"，而不是含糊的"未知维度"
  if (META_FORBIDDEN.test(k)) {
    return { ok: false, severity: "critical", reason: `元层禁止修改验证面字段 ${k}` };
  }
  if (!(META_KEYS as readonly string[]).includes(k)) {
    return { ok: false, severity: "critical", reason: `未知元维度 ${k}` };
  }
  if (patch.from !== undefined && JSON.stringify(current[k]) !== JSON.stringify(patch.from)) {
    return { ok: false, severity: "critical", reason: `元候选 from 与当前状态不一致（${k}）` };
  }
  const enums = META_ENUMS[k];
  const range = META_RANGES[k];
  if (enums) {
    if (typeof patch.to !== "string" || !enums.includes(patch.to)) {
      return {
        ok: false, severity: "critical",
        reason: `元维度 ${k} 值 ${String(patch.to)} 不在白名单 [${enums.join(", ")}]；拒绝任何放松 holdout 严格晋升的取值`,
      };
    }
  } else if (range) {
    const n = Number(patch.to);
    if (!Number.isFinite(n) || n < range[0] || n > range[1]) {
      return { ok: false, severity: "critical", reason: `元维度 ${k} 越界 [${range[0]}, ${range[1]}]` };
    }
  } else if (k === "policyRule") {
    if (typeof patch.to !== "boolean") return { ok: false, severity: "critical", reason: "policyRule 必须是布尔值" };
  }
  if (JSON.stringify(current[k]) === JSON.stringify(patch.to)) {
    return { ok: false, severity: "warning", reason: `元维度 ${k} 未产生实际变化` };
  }
  return { ok: true, severity: "warning", reason: "元候选合规（不触碰验证层级）" };
}

export function applyMetaPatch(meta: MetaState, patch: MetaPatch): MetaState {
  const next = { ...meta, [patch.key]: patch.to } as MetaState;
  return parseMeta(next); // 再过一次白名单解析，双保险
}

/** 相对当前状态生成单原子元候选；值已生效的维度不再重复提议。 */
export function proposeMetaCandidates(meta: MetaState): MetaPatch[] {
  const add = (out: MetaPatch[], key: keyof MetaState, to: unknown, reason: string): void => {
    if (JSON.stringify(meta[key]) === JSON.stringify(to)) return;
    out.push({
      id: shortHash(`meta|${key}|${JSON.stringify(to)}`),
      key, from: meta[key], to, reason,
    });
  };
  const out: MetaPatch[] = [];
  add(out, "plateauPatience", 1, "收敛后更早停止，减少无效基线评测");
  add(out, "evidenceLimit", 6, "收窄证据窗口，减少噪声候选");
  add(out, "candidateOrder", "evidence-first", "按失败证据量排序，优先评估高价值候选");
  add(out, "operatorSet", "lean", "裁剪从未命中的算子，节省 eval 预算");
  add(out, "editBudgetAdaptation", "plateau-expand", "平台期扩大编辑预算以跳出局部最优");
  add(out, "promotionStrictness", "efficiency-tiebreak", "holdout 打平但步数更优时允许破平局（不放松严格提升）");
  return out;
}

// ---------------------------------------------------------------- 元账本（只增）

function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value) + "\n", { flag: "a" });
}

export interface MetaLedgerEntry {
  ts: string;
  round: number;
  patch: MetaPatch;
  decision: "promoted" | "rejected" | "blocked" | "genesis";
  reason: string;
  baseline: MetaFitness;
  candidate: MetaFitness;
  integrityOk: boolean;
}

// ---------------------------------------------------------------- 报告

export interface MetaRoundRecord {
  round: number;
  candidates: number;
  promoted: number;
  rejected: number;
  blocked: number;
  bestKey: string | null;
  scoreBefore: number;
  scoreAfter: number;
  best?: { key: string; to: unknown; fitness: MetaFitness; reason: string };
}

export interface MetaReport {
  version: 1;
  agent: "bro2";
  timestamp: string;
  dryRun: boolean;
  baselineFitness: MetaFitness;
  finalFitness: MetaFitness;
  finalMeta: MetaState;
  rounds: MetaRoundRecord[];
  promoted: number;
  rejected: number;
  blocked: number;
  integrity: { ok: boolean; changed: string[] };
  ledgerPath: string;
  /** 可证伪声明：元改进证明了什么、没证明什么 */
  claim: string;
}

export interface MetaOptions {
  root: string;
  dryRun?: boolean;
  /** 从 DEFAULT_META 重新开始（默认 true，保证可复现） */
  reset?: boolean;
  rounds?: number;
  /** 每次短程 evolve 的代数上限，所有候选与基线必须一致以保证公平比较 */
  generations?: number;
  /** 测试通道：注入候选验证 tripwire（置于队列最前） */
  injectedPatches?: MetaPatch[];
  onProgress?: (line: string) => void;
}

const META_LEDGER_FILE = "meta-ledger.jsonl";
const META_REPORT_FILE = "meta-report.json";

export function metaPaths(root: string): { dir: string; state: string; ledger: string; report: string } {
  const dir = join(root, "data", "evolve");
  return {
    dir,
    state: metaStatePath(root),
    ledger: join(dir, META_LEDGER_FILE),
    report: join(root, "data", META_REPORT_FILE),
  };
}

/** 委托给 shadow.ts，保证与 runEvolve 默认加载的是同一份元状态。 */
export function loadMeta(root: string): MetaState {
  return loadMetaState(root);
}

export function saveMeta(root: string, meta: MetaState): void {
  saveMetaState(root, meta);
}

/** 一次隔离的短程 evolve，返回冻结 fitness。scratch 目录用完即删，不污染真实账本。 */
async function measure(
  root: string,
  meta: MetaState,
  generations: number,
): Promise<{ fitness: MetaFitness; integrityOk: boolean }> {
  const scratch = mkdtempSync(join(tmpdir(), "bro2-meta-"));
  try {
    const r = await runEvolve({
      root,
      scratchDir: scratch,
      dryRun: true,
      reset: true,
      generations,
      meta,
    });
    return { fitness: measureMetaFitness(r), integrityOk: r.integrity.ok };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function runMetaEvolve(options: MetaOptions): Promise<MetaReport> {
  const root = options.root;
  const dryRun = options.dryRun === true;
  const rounds = options.rounds ?? 3;
  const generations = options.generations ?? 8;
  const paths = metaPaths(root);
  const say = (l: string): void => options.onProgress?.(l);
  const baselineIntegrity = computeIntegrity(root);

  let meta = options.reset === false ? loadMeta(root) : { ...DEFAULT_META };
  const baseline = await measure(root, meta, generations);
  let current = baseline.fitness;
  const roundRecords: MetaRoundRecord[] = [];
  let promoted = 0;
  let rejected = 0;
  let blocked = 0;

  appendJsonl(paths.ledger, {
    ts: new Date().toISOString(), round: 0,
    patch: { id: "genesis", key: "version", from: 1, to: 1, reason: "元基线" },
    decision: "genesis", reason: "冻结评分面基线测量",
    baseline: baseline.fitness, candidate: baseline.fitness, integrityOk: baseline.integrityOk,
  } satisfies MetaLedgerEntry);

  for (let round = 1; round <= rounds; round += 1) {
    // 每轮开头复核写保护面：元改进绝不能顺手改掉尺子
    const changed = diffIntegrity(baselineIntegrity, computeIntegrity(root));
    if (changed.length > 0) {
      say(`  ⊘ 第 ${round} 轮中止：写保护面被修改 ${changed.join(", ")}`);
      break;
    }
    const candidates = [
      ...(round === 1 ? (options.injectedPatches ?? []) : []),
      ...proposeMetaCandidates(meta),
    ];
    let best: { patch: MetaPatch; fitness: MetaFitness; integrityOk: boolean } | null = null;
    let rPromoted = 0;
    let rRejected = 0;
    let rBlocked = 0;

    for (const p of candidates) {
      const chk = checkMetaPatch(p, meta);
      if (!chk.ok) {
        rBlocked += 1;
        blocked += 1;
        appendJsonl(paths.ledger, {
          ts: new Date().toISOString(), round, patch: p,
          decision: "blocked", reason: chk.reason,
          baseline: current, candidate: current, integrityOk: true,
        } satisfies MetaLedgerEntry);
        say(`  ⊘ 拦截 meta.${p.key}=${String(p.to)}: ${chk.reason}`);
        continue;
      }
      const candidateMeta = applyMetaPatch(meta, p);
      const res = await measure(root, candidateMeta, generations);
      const ok = metaPromotionOk(current, res.fitness, res.integrityOk);
      appendJsonl(paths.ledger, {
        ts: new Date().toISOString(), round, patch: p,
        decision: ok ? "promoted" : "rejected",
        reason: ok ? "能力不退化 + 冻结 fitness 严格提升" : "未满足单调晋升判据",
        baseline: current, candidate: res.fitness, integrityOk: res.integrityOk,
      } satisfies MetaLedgerEntry);
      if (ok && (!best || res.fitness.score > best.fitness.score)) {
        best = { patch: p, fitness: res.fitness, integrityOk: res.integrityOk };
      }
      if (!ok) { rRejected += 1; rejected += 1; }
      say(
        `  ${ok ? "✓" : "✗"} meta.${p.key}=${String(p.to)}  ` +
        `score ${res.fitness.score} (holdout ${res.fitness.finalHoldout}, eval ${res.fitness.evalRuns})`,
      );
    }

    // 单调晋升：每轮最多采纳 1 个，保证可归因
    if (best) {
      meta = applyMetaPatch(meta, best.patch);
      current = best.fitness;
      promoted += 1;
      rPromoted = 1;
      if (!dryRun) saveMeta(root, meta);
      say(`  → 第 ${round} 轮晋升 meta.${best.patch.key}=${String(best.patch.to)}，score ${current.score}`);
    } else {
      say(`  → 第 ${round} 轮无可晋升元改进，收敛`);
    }
    const rec: MetaRoundRecord = {
      round, candidates: candidates.length, promoted: rPromoted,
      rejected: rRejected, blocked: rBlocked,
      bestKey: best?.patch.key ?? null,
      scoreBefore: roundRecords.at(-1)?.scoreAfter ?? baseline.fitness.score,
      scoreAfter: current.score,
      ...(best ? { best: { key: best.patch.key, to: best.patch.to, fitness: best.fitness, reason: best.patch.reason } } : {}),
    };
    roundRecords.push(rec);
    if (!best) break;
  }

  const finalChanged = diffIntegrity(baselineIntegrity, computeIntegrity(root));
  const report: MetaReport = {
    version: 1,
    agent: "bro2",
    timestamp: new Date().toISOString(),
    dryRun,
    baselineFitness: baseline.fitness,
    finalFitness: current,
    finalMeta: meta,
    rounds: roundRecords,
    promoted, rejected, blocked,
    integrity: { ok: finalChanged.length === 0, changed: finalChanged },
    ledgerPath: paths.ledger,
    claim: "证明的是「改进机制在冻结 fitness 上单调提升且能力不退化」，不是模型变聪明；基座模型始终冻结。",
  };
  if (!dryRun) writeFileSync(paths.report, JSON.stringify(report, null, 2));
  return report;
}

export function formatMetaReport(r: MetaReport): string {
  const L: string[] = [];
  const bar = "=".repeat(84);
  L.push(bar);
  L.push(`  bro2 · meta RSI 报告   改进改进机制自身   dryRun=${r.dryRun}`);
  L.push(bar);
  L.push("");
  L.push("  【冻结 fitness 曲线】");
  L.push(`   基线 score=${r.baselineFitness.score}  (holdout ${r.baselineFitness.finalHoldout} · eval ${r.baselineFitness.evalRuns} · efficiency ${r.baselineFitness.efficiency})`);
  for (const round of r.rounds) {
    L.push(`   #${round.round}  候选 ${round.candidates}  晋升 ${round.promoted}  拒绝 ${round.rejected}  拦截 ${round.blocked}`);
    L.push(`        score ${round.scoreBefore} → ${round.scoreAfter}${round.best ? `  ← meta.${round.best.key}=${String(round.best.to)}` : "  （收敛）"}`);
  }
  L.push(`   最终 score=${r.finalFitness.score}  holdout=${r.finalFitness.finalHoldout}  eval=${r.finalFitness.evalRuns}`);
  L.push("");
  L.push("  【最终元状态】");
  for (const k of META_KEYS) L.push(`   ${String(k).padEnd(24)} ${String(r.finalMeta[k]).padEnd(20)} ${META_DESCRIPTIONS[k]}`);
  L.push("");
  L.push("  【治理】");
  L.push(`   写保护面 ${r.integrity.ok ? "✓ 未变更" : `✗ ${r.integrity.changed.join(", ")}`}`);
  L.push(`   晋升 ${r.promoted} · 拒绝 ${r.rejected} · 拦截 ${r.blocked}（含危险值注入）`);
  L.push(`   元账本 ${r.ledgerPath}`);
  L.push("");
  L.push(`   ${r.claim}`);
  L.push(bar);
  return L.join("\n");
}
