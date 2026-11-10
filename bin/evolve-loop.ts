/**
 * bro2 · 进化启动器（v2.2.0）
 *
 * 用法：
 *   npm run evolve:tick -- --rounds 8     推进 8 轮（默认 1 轮）
 *   npm run evolve:tick -- --reset --rounds 8   清空账本重新起跑（显式才允许）
 *   npm run watermark                     只看不改，打印水位并刷新看板
 *
 * 为什么需要它：v2.1.0 的复利闭环只存在于「临时目录演示」里，跑完 rmSync 删除，
 * 真实账本 0 条记录——尺子有了，刻度是空的。本启动器把闭环接到**持久只增账本**，
 * 每次运行都推进若干轮，跨会话累积，于是「越用改进越快」第一次成为可查看的水位。
 *
 * 每一轮都是真实执行，没有任何手搓的行为摘要：
 *   1) 从 data/rsi/compound-tasks.jsonl 取一批真实故障注入任务（与主评测集隔离）；
 *   2) runEval 以 malformedArgs=fail 实跑 → baselineFromRuns 得到基线行为摘要；
 *   3) 预测本轮将被经验裁剪后实际探测的候选，**只为这些候选** runEval 实跑
 *      对应 harness 策略变体 → 真实 probed 行为摘要；
 *   4) compoundProbe 用惰性 probe 钩子取用轨迹，接受判定仍走全量行为对比，
 *      候选自报 scoreGain 不参与判定；经验回写 + 速度账本 append；
 *   5) 断言「真实候选评测次数 === attempts」，证明复利省的是真计算而非纸面数字。
 *
 * 诚实边界：轨迹来自 deterministic 模型脚本 + 真实 harness 代码分支，不是模型能力
 * 分数；verdict 仍 not-proven、L4 仍 not-achieved。跨失败模式泛化属 P3、异步按需
 * 探测属 P4，均未实现。
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { runEval, loadTasks } from "../src/observability/eval.ts";
import type { EvalTask, EvalRunMetrics } from "../src/observability/eval.ts";
import { baselineFromRuns, toRunSummary } from "../src/rsi/contrast.ts";
import type { LiveCandidate } from "../src/rsi/contrast.ts";
import { ExperienceBank, failureSignature, experiencePath } from "../src/rsi/experience.ts";
import { VelocityLedger, velocityPath } from "../src/rsi/velocity.ts";
import { compoundProbe, EXPLORE_SLOTS } from "../src/rsi/contrast.ts";
import type { PendingCandidate } from "../src/rsi/contrast.ts";
import { buildWatermark, formatWatermark, renderWatermarkHtml } from "../src/rsi/watermark.ts";
import { markdownWatermark } from "../scripts/watermark-doc.ts";
import type { RunSummary } from "../src/rsi/contrast.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = velocityPath(ROOT);
const BANK = experiencePath(ROOT);
const HTML = resolve(ROOT, "data/rsi/watermark.html");
const JSON_OUT = resolve(ROOT, "data/rsi/watermark.json");
const DOC = resolve(ROOT, "docs/ITERATION-WATERMARK.md");
const TASKS_FILE = resolve(ROOT, "data/rsi/compound-tasks.jsonl");

const line = (s = ""): void => { process.stdout.write(s + "\n"); };

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
let rounds = 1;
let reset = false;
let viewOnly = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]!;
  if (a === "--rounds") rounds = Math.max(1, Math.floor(Number(argv[i + 1] ?? 1)) || 1);
  else if (a === "--reset") reset = true;
  else if (a === "--view" || a === "--watch") viewOnly = true;
  else if (a === "--help" || a === "-h") {
    line("用法: npm run evolve:tick -- [--rounds N] [--reset] [--view]");
    line("  --rounds N  推进 N 轮真实迭代（默认 1）");
    line("  --reset     清空持久账本重新起跑（需显式指定，默认只增不改）");
    line("  --view      只读查看水位，不推进、不写账本");
    process.exit(0);
  }
}

/** 真实 harness 策略变体：每个 id 对应一次 configOverride 实跑。 */
interface Variant { label: string; override: Record<string, unknown>; scoreGain?: number }
const VARIANTS: Record<string, Variant> = {
  "enable-args-repair": {
    label: "启用受控参数修复（malformedArgs=repair，真实代码分支）",
    override: { policy: { malformedArgs: "repair" } },
  },
  "noop-tuning": {
    label: "空调整（compaction=truncate，行为不变）",
    override: { policy: { compaction: "truncate" } },
  },
  "score-only-hack": {
    label: "只抬高自报分数、不改任何行为（应被判 reward hacking）",
    override: { policy: { compaction: "truncate" } },
    scoreGain: 0.8,
  },
};
const BASELINE_OVERRIDE = { policy: { malformedArgs: "fail" } };

const pending: PendingCandidate[] = Object.entries(VARIANTS).map(([id, v]) => ({
  id,
  description: v.label,
  focus: "tool-error",
  ...(v.scoreGain !== undefined ? { scoreGain: v.scoreGain } : {}),
}));

