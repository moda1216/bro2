/**
 * bro2 · P2 轨迹飞轮系统化（trajectory flywheel）
 * ----------------------------------------------------------------
 * 把 REWRITE-ARCHITECTURE §3#3 / §4 P2 的出口条件「轨迹可追溯 delta，失败留痕」
 * 从口号变成可复跑、可证伪的证据。全部读取真实账本并调用真实模块，不 mock 不臆造：
 *
 *  1) 质量判据：对 data/rsi/experience.jsonl 的每条经验按「可复现 / 正向 delta /
 *     非幸运路径」三维分级（gold/silver/bronze/rejected），每条带来源与 delta 代理。
 *  2) 只增与失败留痕：验证 seq 从 0 连续无缺口、失败 outcome 全部可被检索到
 *     （失败同样入库，不是只留成功）。
 *  3) 脱敏：用真实 audit.redact 处理临时轨迹中的密钥，断言明文不可见。
 *  4) 回填 P1 发现的 provider=mock 判据：固化「机器字段优先」的污染判定，
 *     6 类响应逐一验证，供 batch 判定入口引用（本版不改冻结脚本）。
 *  5) 可证伪对照：synthetic「单次成功」不得判 gold；分级不得全是 gold；
 *     含密钥文本脱敏后不得残留——任一不满足即判 FAIL（防恒真假阳性）。
 *
 * 诚实边界：分级是「经验质量」的启发式审查，不是能力分数；正向 delta 用全局
 * IPA 账本做代理（velocity 记录不含 signature），已在证据中标注。verdict=not-proven
 * / L4=not-achieved 不变。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/trajectory-flywheel.ts
 * 输出：data/evidence/trajectory-flywheel.json
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExperienceBank } from "../src/rsi/experience.ts";
import { Trajectory, truncate } from "../src/kernel/trajectory.ts";
import { redact } from "../src/governance/audit.ts";
import { behavioralContrast } from "../src/rsi/contrast.ts";
import type { RunSummary } from "../src/rsi/contrast.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/evidence/trajectory-flywheel.json");
const EXP = resolve(ROOT, "data/rsi/experience.jsonl");
const VEL = resolve(ROOT, "data/rsi/velocity.jsonl");
const MIN_FOR_GOLD = 2; // 至少成功两次，排除「单次幸运」

interface Check { name: string; pass: boolean; evidence: Record<string, unknown> }
const checks: Check[] = [];
const check = (name: string, pass: boolean, evidence: Record<string, unknown>): void => {
  checks.push({ name, pass, evidence });
};

// ---- 1) 读真实账本 ----
const bank = new ExperienceBank(EXP);
const entries = bank.fold();
const rawEvents = bank.events();
const velRecords = readFileSync(VEL, "utf8").split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { attempts: number; improvement: number; protocolViolations: number });
const sumAttempts = velRecords.reduce((s, r) => s + r.attempts, 0);
const sumImprove = velRecords.reduce((s, r) => s + r.improvement, 0);
const ipa = sumAttempts > 0 ? sumImprove / sumAttempts : 0;

// ---- 2) 只增与失败留痕 ----
const seqs = rawEvents.map((e) => e.seq).sort((a, b) => a - b);
const contiguous = seqs.length > 0 && seqs.every((s, i) => s === i);
check("只增账本 seq 连续无缺口", contiguous, { events: seqs.length, first: seqs[0], last: seqs[seqs.length - 1] });

const failures = rawEvents.filter((e) => e.kind === "outcome" && e.outcome === "failure");
const failuresTraceable = failures.every((e) => e.seq >= 0 && e.signature && e.prescription && e.ts);
check("失败轨迹全部留痕可追溯", failures.length > 0 && failuresTraceable, {
  failureEvents: failures.length,
  traceable: failuresTraceable,
  sample: failures.slice(0, 2).map((e) => ({ seq: e.seq, prescription: e.prescription, source: e.source })),
});

// ---- 3) 质量分级：可复现 / 正向 delta / 非幸运路径 ----
type Grade = "gold" | "silver" | "bronze" | "rejected";
interface Graded {
  id: string;
  domain: string;
  signature: string;
  prescription: string;
  successes: number;
  failures: number;
  invalidations: number;
  reproducible: boolean;
  positiveDelta: boolean;
  nonLucky: boolean;
  grade: Grade;
  source: string;
}
function grade(e: {
  id: string; domain: string; signature: string; prescription: string;
  successes: number; failures: number; invalidations: number; source: string;
}, globalIpa: number): Graded {
  const reproducible = e.successes > e.failures && e.invalidations === 0;
  const positiveDelta = globalIpa > 0; // 代理：velocity 账本全局 IPA（无 signature 维度）
  const nonLucky = e.successes >= MIN_FOR_GOLD && e.successes > e.failures;
  // 注（可证伪对照发现）：positiveDelta 是全局 IPA 代理，不能单独把「单次成功」抬到
  // silver——否则分级退化成「只要有正向水位就放行」。故 gold/silver 都要求 nonLucky。
  let grade: Grade;
  if (reproducible && nonLucky && positiveDelta) grade = "gold";
  else if (reproducible && nonLucky) grade = "silver";
  else if (e.successes >= 1 && e.successes > e.failures) grade = "bronze";
  else grade = "rejected";
  return { ...e, reproducible, positiveDelta, nonLucky, grade };
}
const graded: Graded[] = entries.map((e) => grade(e, ipa));
const gradeCount = graded.reduce<Record<string, number>>((m, g) => {
  m[g.grade] = (m[g.grade] ?? 0) + 1; return m;
}, {});

// 可证伪对照 A：单次成功的合成条目不得判 gold（否则分级是「一律放行」的哑弹）
const syntheticOnce = grade({
  id: "synthetic|once", domain: "harness-edit", signature: "F:synthetic|none|tooled",
  prescription: "lucky-once", successes: 1, failures: 0, invalidations: 0, source: "falsify",
}, ipa);
check("可证伪：单次成功不得判 gold", syntheticOnce.grade !== "gold" && syntheticOnce.grade === "bronze", {
  grade: syntheticOnce.grade, nonLucky: syntheticOnce.nonLucky,
});
// 可证伪对照 B：被失效的经验不得判 gold
const syntheticInvalid = grade({
  id: "synthetic|invalid", domain: "harness-edit", signature: "F:synthetic|high|tooled",
  prescription: "ood-expired", successes: 5, failures: 0, invalidations: 1, source: "falsify",
}, ipa);
check("可证伪：已失效经验不得判 gold", syntheticInvalid.grade !== "gold", {
  grade: syntheticInvalid.grade, invalidations: syntheticInvalid.invalidations,
});
// 可证伪对照 C：分级必须有区分度（不得全是 gold）
const allGold = graded.length > 0 && graded.every((g) => g.grade === "gold");
check("可证伪：分级有区分度（非全 gold）", !allGold, { gradeCount, total: graded.length });

// ---- 4) 脱敏：真实 redact ----
const tmp = mkdtempSync(join(tmpdir(), "bro2-flywheel-"));
let redactOk = false;
let redactEvidence: Record<string, unknown> = {};
try {
  const traj = new Trajectory(join(tmp, "traj.jsonl"));
  const secret = "sk-abcdefghijklmnop1234";
  traj.append({
    sessionId: "s-flywheel", turn: 1, step: 1, type: "message.user" as never,
    payload: { text: `use key ${secret} to run` },
  });
  traj.append({
    sessionId: "s-flywheel", turn: 1, step: 2, type: "tool.result" as never,
    payload: { ok: true, output: `token=Bearer abcdefgh12345678 done` },
  });
  traj.close();
  const rawText = readFileSync(join(tmp, "traj.jsonl"), "utf8");
  const cleaned = redact(rawText);
  redactOk = !cleaned.includes(secret) && !cleaned.includes("abcdefgh12345678") && cleaned.includes("REDACTED");
  const truncated = truncate("x".repeat(100), 20);
  redactEvidence = {
    secretGone: !cleaned.includes(secret),
    bearerGone: !cleaned.includes("abcdefgh12345678"),
    hasRedactedMarker: cleaned.includes("REDACTED"),
    truncateWorks: truncated.truncated && truncated.text.endsWith("字符]"),
  };
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
check("轨迹脱敏：密钥明文不可见", redactOk, redactEvidence);

// ---- 5) 回填 provider=mock 判据（P1 发现）——机器字段优先 ----
function pollutionGate(text: string): { blocked: boolean; kind: string } {
  if (/\bprovider=[^\s]*mock\b/i.test(text) || text.includes("离线 Mock 模型驱动")) {
    return { blocked: true, kind: "mock-fallback" };
  }
  if (text.includes("provider_error") || text.includes("全部模型均不可用")) {
    return { blocked: true, kind: "provider-error" };
  }
  return { blocked: false, kind: "clean" };
}
const gateCases = [
  { name: "机器字段 provider=ollama/...mock", text: "provider=ollama/mock content=ok", expect: true },
  { name: "机器字段 provider=ovhcloud（真上游）", text: "provider=ovhcloud content=ok", expect: false },
  { name: "终答中文 mock 标记", text: "本次由离线 Mock 模型驱动", expect: true },
  { name: "provider_error", text: "stoppedBy=provider_error", expect: true },
  { name: "全部模型均不可用", text: "Error: 全部模型均不可用", expect: true },
  { name: "干净成功", text: "provider=local/llama content=任务完成", expect: false },
].map((c) => ({ ...c, actual: pollutionGate(c.text).blocked, kind: pollutionGate(c.text).kind }));
const gateOk = gateCases.every((c) => c.actual === c.expect);
check("回填判据：provider=mock 6 类分类自洽", gateOk, { cases: gateCases });

// ---- 6) 行为对比原语仍可用（分级不替代接受判定，防 reward hacking 复用）----
const baseline: RunSummary = {
  steps: 5, toolCalls: 0, toolErrors: 2, loopAdvisories: 0, groundingRejects: 0,
  protocolViolations: 0, missingTool: true, answerMatches: false,
};
const probe: RunSummary = { ...baseline, toolCalls: 2, toolErrors: 0, missingTool: false };
const contrast = behavioralContrast(baseline, probe, "tool-error");
check("接受判定仍走行为对比（经验不越权）", contrast.contrast === true, { evidence: contrast.evidence });

const pass = checks.every((c) => c.pass);
const report = {
  generatedAt: new Date().toISOString(),
  version: "2.36.0",
  purpose: "P2 轨迹飞轮系统化：质量判据+脱敏+分级+失败留痕+判据回填（可证伪）",
  inputs: { experience: "data/rsi/experience.jsonl", velocity: "data/rsi/velocity.jsonl" },
  stats: {
    events: rawEvents.length, entries: entries.length, failures: failures.length,
    velocityRounds: velRecords.length, globalIPA: Number(ipa.toFixed(4)), gradeCount,
  },
  graded: graded.map((g) => ({
    id: g.id, grade: g.grade, successes: g.successes, failures: g.failures,
    reproducible: g.reproducible, positiveDelta: g.positiveDelta, nonLucky: g.nonLucky,
  })),
  checks,
  summary: {
    total: checks.length, passed: checks.filter((c) => c.pass).length,
    verdict: pass ? "flywheel-audited" : "FAIL",
  },
  honest: {
    scope: "真实账本分级 + 真实模块脱敏/行为对比；分级是经验质量启发式审查，非能力分数",
    deltaProxy: "正向 delta 以 velocity 全局 IPA 代理（账本无 signature 维度），非逐条 delta 真值",
    notProven: ["逐条轨迹的因果 delta", "真机重放可复现性", "89×3 全量任务通过率"],
    backfill: "provider=mock 判据已固化并验证 6 类；本版不改冻结的 tb21-batch.py，仅提供可引用判据",
    falsificationFinding: "可证伪对照 A 初版把「单次成功+全局正IPA」误判 silver（非幸运路径被正向水位掩盖）；已要求 gold/silver 均满足 nonLucky 后修正，分级不再恒真",
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};

import { writeFileSync } from "node:fs";
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`轨迹飞轮审查：${report.summary.passed}/${report.summary.total} 通过 → ${report.summary.verdict}`);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
process.exit(pass ? 0 : 1);
