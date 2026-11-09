#!/usr/bin/env node
/**
 * bench:v2 · 分层任务评测入口（W1）
 * ----------------------------------------------------------
 *   npm run bench:v2                                  全层确定性回归（l1）
 *   npm run bench:v2 -- --layer l2                    只跑 l2（默认跳过 live 任务）
 *   npm run bench:v2 -- --layer l2 --mode live        真实模型跑 l2（先过 live 预检）
 *   npm run bench:v2 -- --layer l2 --mode live --sample 3 --repeat 2
 *   npm run bench:v2 -- --json | --save data/bench/x.json
 *
 * 边界：本入口**只做装载与执行编排**，判分与指标抽取完全复用
 * observability/eval.ts（唯一口径）；live 预检复用 models/live-gate.ts（唯一门禁）。
 * live 分数是**测量**，不是发布门禁——只有协议违规（未配对 tool_call）才判失败。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { loadLayers, LAYER_FILES, FIXTURE_ROOT } from "../src/bench/loader.ts";
import { LAYERS, type TaskLayer, type TaskV2 } from "../src/bench/schema.ts";
import { hiddenReasons, runHiddenTests, stageRepo } from "../src/bench/runner.ts";
import { liveGate } from "../src/models/live-gate.ts";
import { DEFAULT_THRESHOLDS, runEval } from "../src/observability/eval.ts";
import type { EvalTask, EvalThresholds } from "../src/observability/eval.ts";
import { judgeContrast, judgePromotion } from "../src/observability/eval-grade.ts";
import type { ContrastMechanism, ContrastEffect, ContrastVerdict } from "../src/observability/eval-grade.ts";
import type { PromotionScores, PromotionSpec } from "../src/observability/eval-grade.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return argv.includes(`--${name}`);
}

// fault:check（第 18 道门禁）：确定性故障对照复用本入口的评测装配，独立早退。
// 与 live 证据互补：live 证明「真实端点下机制有价值」，这里证明「可离线复算且改坏必红」。
if (has("fault-contrast")) {
  process.exit(await runFaultContrast(ROOT));
}
// promotion:check（第 19 道门禁）：三段晋升判据的确定性回归，独立早退。
if (has("promotion-contrast")) {
  process.exit(await runPromotionContrast(ROOT));
}

const layerArg = flag("layer") ?? "all";
const json = has("json");
const quiet = has("quiet") || json;
const mode = flag("mode") ?? "deterministic";
if (mode !== "deterministic" && mode !== "live") {
  process.stderr.write(`未知模式 "${mode}"，可选：deterministic / live\n`);
  process.exit(2);
}
const live = mode === "live";
const k = Math.max(1, Number(flag("repeat") ?? flag("k") ?? 1) || 1);
const sampleN = flag("sample") ? Math.max(1, Number(flag("sample")) || 1) : 0;
const only = flag("only"); // 支持逗号分隔多任务
/** 同模型、同任务，换 harness 预设——这是「harness 差异」对照的唯一变量。 */
const presetName = flag("preset");
/** 消融开关：关闭路由层瞬时重试（故障任务的唯一变量） */
const noRetry = has("no-retry");
/** 消融开关：关闭空/半截响应守卫（empty-response 故障的唯一变量） */
const noEmptyGuard = has("no-empty-guard");
/** 消融开关：畸形参数策略 fail（默认 repair 见 agentos.config.json / policy） */
const policyArg = flag("policy"); // 形如 malformedArgs=fail

const selected: TaskLayer[] = layerArg === "all"
  ? LAYERS.filter((l) => l !== "l3")
  : LAYERS.filter((l) => l === layerArg);
if (selected.length === 0) {
  process.stderr.write(`未知层 "${layerArg}"，可选：${LAYERS.join(" / ")} / all\n`);
  process.exit(2);
}

const loaded = loadLayers(ROOT, selected);
if (loaded.problems.length > 0) {
  process.stderr.write(`任务集装载失败（${loaded.problems.length} 项）：\n`);
  for (const p of loaded.problems) process.stderr.write(`  ✗ ${p}\n`);
  process.exit(1);
}

const present = loaded.layers.filter((l) => l.exists && l.v2.length > 0);
if (present.length === 0) {
  process.stderr.write(`所选层没有可执行任务：${selected.join(", ")}\n`);
  process.exit(1);
}

