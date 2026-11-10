/**
 * v2.1.0 · 复利中枢离线演示（两大设计目标的可复现证据）
 *
 *  目标 1「越用改进越快」：同一类失败模式反复出现时，经验库裁剪探测集，
 *    收敛所需 attempts 下降；VelocityLedger 用冻结尺子判定是否真的加速。
 *  目标 2「越用越省/越稳」：学习型路由把原本走远程的请求压到本地，
 *    远程失败→本地兜底的经验跨会话累积并反哺成本。
 *
 * 全程离线、无网络、无凭据；只写临时目录，不污染仓库账本。
 * 作为 project:status 第 11 道阻断门禁运行：断言不成立即非零退出。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceBank, failureSignature, requestSignature } from "../src/rsi/experience.ts";
import { VelocityLedger } from "../src/rsi/velocity.ts";
import { compoundProbe } from "../src/rsi/contrast.ts";
import { LearnedRoutePolicy } from "../src/models/route-experience.ts";
import type { LLMRequest } from "../src/models/base.ts";
import type { LiveCandidate, RunSummary } from "../src/rsi/index.ts";

const dir = mkdtempSync(join(tmpdir(), "bro2-compound-demo-"));
const bankPath = join(dir, "experience.jsonl");
const velocityPath = join(dir, "velocity.jsonl");

const line = (s = ""): void => { process.stdout.write(s + "\n"); };
const hr = (s: string): void => line(`\n─── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}`);

const baseline: RunSummary = {
  steps: 10, toolCalls: 3, toolErrors: 4, loopAdvisories: 2,
  groundingRejects: 0, protocolViolations: 0, missingTool: false, answerMatches: false,
};
const cand = (
  id: string, focus: LiveCandidate["focus"], probed: RunSummary, scoreGain?: number,
): LiveCandidate => ({ id, description: id, focus, probed, ...(scoreGain !== undefined ? { scoreGain } : {}) });
const candidates = (): LiveCandidate[] => [
  cand("fake-gain", "tool-error", baseline, 0.6),
  cand("no-op", "loop", baseline),
  cand("fix-real", "tool-error", { ...baseline, toolErrors: 0, loopAdvisories: 0, toolCalls: 4, steps: 8 }),
];

const tools = [{ name: "echo", description: "echo", parameters: { type: "object" } }] as unknown as LLMRequest["tools"];
const mkReq = (lastRole: "user" | "tool"): LLMRequest => ({
  messages: [
    { role: "user", content: "短问题" },
    { role: "assistant", content: "短回复" },
    { role: lastRole, content: "短内容" },
  ],
  tools,
});

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean): void => { checks.push([label, ok]); };

// ─────────────────────────────── 目标 1：复利
hr("目标 1｜harness 持续自我改进，越使用改进速度越快");
line("  场景：同一类失败模式（工具错误 + 循环告警）反复出现 8 次。");
line("  经验库按失败模式指纹沉淀「哪类编辑真的修好了」；Propose 阶段只探测命中的候选 + 1 个探索位。\n");
line("  轮次   探测数   跳过   首轮命中   接受   经验命中   回退");

const sig = failureSignature(baseline);
const results = [];
for (let i = 1; i <= 8; i += 1) {
  const r = compoundProbe(
    baseline, candidates(),
    new ExperienceBank(bankPath),       // 每轮新建实例 → 模拟跨会话复用
    new VelocityLedger(velocityPath),
    { signature: sig },
  );
  results.push(r);
  line(`   ${String(i).padStart(2)}      ${String(r.attempts).padStart(3)}      ${String(r.probesAvoided).padStart(2)}`
    + `       ${r.firstTryHit ? "是" : "否"}        ${r.improvement}        ${r.experienceHits}         ${r.usedFallback ? "是" : "否"}`);
}

const firstAttempts = results[0].attempts;
const laterAttempts = Math.max(...results.slice(1).map((r) => r.attempts));
check("有经验后探测数下降", laterAttempts < firstAttempts);
check("每轮都找到真修复（裁剪不牺牲正确性）", results.every((r) => r.improvement === 1));
check("伪修复全程未被晋升", results.every((r) =>
  r.decisions.find((d) => d.id === "fake-gain")?.accepted === false || !r.decisions.some((d) => d.id === "fake-gain")));

const velocity = new VelocityLedger(velocityPath).snapshot();
line(`\n  冻结速度尺子：样本 ${velocity.usableSamples}  trend=${velocity.trend}`);
line(`    firstTryHitRate=${velocity.firstTryHitRate.toFixed(2)}  avgAttempts=${velocity.avgAttempts.toFixed(2)}`);
line(`    improvementPerAttempt=${velocity.improvementPerAttempt.toFixed(3)}`
  + `  (前半 ${velocity.firstHalfIPA.toFixed(3)} → 后半 ${velocity.secondHalfIPA.toFixed(3)})`);
line(`    诚实性 selfReported=${velocity.honesty.selfReported}  frozenMetric=${velocity.honesty.frozenMetric}`);
line(`    ${velocity.honesty.reason}`);
check("速度尺子判定为加速（冻结、非自报）", velocity.trend === "accelerating");
check("速度尺子声明非自报", velocity.honesty.selfReported === false);

// OOD 失效：经验不再被复用，探测集恢复全量
const bank = new ExperienceBank(bankPath);
bank.invalidate("harness-edit", sig, "fix-real", "OOD 任务集上出现回归");
const after = compoundProbe(baseline, candidates(), new ExperienceBank(bankPath), new VelocityLedger(join(dir, "v2.jsonl")), { signature: sig });
check("OOD 失效后不再裁剪（防过拟合）", after.autoPruned === false && after.attempts === 3);
line(`\n  OOD 失效演练：失效后 autoPruned=${after.autoPruned}、attempts=${after.attempts}（恢复全量探测）`);

// ─────────────────────────────── 目标 2：容错与成本
hr("目标 2｜本地小模型 + 免 Key 大模型，越用越省、越用越稳");
const routePath = join(dir, "route.jsonl");
const policy = new LearnedRoutePolicy(new ExperienceBank(routePath));

// 冷启动：3 个「工具结果整理」回合，启发式本就走本地，实证成功 → 沉淀经验
for (let i = 0; i < 3; i += 1) {
  const d = policy.decide(mkReq("tool"), { turn: i });
  policy.observe(mkReq("tool"), d, true);
}
// 5 个原本启发式要走远程的请求（末条是 user），经验命中后被压到本地
let remoteCalls = 0;
for (let i = 0; i < 5; i += 1) {
  const d = policy.decide(mkReq("user"), { turn: i + 3 });
  if (d === "remote") remoteCalls += 1;
  policy.observe(mkReq("user"), d, true);
}
// 一次远程失败 → 本地兜底成功：容错经验反哺成本
policy.observe(mkReq("user"), "remote", true, true);
policy.endpointOutcome("kilo", true, 300);
policy.endpointOutcome("kilo", false, 9000);
policy.endpointOutcome("pollinations", true, 1200);

const st = policy.stats();
line(`  请求结构指纹：${requestSignature(mkReq("user"))}（刻意不含末条角色，使经验能覆盖启发式）`);
line(`  启发式基线：这 8 个请求中 5 个会走远程；学习型路由实际远程调用 = ${remoteCalls}`);
line(`  localFromExperience=${st.localFromExperience}  localFromHeuristic=${st.localFromHeuristic}`
  + `  fallbacks=${st.fallbacks}  remoteAvoided=${st.remoteAvoided}`);
check("远程调用被经验显著削减", st.localFromExperience >= 5 && remoteCalls === 0);
check("远程失败→本地兜底被记为容错经验", st.fallbacks === 1);

// 跨会话：新建实例读同一账本，端点质量与路由经验都还在
const session2 = new LearnedRoutePolicy(new ExperienceBank(routePath));
const kilo = session2.endpointQuality("kilo");
const reused = session2.decide(mkReq("user"), { turn: 0 });
line(`\n  跨会话复用：新实例仍直接选择 ${reused}；kilo 历史 ${kilo.successes} 成功 / ${kilo.failures} 失败（rate=${kilo.rate.toFixed(2)}）`);
check("端点质量经验跨会话保留", kilo.samples === 2 && kilo.rate === 0.5);
check("路由经验跨会话复用", reused === "local");

const expStats = new ExperienceBank(routePath).stats();
line(`  经验账本：${expStats.events} 条事件 / ${expStats.entries} 条折叠快照 / 可复用 ${expStats.reusable} 条`);

// ─────────────────────────────── 结论
hr("结论与诚实边界");
line("  ✓ 目标 1：经验只裁剪探测集、不改判定；收敛成本随使用下降，由冻结尺子判定，样本不足不宣称加速。");
line("  ✓ 目标 2：路由与端点经验跨会话累积，容错经验直接转化为远程调用削减。");
line("  · 边界：复利在「同一失败模式类内」成立；跨失败模式的泛化属于 P3 OOD 通道 / P4 HarnessRouter，尚未实现。");
line("  · 边界：本演示是离线确定性轨迹，不是真实模型能力分数；leadership.verdict 仍为 not-proven、L4 仍 not-achieved。");
line("  · 治理：自报分数始终不参与判定；经验可 OOD 失效；协议违规轮不计入速度趋势。\n");

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  line(`  ✗ 门禁失败：${failed.map(([l]) => l).join(" / ")}`);
  process.exitCode = 1;
} else {
  line(`  ✓ 复利中枢门禁：${checks.length}/${checks.length} 项断言通过`);
}

rmSync(dir, { recursive: true, force: true });
