/**
 * P1 · 对比式改进 live 闭环演示（无真值 verifier）
 *
 * 与纯单测不同，这里的行为摘要来自 **真实 deterministic 评测轨迹**（runEval 的
 * EvalRunMetrics），不是手搓的数字。流程：
 *   1) 用带故障注入的真实任务跑出基线轨迹（确有 toolErrors）→ baselineFromRuns
 *      聚合成域级基线；
 *   2) 模拟一批 harness 候选的探测轮轨迹（含「真修复」与「仅抬分数」的伪修复）；
 *   3) LiveContrastVerifier 按行为对比判定晋升，明确拦截 reward hacking；
 *   4) 打印收敛报告与完整性结论，全程 usedGroundTruthVerifier=false。
 *
 * 运行：npm run contrast:live
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval, loadTasks } from "../src/observability/eval.ts";
import type { EvalTask } from "../src/observability/eval.ts";
import { baselineFromRuns, LiveContrastVerifier } from "../src/rsi/contrast.ts";
import type { LiveCandidate } from "../src/rsi/contrast.ts";
import type { RunSummary } from "../src/rsi/contrast.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const line = (s = ""): void => process.stdout.write(s + "\n");
const hr = (t: string): void => line("\n" + "─".repeat(70) + `\n  ${t}\n` + "─".repeat(70));

// 1) 真实评测轨迹：取带故障注入的任务（toolErrors>0，才有「可修复」的失败模式）
const allTasks = loadTasks(resolve(ROOT, "data/eval-tasks.jsonl"));
const tasks: EvalTask[] = allTasks.filter((t) => !!t.fault && Array.isArray(t.script));
const evalReport = await runEval({ tasks, mode: "deterministic", k: 1, root: ROOT, baseline: null });
const baseline = baselineFromRuns(evalReport.runs);

hr("1 / 3  真实轨迹基线（runEval 产出，无真值标签）");
line(`  任务数=${evalReport.runs.length}  聚合 toolCalls=${baseline.toolCalls}  toolErrors=${baseline.toolErrors}`);
line(`  loopAdvisories=${baseline.loopAdvisories}  protocolViolations=${baseline.protocolViolations}  answerMatches=${baseline.answerMatches}`);

// 2) 构造探测轮候选：
//    「真修复」= 探测轮把 toolErrors 真实降下来（可观测行为变化）；
//    「伪修复」= 行为完全没变，只是自报分数涨了。
const realFixSummary: RunSummary = {
  ...baseline,
  toolCalls: Math.max(baseline.toolCalls, evalReport.runs.length),
  toolErrors: Math.max(0, baseline.toolErrors - evalReport.runs.length),
  missingTool: false,
};
const gamingSummary: RunSummary = { ...baseline }; // 行为与基线一致

const candidates: LiveCandidate[] = [
  {
    id: "repair-tool-errors",
    description: "受控修复畸形工具参数，使工具错误下降",
    focus: "tool-error",
    probed: realFixSummary,
    scoreGain: 0, // 不靠分数
  },
  {
    id: "score-only-hack",
    description: "只调评分口径把分数抬高，没有修任何失败模式",
    focus: "tool-error",
    probed: gamingSummary,
    scoreGain: 0.75, // 自报大幅提分
  },
];

// 3) 多轮验证器判定
hr("2 / 3  Propose–Probe–Compose 判定（分数不参与）");
const verifier = new LiveContrastVerifier();
const d1 = verifier.probe(baseline, candidates);
for (const d of d1) {
  const mark = d.accepted ? "✓ 接受" : "✗ 拒绝";
  line(`  ${mark}  ${d.id.padEnd(20)} focus=${d.focus}  scoreGain=${d.scoreGain.toFixed(2)}  ${d.rewardHackingBlocked ? "⛔ reward-hacking" : ""}`);
  line(`       证据: ${d.evidence}`);
}
// 第二轮：换一个失败焦点（死循环告警），再验证一次收敛
const d2 = verifier.probe(
  { ...baseline, loopAdvisories: 3, missingTool: false },
  [
    { id: "loop-fix", description: "死循环软警告使告警下降", focus: "loop", probed: { ...baseline, loopAdvisories: 1, missingTool: false } },
    { id: "loop-gaming", description: "自报提分但告警没降", focus: "loop", probed: { ...baseline, loopAdvisories: 3, missingTool: false }, scoreGain: 0.6 },
  ] as LiveCandidate[],
);
line(`  轮 2: ${d2.map((d) => `${d.id}=${d.accepted ? "✓" : "✗"}`).join("  ")}`);

// 4) 收敛报告
hr("3 / 3  收敛报告");
const rep = verifier.report();
line(`  累积轮数            : ${rep.rounds}`);
line(`  使用真值 verifier   : ${rep.usedGroundTruthVerifier}  ← 刻意不依赖真值`);
line(`  晋升               : [${rep.accepted.join(", ")}]`);
line(`  拒绝               : [${rep.rejected.join(", ")}]`);
line(`  reward hacking 拦截 : ${rep.rewardHackingBlocked}`);
line(`  完整性             : ${rep.integrity.ok ? "✓ OK" : "✗ " + rep.integrity.reasons.join("; ")}`);
line("\n  结论：只有「可观测地修复了具体失败模式」的改动被晋升；自报分数提升但无行为对比");
line("        的伪修复被判定为 reward hacking 拒绝——这正是 HARNESS² 无真值改进的核心不变量。\n");

if (!rep.integrity.ok || rep.accepted.length !== 2) process.exitCode = 1;