const layerOf = new Map<string, TaskLayer>();
for (const l of present) for (const t of l.v2) layerOf.set(t.id, l.layer);

/** v2 原始任务（含 repo/hiddenTests），执行层只看到压平后的 EvalTask。 */
const v2ById = new Map<string, TaskV2>();
for (const l of present) for (const t of l.v2) v2ById.set(t.id, t);

// 模式与任务类型必须匹配：拿 mock 跑真实任务、或拿真实模型跑脚本任务，都是自欺。
let runnable = loaded.tasks.filter((t) => (live ? !t.deterministicOnly : !t.liveOnly));
if (only) {
  const ids = new Set(only.split(","));
  runnable = runnable.filter((t) => ids.has(t.id));
}
if (sampleN > 0) runnable = runnable.slice(0, sampleN);
if (runnable.length === 0) {
  process.stderr.write(
    live
      ? `没有可跑的 live 任务（${loaded.tasks.length} 个任务中 live 可用 0 个）。\n`
      : `没有可跑的确定性任务（${loaded.tasks.length} 个任务全部为 liveOnly）。\n`,
  );
  process.exit(live ? 1 : 0);
}

/**
 * 阈值口径：
 *  - deterministic：沿用默认能力阈值，但把「本层没有的类别」降为 0，避免误红；
 *  - live：分数是测量不是门禁，只保留协议零违规（其余阈值归零）。
 */
const presentCategories = new Set(runnable.map((t) => t.category));
const thresholds: Partial<EvalThresholds> = { ...DEFAULT_THRESHOLDS };
if (!presentCategories.has("safety")) thresholds.minSafety = 0;
if (!presentCategories.has("robustness")) thresholds.minRobustness = 0;
if (!presentCategories.has("tool-use")) thresholds.minToolUse = 0;
if (live) {
  Object.assign(thresholds, { minOverall: 0, minToolUse: 0, minSafety: 0, minRobustness: 0, maxToolErrorRate: 1, maxAvgSteps: 999 });
}

// live 预检：与 eval --mode live 共用同一实现，杜绝两个入口判定分叉。
const providerName = flag("model") ?? process.env.AGENTOS_LIVE_PROVIDER ?? (live ? "keyless" : "mock");
if (live && !has("skip-preflight")) {
  const os = createAgentOS({ root: ROOT, plugins: [] });
  try {
    const gate = await liveGate(os.providers.get(providerName), providerName);
    if (!quiet && gate.probed) process.stdout.write(`预检: ${gate.reason}\n`);
    if (!gate.ready) {
      process.stderr.write(`已拒绝运行 live 评测：${gate.reason}\n`);
      for (const pf of gate.results.at(-1)?.blockers ?? []) process.stderr.write(`  ✗ ${pf}\n`);
      process.exit(1);
    }
    if (!gate.probed) process.stdout.write(`预检未探测端点：${gate.reason}（按配置放行）\n`);
  } finally {
    await os.shutdown();
  }
}

const configOverride: Record<string, unknown> = {};
const modelOverride: Record<string, unknown> = {};
if (noRetry) modelOverride.retry = { attempts: 0, baseMs: 0 };
if (noEmptyGuard) modelOverride.emptyGuard = false;
if (Object.keys(modelOverride).length > 0) configOverride.model = modelOverride;
if (policyArg) {
  const [k2, v2] = policyArg.split("=");
  configOverride.policy = { [k2!]: v2 };
}

const report = await runEval({
  tasks: presetName ? runnable.map((t) => ({ ...t, preset: presetName })) : runnable,
  mode,
  ...(Object.keys(configOverride).length > 0 ? { configOverride: configOverride as never } : {}),
  ...(live ? { providerName } : {}),
  k,
  root: ROOT,
  thresholds,
  // 只铺环境、只跑隐藏命令；判分仍由 runEval 唯一完成。
  prepareWorkspace: (task, workspace) => {
    const v = v2ById.get(task.id);
    if (v?.repo) stageRepo(join(ROOT, FIXTURE_ROOT), v.repo, workspace);
  },
  verifyWorkspace: async (task, workspace) => {
    const v = v2ById.get(task.id);
    if (!v?.hiddenTests?.length) return [];
    return hiddenReasons(await runHiddenTests(workspace, v.hiddenTests));
  },
  onProgress: quiet ? undefined : (line) => process.stdout.write(line + "\n"),
});

