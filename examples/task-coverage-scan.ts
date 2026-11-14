/**
 * bro2 · 任务集全量覆盖扫描（v2.34.0）
 * ----------------------------------------------------------
 * 承接 ROADMAP「下一步 5：让同模型对照成为可归因 Δ」的两条候选路径：
 *   ① 补官方 harness 同子集成绩 → 已由 official-harness-audit.json 判定公开不可得；
 *   ② 扩任务集到全量       → 本脚本量化「全量」的分母、契约差异与可复现上限。
 *
 * 设计原则（与仓库一贯口径一致）：
 *   - 全量分母来自**固化的权威 git tree 快照** tb-tree-snapshot.json（离线、可复核、不联网）；
 *   - 任务是否可纳入，只认**双向 sanity**（空工作区必 fail / 官方 oracle 解必 pass），
 *     复用 external-measure.ts 的 prepare / runVerifier / applyOracle 正式口径，不另立判据；
 *   - 不搬运上游任务原文（upstream/ 已 gitignore），只分发坐标与 SHA256SUMS；
 *   - 不写 external-results.json、不改 L4 / leadership.verdict、不产出能力分数。
 *
 * 输出：data/bench/external/task-coverage-report.json
 * 运行：node --experimental-strip-types --no-warnings examples/task-coverage-scan.ts
 *      （sanity 需要 bro2/tb-verifier:1 镜像与上游文件；SKIP_SANITY=1 可只跑离线分类）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTasks, checkInputs, sanity } from "./external-measure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "data", "bench", "external");
const SNAP = join(EXT, "tb-tree-snapshot.json");
const AUDIT = join(EXT, "official-harness-audit.json");
const OUT = join(EXT, "task-coverage-report.json");
const SKIP = process.env.SKIP_SANITY === "1";

interface TreeSnapshot {
  sources: Array<{ repo: string; commit: string; datasetPath: string; tag: string; complete: boolean; totalPaths: number; prefix: string }>;
  originalPaths: string[];
  pinned21Paths: string[];
}

/** 从 "prefix/<task>/<rest>" 提取任务目录名与文件布局。 */
function parse(paths: string[], prefix: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const parts = p.slice(prefix.length).split("/");
    if (parts.length < 2 || !parts[0]) continue;
    if (!m.has(parts[0]!)) m.set(parts[0]!, new Set());
    m.get(parts[0]!)!.add(parts.slice(1).join("/"));
  }
  return m;
}

const snap = JSON.parse(readFileSync(SNAP, "utf8")) as TreeSnapshot;
const old = parse(snap.originalPaths, "original-tasks/");
const neu = parse(snap.pinned21Paths, "tasks/");
const oldNames = new Set(old.keys());
const newNames = new Set(neu.keys());
const inter = [...oldNames].filter((t) => newNames.has(t)).sort();
const newOnly = [...newNames].filter((t) => !oldNames.has(t)).sort();

const has = (m: Map<string, Set<string>>, f: string): number =>
  [...m.values()].filter((s) => s.has(f)).length;

const OLD_CONTRACT = ["task.yaml", "solution.sh", "tests/test_outputs.py", "Dockerfile", "run-tests.sh"];
const NEW_CONTRACT = ["task.toml", "instruction.md", "solution/solve.sh", "tests/test.sh", "tests/test_outputs.py", "environment/Dockerfile"];

const oldContract: Record<string, number> = {};
for (const f of OLD_CONTRACT) oldContract[f] = has(old, f);
const newContract: Record<string, number> = {};
for (const f of NEW_CONTRACT) newContract[f] = has(neu, f);

// 交集 88 题中同时含两代布局文件的计数（证明同名 != 同题定义）
const bothLayouts = inter.filter((t) => old.get(t)!.has("task.yaml") && neu.get(t)!.has("task.toml")).length;

// ---- 冻结清单与扩集 ----
const tasks = loadTasks();
checkInputs(tasks);
const inBoard = (dir: string): boolean => newNames.has(dir);
const frozen4 = ["analyze-access-logs", "bank-trans-filter", "assign-seats", "constraints-scheduling"];
const newlyAdded = tasks.map((t) => t.dir).filter((d) => !frozen4.includes(d));

