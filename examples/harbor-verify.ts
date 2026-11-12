/**
 * bro2 · Harbor 装载零 Key 接线验证（v2.29.0 / P0-01）
 *
 * 不产生能力分数、不需要 API Key、不需要真实模型。验证的是 bro2 作为 Harbor 自定义 agent
 * 的**接线契约**：同一任务子集 / 同一预算 / 同一评分器 三方对齐可复核。
 *
 * 复用 external-measure.ts 的真相源函数（单一事实来源，避免漂移）：
 *   - loadTasks / checkInputs / sanity / prepare / runVerifier / instructionOf /
 *     fingerprint / MAX_MODEL_CALLS / ENV_NOTE
 *
 * 诚实边界（写进报告产物）：确定性 mock 验证只证接线、不反映 harness 价值；
 * 不写 data/benchmark/external-results.json；不改 L4 / leadership.verdict。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/harbor-verify.ts
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadTasks, checkInputs, sanity, prepare, runVerifier, instructionOf,
  fingerprint, MAX_MODEL_CALLS, ENV_NOTE,
} from "./external-measure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "data", "bench", "external");
const EXTERNAL_RESULTS = join(ROOT, "data", "benchmark", "external-results.json");
const POSITION = join(ROOT, "docs", "CAPABILITY-POSITION.md");
const HARBOR_CFG = join(ROOT, "examples", "harbor", "config.yaml");
const OUT = join(EXT, "harbor-verify-report.json");

function readYamlMaxSteps(p: string): number | null {
  const s = readFileSync(p, "utf8");
  const m = s.match(/max_steps:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  const started = Date.now();
  const tasks = loadTasks();
  checkInputs(tasks);
  const extBefore = fingerprint(EXTERNAL_RESULTS);
  const posBefore = existsSync(POSITION) ? readFileSync(POSITION, "utf8") : "";

  console.log("=".repeat(84));
  console.log("  bro2 · Harbor 装载零 Key 接线验证（P0-01）");
  console.log("=".repeat(84));
  console.log(`  任务子集: ${tasks.length} 题 · 预算 MAX_MODEL_CALLS=${MAX_MODEL_CALLS} · 评分器: 上游公开 pytest(Docker)`);
  console.log("");

  // 【1】三方对齐——评分器健全性（空工作区必 fail / 官方解必 pass / SHA 匹配），模型无关。
  console.log("  【1/5】三方对齐：评分器健全性（sanity，复用 external-measure 真相源）");
  const sanityResults = tasks.map((t) => {
    const r = sanity(t);
    console.log(`    ${r.sound ? "✓" : "✗"} ${String(r.taskId).padEnd(24)} empty=${r.emptyWorkspace} oracle=${r.oracleSolution}`);
    return r;
  });
  const allSound = sanityResults.every((r) => r.sound);

  // 【2】模拟 Harbor run() 的数据流：prepare 工作区 + 调用同一评分器（不跑模型）。
  console.log("");
  console.log("  【2/5】模拟 Harbor run() 数据流：同一 prepare + 同一 verifier 被调用");
  const flowChecks: Array<Record<string, unknown>> = [];
  for (const t of tasks) {
    const tmp = mkdtempSync(join(tmpdir(), "bro2-harbor-flow-"));
    try {
      const ws = join(tmp, "ws");
      prepare(t, ws); // 与 live 路径完全一致的公开输入铺盘
      // 评分器对「已铺公开输入但未跑模型」的工作区判分：证明同一 verifier 被接线，
      // 且 agent 不可见的评分器只按产出文件判定（harness adapter 不进 prompt）。
      const v = runVerifier(t, ws);
      flowChecks.push({ taskId: t.id, workspacePrepared: existsSync(ws), verifierInvoked: true, verifierPassedNoModel: v.passed });
      console.log(`    ✓ ${String(t.id).padEnd(24)} workspace=${flowChecks.at(-1)!.workspacePrepared} verifierInvoked=${v.passed ? "pass(no model)" : "fail(no model)"}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 【3】同一 instruction 适配路径：Harbor run(instruction) 传入的正是 instructionOf(t)，
  //     含显式标注的 [harness adapter] 路径说明，且与 external:measure 完全一致。
  const instrOk = tasks.every((t) => instructionOf(t).includes(ENV_NOTE.trim()) && instructionOf(t).includes("/app"));
  console.log("");
  console.log(`  【3/5】instruction 适配路径一致（含 [harness adapter] 标注）: ${instrOk ? "✓" : "✗"}`);

  // 【4】预算对齐：Harbor config.yaml 的 max_steps == external:measure 的 MAX_MODEL_CALLS。
  const cfgSteps = existsSync(HARBOR_CFG) ? readYamlMaxSteps(HARBOR_CFG) : null;
  const budgetAligned = cfgSteps !== null && cfgSteps === MAX_MODEL_CALLS;
  console.log(`  【4/5】预算对齐 config.yaml max_steps(${cfgSteps}) == MAX_MODEL_CALLS(${MAX_MODEL_CALLS}): ${budgetAligned ? "✓" : "✗"}`);

  // 【5】诚实护栏：不写 external-results.json，不改 L4 / verdict。
  const extAfter = fingerprint(EXTERNAL_RESULTS);
  const posAfter = existsSync(POSITION) ? readFileSync(POSITION, "utf8") : "";
  const noExternalWrite = extBefore === extAfter;
  const verdictUnchanged = posBefore === posAfter &&
    /not-achieved/.test(posAfter) && /not-proven/.test(posAfter);
  console.log(`  【5/5】护栏: 不改 external-results.json=${noExternalWrite} · L4/verdict 不变=${verdictUnchanged}`);

  const ok = allSound && instrOk && budgetAligned && noExternalWrite && verdictUnchanged;

  const report = {
    kind: "harbor-load-verify",
    version: 1,
    timestamp: new Date().toISOString(),
    note: "零 Key 接线验证：只证 bro2 可被 Harbor 装载且任务/预算/评分器三方对齐，不产能力分数。",
    agent: { contract: "harbor.agents.installed.base.BaseInstalledAgent", entry: "examples.harbor.bro2_agent:Bro2Agent" },
    taskSubset: tasks.map((t) => t.id),
    budget: { maxModelCalls: MAX_MODEL_CALLS, harborConfigMaxSteps: cfgSteps, aligned: budgetAligned },
    verifierSanity: sanityResults,
    flow: flowChecks,
    honest: {
      isLeaderboardScore: false,
      thirdPartyVerified: false,
      isModelCapabilityScore: false,
      writtenToExternalResults: !noExternalWrite,
      leadershipVerdictChanged: !verdictUnchanged,
      l4Changed: !verdictUnchanged,
      limitations: [
        "零 Key 接线验证，不产生能力分数，不反映 harness 价值",
        "真实能力对照需 Harbor 运行时 + 可工具调用模型端点（本沙箱默认不具）",
        "确定性 mock 验证量的是接线正确性，模型智能不参与评分",
        "与 mini-swe-agent/Terminus-2 的第三方可复核对照见 data/bench/external/agent-comparison.json",
      ],
    },
    passed: ok,
    durationMs: Date.now() - started,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  if (!ok) {
    console.log("\n  ✗ 接线验证未通过，拒绝出结论（防空转仪表盘）");
    process.exitCode = 1;
  } else {
    console.log(`\n  ✓ 接线验证通过（${report.durationMs}ms）。产物: ${OUT}`);
    console.log("  注意：这是协议接入验证，不是能力对照；live 对照由第三方按 Harbor 协议复跑。");
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) await main();