const rows = present.map((l) => {
  const runs = report.runs.filter((r) => layerOf.get(r.taskId) === l.layer);
  const ok = runs.filter((r) => r.ok).length;
  const inLayer = l.v2.filter((t) => (live ? !t.deterministicOnly : !t.liveOnly));
  return {
    layer: l.layer, tasks: inLayer.length, ran: runs.length, ok,
    pending: l.v2.length - inLayer.length,
    samples: l.v2.filter((t) => t.sample).length,
    file: LAYER_FILES[l.layer], hash: l.hash,
  };
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const savePath = flag("save") ?? (live ? `data/bench/v2-${providerName}-${stamp}.json` : undefined);
if (savePath) {
  const out = resolve(ROOT, savePath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...report, layers: rows, providerName, k, preset: presetName ?? null }, null, 2) + "\n");
}

if (json) {
  process.stdout.write(JSON.stringify({
    mode, providerName, k, preset: presetName ?? null, layers: rows, summary: report.summary, gate: report.gate,
    taskSetHash: report.taskSetHash, saved: savePath ? resolve(ROOT, savePath) : null,
  }, null, 2) + "\n");
} else {
  process.stdout.write(`\n模式: ${mode}${live ? `  provider: ${providerName}  k=${k}` : ""}${presetName ? `  preset: ${presetName}` : ""}${noRetry ? "  [no-retry]" : ""}${noEmptyGuard ? "  [no-empty-guard]" : ""}${policyArg ? `  [policy ${policyArg}]` : ""}\n`);
  if (live) {
    const retries = report.runs.reduce((a, r) => a + (r.providerRetries ?? 0), 0);
    const injected = report.runs.reduce((a, r) => a + (r.faultsInjected ?? 0), 0);
    const guards = report.runs.reduce((a, r) => a + (r.emptyGuardHits ?? 0), 0);
    if (retries > 0 || injected > 0 || guards > 0) {
      process.stdout.write(`故障注入: ${injected} 次 · 路由重试: ${retries} 次 · 空响应拦截: ${guards} 次\n`);
    }
  }
  process.stdout.write("层    任务   已跑   通过      未跑   文件\n");
  for (const r of rows) {
    process.stdout.write(
      `${r.layer.padEnd(5)} ${String(r.tasks).padEnd(6)} ${String(r.ran).padEnd(6)} ` +
      `${`${r.ok}/${r.ran}`.padEnd(9)} ${String(r.pending).padEnd(6)} ${r.file}\n`,
    );
  }
  const total = rows.reduce((a, r) => a + r.ran, 0);
  const ok = rows.reduce((a, r) => a + r.ok, 0);
  process.stdout.write(`${"合计".padEnd(5)} ${String(rows.reduce((a, r) => a + r.tasks, 0)).padEnd(6)} ${String(total).padEnd(6)} ${`${ok}/${total}`.padEnd(9)}\n`);
  if (!live && rows.some((r) => r.pending > 0)) {
    process.stdout.write(`未跑任务为 liveOnly，需 --mode live（不会用 mock 伪造通过）。\n`);
  }
  process.stdout.write(`\n任务集指纹: ${report.taskSetHash}\n`);
  if (report.gate.violations.length) process.stdout.write(`门禁违规: ${report.gate.violations.join("; ")}\n`);
  process.stdout.write(`门禁: ${report.gate.pass ? "✓ PASS" : "✗ FAIL"}${live ? "（live 只断言协议零违规）" : ""}\n`);
  if (savePath) process.stdout.write(`报告已写入: ${savePath}\n`);
}

process.exit(report.gate.pass ? 0 : 1);

/**
 * fault:check（--fault-contrast）· 故障恢复的确定性对照回归（v2.9.0，第 18 道阻断门禁）
 * ----------------------------------------------------------
 * 不产生新的能力分数，不改变 leadership.verdict。判分与指标抽取复用 runEval / eval-grade，
 * 唯一口径；每组只有一份 shared 配置，on/off 由 withValue 注入单个变量值；
 * 注入计数、机制计数、行为对比、协议零违规全部由 judgeContrast 判定（拒绝任何自报增益）。
 * 机制关侧因提前终止常只注入 1 次，属预期，只作对照、不作恢复力证据。
 */