// ---- 双向 sanity（正式口径）----
let sanityRows: Array<Record<string, unknown>> = [];
let sanityStatus = "executed";
if (SKIP) {
  sanityStatus = "skipped-by-env (SKIP_SANITY=1)";
} else {
  for (const t of tasks) {
    const r = sanity(t);
    sanityRows.push({
      taskId: t.id, dir: t.dir, emptyWorkspace: r.emptyWorkspace,
      oracleSolution: r.oracleSolution, oracleExitOk: r.oracleExitOk, sound: r.sound,
    });
    console.log(`  sanity ${t.dir.padEnd(28)} → sound=${r.sound}`);
  }
}
const nSound = sanityRows.filter((r) => r.sound === true).length;

const report = {
  kind: "task-set-full-coverage-scan",
  generatedAt: new Date().toISOString(),
  question: "把任务集扩到『全量』能走多远？两条路径的结论是什么？",
  pathA_officialSubset: {
    verdict: (JSON.parse(readFileSync(AUDIT, "utf8")) as { verdict: string }).verdict,
    source: "official-harness-audit.json",
    note: "官方 harness 同子集成绩公开不可得：公开榜只发聚合分，官方提交无 gpt-oss-120b 逐题判分；4 题中 3 题不在 89 题集内；两代契约不同。自行用官方 Harbor 重跑仍是另一条后续路径。详见 E1–E5。", 
  },
  pathB_fullTaskSet: {
    verdict: "bounded-by-contract",
    note: "『全量』有两个不同分母，且 bro2 统一离线 verifier（python:3.11-slim + pytest，仅 stdlib）与 2.1 的 Harbor 契约（每题独立镜像，部分任务需 apt/pip/gcc 或联网依赖）不同。可复现上限由双向 sanity 决定，不是任务数量。",
    denominators: {
      originalTasks: { repo: snap.sources.find((s) => s.tag === "original")?.repo, commit: snap.sources.find((s) => s.tag === "original")?.commit, nTasks: oldNames.size },
      pinned21: { repo: snap.sources.find((s) => s.tag === "pinned21")?.repo, commit: snap.sources.find((s) => s.tag === "pinned21")?.commit, nTasks: newNames.size },
      intersection: inter.length,
      pinned21Only: newOnly.length,
    },
    contract: {
      originalTasks: { layout: OLD_CONTRACT, counts: oldContract, nTasks: oldNames.size },
      pinned21: { layout: NEW_CONTRACT, counts: newContract, nTasks: newNames.size },
      bothLayoutsInIntersection: bothLayouts,
      note: "88 个同名目录全部是两代布局并存；同名不等于同一题定义或同一评分器。",
    },
    structuralEligibility: {
      verifierPlusOracle: has(old, "tests/test_outputs.py") + 0, // 见下方 computed
      note: "见 classification 字段（按 git tree 逐题计算）。",
    },
    classification: (() => {
      let verifierOnly = 0, oracleOnly = 0, both = 0, withStaticInput = 0;
      const DATA_EXT = /\.(csv|txt|json|ics|pkl|b64|log|dat|xml|tsv|yaml|yml|md)$/i;
      for (const [t, files] of old) {
        const v = files.has("tests/test_outputs.py");
        const o = files.has("solution.sh");
        if (v && o) both += 1;
        else if (v) verifierOnly += 1;
        else if (o) oracleOnly += 1;
        if ([...files].some((f) => DATA_EXT.test(f) && !f.startsWith("tests/"))) withStaticInput += 1;
      }
      return { hasVerifier: has(old, "tests/test_outputs.py"), hasOracle: has(old, "solution.sh"), bothVerifierAndOracle: both, verifierOnly, oracleOnly, withStaticInputFile: withStaticInput, note: "git tree 级结构分类（不涉及评分器内容）。" };
    })(),
    empiricalScan: {
      source: "v2.34.0 本地实测（按固定 commit 拉取上游全文）",
      localSampleSize: 79,
      localSampleNote: "GitHub codeload 整包在本环境被 gzip 尾截断，仅可解压 79/241 题（按字母序前缀 a–f）。这是实测样本限制，非全量结论；全量分母由 git tree 快照覆盖。",
      contentScreened: 21,
      contentScreenNote: "内容级粗筛：verifier 仅 stdlib + pytest、官方解无 apt/pip/gcc/编译/联网命令。",
      sanitySound: nSound,
      falseSoundRejected: ["extract-moves-from-video"],
      falseSoundReason: "verifier 内嵌完整 SOLUTION 答案常量，solution.sh 逐行 echo 同一份答案，oracle 与判分器自我印证、不具判别力；且题面要求联网下载 YouTube 视频，离线不可复现。粗筛的双向 sanity 会假 PASS，故按『防空转仪表盘』剔除。",
      excludedReasons: { "oracle 需 apt/pip/gcc/编译/联网命令": 27, "verifier 依赖第三方库": 24, "缺 verifier 或 oracle": 7 },
    },
    expansion: {
      before: 4,
      after: tasks.length,
      newlyAdded,
      newlyAddedInPinned21: newlyAdded.filter(inBoard),
      allTasksInPinned21: tasks.filter((t) => inBoard(t.dir)).map((t) => t.dir),
      note: `扩集 ${frozen4.length}→${tasks.length} 题，${nSound}/${tasks.length} 双向 sanity 为 SOUND。新增 ${newlyAdded.length} 题均不在 2.1 的 ${newNames.size} 题集内，当前任务池仅 ${tasks.filter((t) => inBoard(t.dir)).length} 题落在榜单口径——扩集提升样本量，却未缩小与榜单任务集的差异。`,
    },
  },
  sanity: {
    status: sanityStatus,
    image: "bro2/tb-verifier:1",
    criterion: "emptyWorkspace=fail 且 oracleSolution=pass 且 oracleExitOk=true → sound",
    nTasks: tasks.length,
    nSound,
    rows: sanityRows,
  },
  strictDeltaCarrier: {
    note: "严格 harness-Δ 不需要官方成绩、也不要求全量任务集；它只需要『同任务/同模型/同输入/同评分器/同预算，只变 harness』的受控对照。仓库已有 external-measure.ts 的 bro2 vs minimal 正是该载体（v2.28.0 Δ=+4，6/9 vs 2/9）。本轮把可对照任务池从 4 扩到 6，并把该对照标注为 Δ 的正确来源。",
    honest: "该对照仍是自跑内部对照、minimal 是自实现基线（≠官方 mini-swe-agent / Terminus-2）、非第三方复核；不构成榜单分数，不证明 harness 通用增益。本轮未在新增 2 题上重跑 bro2/minimal，未产生新通过率或新 harness-Δ。", 
  },
  honesty: [
    "自跑、非第三方复核；全量分母来自固化 git tree 快照，实测样本受整包下载截断限制为 79 题",
    "扩集只增加可复现任务，不提升能力水位；不写 external-results.json、不改 L4 / leadership.verdict",
    "同模型对照仍为 non-strict-positioning-reference，名义差不可归因于 harness",
    "假 SOUND 反例被剔除，避免把『oracle 抄答案』当成可复现任务",
  ],
};

// 修正结构分类里被占位的字段
report.pathB_fullTaskSet.structuralEligibility.verifierPlusOracle =
  (report.pathB_fullTaskSet.classification as { bothVerifierAndOracle: number }).bothVerifierAndOracle;

writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(`\n任务集全量覆盖扫描报告已生成：${OUT}`);
console.log(`  分母 original=${oldNames.size} / 2.1=${newNames.size} / 交集=${inter.length}`);
console.log(`  路径 A：${report.pathA_officialSubset.verdict}（公开不可得，未自行运行官方 Harbor）`);
console.log(`  路径 B：${report.pathB_fullTaskSet.verdict}，扩集 ${report.pathB_fullTaskSet.expansion.before}→${report.pathB_fullTaskSet.expansion.after} 题`);
console.log(`  sanity ${sanityStatus}: ${nSound}/${tasks.length} SOUND（6 题中仅 ${report.pathB_fullTaskSet.expansion.allTasksInPinned21.length} 题落在 2.1 榜集内）`);