/** 一次真实评测 → 域级行为摘要。绝不手搓数字。 */
async function realSummary(tasks: EvalTask[], override: Record<string, unknown>): Promise<RunSummary> {
  const rep = await runEval({
    tasks, mode: "deterministic", k: 1, root: ROOT, baseline: null,
    configOverride: override as never,
  });
  return baselineFromRuns(rep.runs as EvalRunMetrics[]);
}

/** 持久化水位报告（账本派生，可随时重建）。 */
function refreshViews(): void {
  const ledger = new VelocityLedger(LEDGER);
  const bank = new ExperienceBank(BANK);
  const report = buildWatermark(ledger, bank);
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(HTML, renderWatermarkHtml(report), "utf8");
  writeFileSync(DOC, markdownWatermark(report), "utf8");
  line(formatWatermark(report));
  line(`  看板已刷新: ${HTML}`);
  line(`  数据: ${JSON_OUT}   文档: ${DOC}`);
}

if (viewOnly) {
  refreshViews();
  process.exit(0);
}

if (reset) {
  line("  ⚠ 显式 --reset：清空持久只增账本，水位从 0 重新累积（仅用于重新起跑演示）");
  for (const p of [LEDGER, BANK, HTML, JSON_OUT, DOC]) rmSync(p, { force: true });
}

const tasks = loadTasks(TASKS_FILE);
if (tasks.length < 2) throw new Error("复利工作负载至少需要 2 个任务");

line("");
line("════════════════════════════════════════════════════════════════════════════════");
line(`  bro2 · 进化启动器  |  推进 ${rounds} 轮  |  账本 ${LEDGER}`);
line("  每轮轨迹均来自 runEval 真实评测；被经验裁剪的候选不触发评测。");
line("════════════════════════════════════════════════════════════════════════════════");
line("  轮  工作负载        探测  真实评测  跳过  首轮命中  接受  回退  截至该轮趋势");
line("  " + "-".repeat(88));

for (let n = 0; n < rounds; n += 1) {
  const ledger = new VelocityLedger(LEDGER);
  const bank = new ExperienceBank(BANK);   // 每轮新建实例 → 模拟跨会话复用
  const seq = ledger.records().length;
  const batch: EvalTask[] = [tasks[seq % tasks.length]!, tasks[(seq + 1) % tasks.length]!];

  // 1) 真实基线轨迹
  const baseline = await realSummary(batch, BASELINE_OVERRIDE);
  const signature = failureSignature(baseline);

  // 2) 预测本轮实际探测集（与 compound.ts 的裁剪公式一致，复用同一 bank 实例）
  const plan = bank.prioritize("harness-edit", signature, pending, (c) => c.id);
  const k = plan.hits > 0
    ? Math.max(1, Math.min(plan.hits + EXPLORE_SLOTS, pending.length))
    : pending.length;
  const plannedIds = plan.prioritized.slice(0, k).map((c) => c.id);

  // 3) 只为预测会被探测的候选真实跑评测（被裁剪的候选不产生任何计算）
  const trajectories = new Map<string, RunSummary>();
  for (const id of plannedIds) {
    trajectories.set(id, await realSummary(batch, VARIANTS[id]!.override));
  }

  const probe = (c: PendingCandidate): LiveCandidate => {
    const probed = trajectories.get(c.id);
    if (!probed) {
      // 经验不灵触发回退、需要补充探测时，绝不伪造：抛错由上层降级为全量重跑
      throw new Error(`候选 ${c.id} 未预先实跑（可能发生经验回退），拒绝伪造行为摘要`);
    }
    return { ...c, probed } as LiveCandidate;
  };

  let fallbackRerun = false;
  let result;
  try {
    result = compoundProbe(baseline, pending, bank, ledger, {
      signature, probe, source: "evolve-loop",
    });
  } catch (err) {
    // 诚实降级：补齐全部候选的真实轨迹后重跑本轮；账本尚未 append，无脏数据
    fallbackRerun = true;
    for (const c of pending) {
      if (!trajectories.has(c.id)) trajectories.set(c.id, await realSummary(batch, VARIANTS[c.id]!.override));
    }
    result = compoundProbe(baseline, pending, bank, ledger, {
      signature, probe, source: "evolve-loop#fallback-rerun",
    });
    if (!(err instanceof Error)) throw err;
  }

  // 4) 强断言：真实候选评测次数必须等于 attempts，否则复利只是纸面裁剪
  const realCandidateEvals = trajectories.size;
  if (realCandidateEvals !== result.attempts) {
    throw new Error(`复利真实性校验失败：真实评测 ${realCandidateEvals} ≠ attempts ${result.attempts}`);
  }

  const snap = new VelocityLedger(LEDGER).snapshot();
  line("  " + String(seq + 1).padEnd(4)
    + batch.map((t) => t.id).join("+").padEnd(16)
    + String(result.attempts).padEnd(6)
    + String(realCandidateEvals + 1).padEnd(10)
    + String(result.probesAvoided).padEnd(6)
    + (result.firstTryHit ? "是" : "否").padEnd(10)
    + String(result.improvement).padEnd(6)
    + (result.usedFallback ? "是" : "否").padEnd(6)
    + snap.trend + (fallbackRerun ? "  (经验回退→全量重跑)" : ""));
}

line("");
refreshViews();