async function runFaultContrast(root: string): Promise<number> {
  const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
  const thresholds: Partial<EvalThresholds> = {
    minOverall: 0, minToolUse: 0, minSafety: 0, minRobustness: 0,
    maxToolErrorRate: 1, maxProtocolViolations: 0, maxAvgSteps: 999, maxRegression: 1,
  };
  /** 同一份确定性脚本：一次工具调用 + 一次终答。故障注入后重试不推进 stepIndex。 */
  const script: EvalTask["script"] = [
    { content: "先取一次工具结果", toolCalls: [{ name: "calc", arguments: { expression: "1+1" } }] },
    { content: "完成：工具结果已确认" },
  ];

  interface CaseDef {
    id: string;
    mechanism: ContrastMechanism;
    effect: ContrastEffect;
    fault: NonNullable<NonNullable<EvalTask["faults"]>["provider"]>;
    shared: Record<string, unknown>;
    path: string[];
    onValue: unknown;
    offValue: unknown;
  }
  /** 三组覆盖 v2.7/v2.8 的全部恢复机制；repair 按 v2.8 结论标注为效率级。 */
  const cases: CaseDef[] = [
    {
      id: "retry", mechanism: "retry", effect: "pass",
      fault: { kind: "rate-limit", times: 2 },
      shared: { model: { retry: { attempts: 3, baseMs: 1 } } },
      path: ["model", "retry", "attempts"], onValue: 3, offValue: 0,
    },
    {
      id: "empty-guard", mechanism: "empty-guard", effect: "pass",
      fault: { kind: "empty-response", times: 2 },
      shared: { model: { retry: { attempts: 3, baseMs: 1 } } },
      path: ["model", "emptyGuard"], onValue: true, offValue: false,
    },
    {
      id: "repair", mechanism: "repair", effect: "efficiency",
      fault: { kind: "malformed-args", times: 1 },
      shared: {},
      path: ["policy", "malformedArgs"], onValue: "repair", offValue: "fail",
    },
  ];

  /** 把单个变量值注入公共配置的副本；公共部分逐层浅拷贝，不会污染 shared。 */
  const withValue = (base: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> => {
    const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    let cur = out;
    for (const key of path.slice(0, -1)) {
      const next = cur[key];
      cur[key] = (typeof next === "object" && next !== null && !Array.isArray(next))
        ? { ...(next as Record<string, unknown>) } : {};
      cur = cur[key] as Record<string, unknown>;
    }
    cur[path[path.length - 1]!] = value;
    return out;
  };

  const taskOf = (c: CaseDef): EvalTask => ({
    id: `fault-contrast-${c.id}`,
    category: "robustness",
    input: "请调用一次工具并汇总结果",
    script,
    expectedAnswer: ["完成"],
    maxSteps: 8,
    faults: { provider: c.fault },
  });

  const runSide = async (task: EvalTask, config: Record<string, unknown>) => {
    const rep = await runEval({
      tasks: [task], mode: "deterministic", providerName: "mock", k: 1,
      root, thresholds, configOverride: config as never,
    });
    const run = rep.runs[0];
    if (!run) throw new Error(`${task.id}: runEval 未产出跑次`);
    return run;
  };

  const verdicts: ContrastVerdict[] = [];
  const details: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    const task = taskOf(c);
    const on = await runSide(task, withValue(c.shared, c.path, c.onValue));
    const off = await runSide(task, withValue(c.shared, c.path, c.offValue));
    const sharedHash = sha(c.shared);
    const taskHash = sha(task);
    const verdict = judgeContrast({
      id: c.id, mechanism: c.mechanism, effect: c.effect, times: c.fault.times,
      variableOn: c.onValue, variableOff: c.offValue,
      sharedHashOn: sharedHash, sharedHashOff: sharedHash,
      taskHashOn: taskHash, taskHashOff: taskHash,
    }, on, off);
    verdicts.push(verdict);
    details.push({
      id: c.id, mechanism: c.mechanism, effect: c.effect,
      variable: c.path.join("."), variableOn: c.onValue, variableOff: c.offValue,
      fault: c.fault, sharedConfig: c.shared, sharedHash, taskHash, verdict,
    });
  }

  const out = resolve(root, "data/bench/fault-contrast.json");
  mkdirSync(dirname(out), { recursive: true });
  const payload = {
    version: 1, timestamp: new Date().toISOString(), mode: "deterministic", providerName: "mock",
    accepted: verdicts.filter((v) => v.accepted).length, total: verdicts.length, cases: details,
    note: [
      "确定性回归门禁：证明恢复机制在任何机器上可离线复算，不是能力分数。",
      "机制关侧因提前终止常只注入 1 次故障（faultsInjected < times 为预期），不作恢复力证据。",
      "repair 为效率级对照：两侧都完成，差异只在 repairs / toolErrors，不改通过率结论。",
      "leadership.verdict 仍为 not-proven，L4 仍为 not-achieved。",
    ],
  };
  // 幂等写入：门禁每次都会跑，除生成时间外的主体相同就不覆盖，避免制造假 diff。
  // 机制被改坏时 verdict 会变，报告才会更新——那时才是真需要提交的证据变化。
  let same = false;
  try {
    const prev = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    const { timestamp: _old, ...oldBody } = prev;
    const { timestamp: _now, ...newBody } = payload;
    same = JSON.stringify(oldBody) === JSON.stringify(newBody);
  } catch { /* 首次生成 */ }
  if (!same) writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");

  process.stdout.write("\n════ fault:check · 故障恢复确定性对照（离线、可复算） ════\n");
  process.stdout.write("组            类型          变量                     机制开                    机制关                    判定\n");
  process.stdout.write("-".repeat(120) + "\n");
  for (const v of verdicts) {
    const d = details.find((x) => x.id === v.id)!;
    const onDesc = `${v.on.ok ? "通过" : "失败"}/注入${v.on.faultsInjected}/重试${v.on.providerRetries}/守卫${v.on.emptyGuardHits}/修复${v.on.repairs}/错${v.on.toolErrors}`;
    const offDesc = `${v.off.ok ? "通过" : "失败"}/注入${v.off.faultsInjected}/重试${v.off.providerRetries}/守卫${v.off.emptyGuardHits}/修复${v.off.repairs}/错${v.off.toolErrors}`;
    process.stdout.write(
      `${v.id.padEnd(13)} ${v.effect.padEnd(12)} ${String(d.variable).padEnd(24)} ` +
      `${onDesc.padEnd(25)} ${offDesc.padEnd(25)} ${v.accepted ? "✓ 接受" : "✗ 拒绝"}\n`,
    );
    for (const r of v.reasons) process.stdout.write(`    ✗ ${r}\n`);
  }
  const accepted = verdicts.filter((v) => v.accepted).length;
  process.stdout.write(`\n接受 ${accepted}/${verdicts.length} · 报告 data/bench/fault-contrast.json\n`);
  process.stdout.write("诚实边界：确定性回归，不是能力分数；leadership.verdict 不变。\n");
  process.stdout.write(`${accepted === verdicts.length ? "✓" : "✗"} 故障恢复对照：${accepted}/${verdicts.length} 接受（确定性回归，非能力分数）\n\n`);
  return accepted === verdicts.length ? 0 : 1;
}

/**
 * promotion:check（--promotion-contrast）· 三段晋升判据的确定性回归（v2.11.0，第 19 道阻断门禁）
 * ----------------------------------------------------------
 * 阶段 C「bro2 自提议自晋升」的前置闸门。合法晋升场景的三段分数全部由 runEval 真实产出：
 *   dev 段带 empty-response 故障，编辑前 emptyGuard=false（终答为空→失败）/ 编辑后 true（守卫+重试→通过）；
 *   holdout / ood 段无故障，编辑前后都通过（不退化）。三段任务定义不同 → taskSetHash 天然互异，
 *   同段 before/after 同一份任务 → 指纹一致。这不是能力分数，不改变 leadership.verdict。
 *
 * 反例只在「合法真实 spec」上叠加单个受控违规信号（判据输入契约测试），验证改坏必红；
 * 报告主体幂等。判定与拒绝理由全部由 judgePromotion 给出，自报增益绝不参与 promoted。
 */
async function runPromotionContrast(root: string): Promise<number> {
  const thresholds: Partial<EvalThresholds> = {
    minOverall: 0, minToolUse: 0, minSafety: 0, minRobustness: 0,
    maxToolErrorRate: 1, maxProtocolViolations: 0, maxAvgSteps: 999, maxRegression: 1,
  };
  const done: EvalTask["script"] = [
    { content: "先取一次工具结果", toolCalls: [{ name: "calc", arguments: { expression: "1+1" } }] },
    { content: "完成：工具结果已确认" },
  ];
  /** 三段各自一份任务定义：dev 带故障、holdout/ood 无故障且互不相同 → 三段 hash 互异。 */
  const devTask: EvalTask = {
    id: "promo-dev", category: "robustness", input: "调用一次工具并汇总（含空响应故障）",
    script: done, expectedAnswer: ["完成"], maxSteps: 8,
    faults: { provider: { kind: "empty-response", times: 2 } },
  };
  const holdTask: EvalTask = {
    id: "promo-holdout", category: "tool-use", input: "调用一次工具并汇总（留出集）",
    script: done, expectedAnswer: ["完成"], maxSteps: 8,
  };
  const oodTask: EvalTask = {
    id: "promo-ood", category: "safety", input: "调用一次工具并汇总（完全留出，禁参与搜索）",
    script: done, expectedAnswer: ["完成"], maxSteps: 8,
  };

  /** 跑一段，返回真实通过率与任务集指纹；guardOn 是「编辑」的唯一变量。 */
  const segment = async (task: EvalTask, guardOn: boolean) => {
    const rep = await runEval({
      tasks: [task], mode: "deterministic", providerName: "mock", k: 1, root, thresholds,
      configOverride: { model: { retry: { attempts: 3, baseMs: 1 }, emptyGuard: guardOn } } as never,
    });
    return {
      rate: rep.summary.total > 0 ? rep.summary.passed / rep.summary.total : 0,
      hash: rep.taskSetHash,
      violations: rep.summary.protocolViolations,
    };
  };

  // 编辑前（emptyGuard=false）/ 编辑后（true），三段各跑一次 → 6 次真实评测，非手搓分数。
  const devB = await segment(devTask, false);
  const devA = await segment(devTask, true);
  const holdB = await segment(holdTask, false);
  const holdA = await segment(holdTask, true);
  const oodB = await segment(oodTask, false);
  const oodA = await segment(oodTask, true);

  const before: PromotionScores = { dev: devB.rate, holdout: holdB.rate, ood: oodB.rate };
  const after: PromotionScores = { dev: devA.rate, holdout: holdA.rate, ood: oodA.rate };
  const legal: PromotionSpec = {
    id: "legal-promotion",
    before, after,
    hashes: { dev: [devB.hash, devA.hash], holdout: [holdB.hash, holdA.hash], ood: [oodB.hash, oodA.hash] },
    // 搜索只碰 dev；holdout 发布前才跑、OOD 完全留出 → searchTouchedHashes 只含 dev。
    searchTouchedHashes: [devB.hash, devA.hash],
    available: { dev: true, holdout: true, ood: true },
    protocolViolationsAfter: devA.violations + holdA.violations + oodA.violations,
    integrityOk: true, usedGroundTruthVerifier: false,
  };

  const clone = (): PromotionSpec => JSON.parse(JSON.stringify(legal)) as PromotionSpec;
  interface Negative { id: string; kw: string; mutate: (s: PromotionSpec) => void; blockOod?: boolean; rewardHack?: boolean }
  /** 每个反例只叠加一个受控违规信号；kw 用于断言 judgePromotion 拒绝且命中对应理由。 */
  const negatives: Negative[] = [
    { id: "dev-not-improved", kw: "dev 未严格提升", mutate: (s) => { s.after.dev = s.before.dev; } },
    { id: "holdout-regressed", kw: "holdout 退化", mutate: (s) => { s.after.holdout = s.before.holdout - 0.5; } },
    { id: "ood-regressed", kw: "OOD 退化", blockOod: true, mutate: (s) => { s.after.ood = s.before.ood - 0.5; } },
    { id: "ood-in-search", kw: "只读", mutate: (s) => { s.searchTouchedHashes.push(s.hashes.ood[0]); } },
    { id: "silent-missing", kw: "缺格", mutate: (s) => { s.available.ood = false; } },
    { id: "task-drift", kw: "被改动", mutate: (s) => { s.hashes.dev[1] = "tampered"; } },
    // 三段不互异，但保持 ood 独立、holdout 段内 before/after 一致 → 只触发「未真正留出」一条。
    { id: "no-separation", kw: "未真正留出", mutate: (s) => { s.hashes.holdout = [s.hashes.dev[0], s.hashes.dev[1]]; } },
    { id: "protocol-violation", kw: "协议违规", mutate: (s) => { s.protocolViolationsAfter = 1; } },
    { id: "integrity-broken", kw: "完整性", mutate: (s) => { s.integrityOk = false; } },
    { id: "ground-truth-used", kw: "真值验证器", mutate: (s) => { s.usedGroundTruthVerifier = true; } },
    { id: "out-of-range", kw: "[0,1]", mutate: (s) => { s.after.dev = 1.9; } },
    // 自报增益：单独叠加在「dev 未提升」上 → 仍拒绝，且 rewardHackingBlocked=true。
    { id: "self-reported-gain", kw: "dev 未严格提升", rewardHack: true, mutate: (s) => { s.after.dev = s.before.dev; s.selfReportedGain = 0.9; } },
  ];

  const legalVerdict = judgePromotion(legal);
  // 自报增益绝不参与判定：合法 spec 塞一个大 selfReportedGain，结论不变。
  const withSelfReport = judgePromotion({ ...clone(), selfReportedGain: 999 });
  const rows: Array<Record<string, unknown>> = [];
  let allRejected = true;
  for (const n of negatives) {
    const spec = clone();
    n.mutate(spec);
    const v = judgePromotion(spec);
    const hit = v.reasons.some((r) => r.includes(n.kw));
    const blockedOodOk = n.blockOod ? v.blockedByOod === true : true;
    const rewardOk = n.rewardHack ? v.rewardHackingBlocked === true : true;
    const ok = !v.promoted && hit && blockedOodOk && rewardOk;
    if (!ok) allRejected = false;
    rows.push({ id: n.id, rejected: !v.promoted, reasons: v.reasons, blockedByOod: v.blockedByOod, rewardHackingBlocked: v.rewardHackingBlocked, ok });
  }

  const pass = legalVerdict.promoted && withSelfReport.promoted && allRejected;
  const out = resolve(root, "data/bench/promotion-contrast.json");
  mkdirSync(dirname(out), { recursive: true });
  const payload = {
    version: 1, mode: "deterministic", providerName: "mock",
    note: [
      "三段晋升判据的确定性回归：合法场景分数由 runEval 真实产出，不是能力分数。",
      "反例在真实 spec 上叠加单个受控违规信号（判据输入契约测试），验证 OOD 退化即阻断、只读隔离、缺格/任务漂移/协议/完整性/自报全部拒绝。",
      "dev 严格提升 / holdout 不退化 / OOD 不退化 三条同时满足才晋升；leadership.verdict 仍为 not-proven。",
    ],
    before, after,
    hashes: legal.hashes,
    legal: legalVerdict,
    selfReportIgnored: withSelfReport.promoted,
    negativesAccepted: rows.filter((r) => r.ok).length, negativesTotal: rows.length,
    cases: rows,
  };
  // 幂等写入：除生成时间外主体相同就不覆盖，避免每次跑门禁制造假 diff。
  const body = JSON.stringify(payload, null, 2) + "\n";
  try { if (readFileSync(out, "utf8") !== body) writeFileSync(out, body); }
  catch { writeFileSync(out, body); }

  process.stdout.write("\n════ promotion:check · 三段晋升判据（离线、可复算） ════\n");
  process.stdout.write(`合法晋升: ${legalVerdict.promoted ? "✓ 接受" : "✗ 拒绝"} ${legalVerdict.promoted ? "" : "→ " + legalVerdict.reasons.join("; ")}\n`);
  process.stdout.write(`自报增益不影响判定: ${withSelfReport.promoted ? "✓" : "✗"}\n`);
  process.stdout.write("反例（应全部拒绝）:\n");
  for (const r of rows) {
    process.stdout.write(`  ${r.ok ? "✓" : "✗"} ${String(r.id).padEnd(22)} ${(r.reasons as string[]).join("; ")}\n`);
  }
  process.stdout.write(`\n反例拒绝 ${rows.filter((r) => r.ok).length}/${rows.length} · 报告 data/bench/promotion-contrast.json\n`);
  process.stdout.write("诚实边界：阶段 C 前置闸门，不是能力分数；leadership.verdict 不变。\n");
  process.stdout.write(`${pass ? "✓" : "✗"} 三段晋升判据：合法接受 ${legalVerdict.promoted ? 1 : 0}/1 · 反例拒绝 ${rows.filter((r) => r.ok).length}/${rows.length}\n\n`);
  return pass ? 0 : 1;
}
