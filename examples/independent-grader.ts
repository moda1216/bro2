/**
 * bro2 · F2 独立判分器对 agent 产出重判（受数据可得性约束，如实降级）
 * ----------------------------------------------------------------
 * 审计发现（DEEP-REWRITE-AUDIT V2）：recompute-report 8/8 重算的是「水位账本」，
 * 不是「agent 产出判分」。真正的 V2 应对 agent 终答/workspace 重判并比对 reward。
 *
 * 本工具先探测数据可得性：tb21-full-results.jsonl 每行字段为
 *   task/repeat/status/reward/verifyNote/steps/tokens/bro2_rc/wallSeconds/log/ts/sanity/image
 *   —— 没有 workspace 快照、没有终答文本。因此「对 agent 产出重判」在当前数据上
 *   物理不可行；这是必须如实暴露的一手缺口，不伪造 workspace 充数。
 *
 * 本工具做两件真实可做的事：
 *   1) 独立重判可得信号：从 verifyNote(官方 verifier rc) 独立推导 reward，
 *      不 import eval-grade.ts，与落盘 reward 逐条比对（rc=0 → 1，否则 0）。
 *   2) 数据可得性审计：明确列出缺失字段（workspace/answer），判产出重判为 not-proven。
 *
 * 可证伪对照（改坏就变红）：
 *   A 逐条一致率：独立推导 vs 落盘 reward 必须逐条列出，篡改一条必检出；
 *   B 篡改 reward（内存副本）→ 独立重判必须报不一致；
 *   C verifier rc 与 reward 的判定口径边界（rc=0↔1）可复算；
 *   D workspace/answer 缺失 → 明确判产出重判 not-proven（不伪造）；
 *   E 不 import eval-grade.ts（源码级独立）→ 用文件检查佐证。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/independent-grader.ts
 * 输出：data/evidence/independent-grader.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/evidence/independent-grader.json");

interface Row {
  task: string; repeat: number; reward: number; verifyNote?: string;
  bro2_rc?: number; status?: string;
}
const rows: Row[] = readFileSync(resolve(ROOT, "data/bench/external/tb21-full-results.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);

interface Check { name: string; pass: boolean; evidence: Record<string, unknown> }
const checks: Check[] = [];
const check = (name: string, pass: boolean, evidence: Record<string, unknown>): void => {
  checks.push({ name, pass, evidence });
};

// 独立判分：只从官方 verifier rc 推导，不读 harness 内部行为指标，不 import 判分器。
function rewardFromVerifier(row: Row): number | null {
  const m = row.verifyNote?.match(/rc=(\d+)/);
  if (!m) return null;                 // 缺失 verifier 结果 → 不可判，不猜
  return Number(m[1]) === 0 ? 1 : 0;   // 官方 verifier rc=0 视为通过
}

const graded = rows.map((r) => {
  const derived = rewardFromVerifier(r);
  return {
    task: r.task, repeat: r.repeat,
    stored: r.reward,
    derived,
    agree: derived === null ? null : derived === r.reward,
  };
});
const comparable = graded.filter((g) => g.agree !== null);
const agreeCount = comparable.filter((g) => g.agree).length;

// A 逐条一致率：全部列出，不隐藏
check("A 独立推导出 reward 与落盘逐条一致", comparable.length > 0 && agreeCount === comparable.length, {
  comparable: comparable.length, agree: agreeCount,
  perRow: graded.map((g) => ({ t: g.task, r: g.repeat, stored: g.stored, derived: g.derived, agree: g.agree })),
});

// B 篡改检测：复制一份改 reward，独立重判必须报不一致
const tampered = rows.map((r, i) => i === 0 ? { ...r, reward: r.reward === 1 ? 0 : 1 } : r);
const tamperDetected = tampered.some((r, i) => rewardFromVerifier(r) !== r.reward && i === 0);
check("B 篡改一条 reward → 独立重判检出不一致", tamperDetected, {
  original: rows[0]?.reward, tampered: tampered[0]?.reward, derived: rewardFromVerifier(rows[0]!),
});

// C 判定口径边界可复算
const boundary = [
  { verifyNote: "rc=0", expect: 1 },
  { verifyNote: "rc=1", expect: 0 },
  { verifyNote: "rc=2", expect: 0 },
  { verifyNote: "无 rc", expect: null },
].map((c) => ({ ...c, actual: rewardFromVerifier({ task: "x", repeat: 1, reward: 0, verifyNote: c.verifyNote }) }));
check("C verifier rc→reward 口径边界可复算", boundary.every((b) => b.actual === b.expect), boundary);

// D 数据可得性：workspace/answer 是否存在
const keys = new Set(rows.flatMap((r) => Object.keys(r)));
const hasWorkspace = keys.has("workspace") || keys.has("workspaceHash");
const hasAnswer = keys.has("answer");
check("D workspace/终答缺失 → 产出重判判 not-proven（如实）", !hasWorkspace && !hasAnswer, {
  keys: [...keys], hasWorkspace, hasAnswer,
  consequence: "真实「对 agent 产出重判」不可做；本工具只对可得的 verifier rc 做独立一致性核对",
});

// E 源码级独立：本文件不 import eval-grade.ts
const selfSrc = readFileSync(resolve(ROOT, "examples/independent-grader.ts"), "utf8");
const importsEvalGrade = /from\s+["'][^"']*eval-grade\.ts["']/.test(selfSrc);
check("E 不 import eval-grade.ts（判分器独立）", !importsEvalGrade, { importsEvalGrade });

const passed = checks.filter((c) => c.pass).length;
const report = {
  generatedAt: new Date().toISOString(),
  purpose: "F2：独立判分器不 import 判分器，对可得信号重判；审计产出重判的数据可得性",
  method: "从官方 verifier rc 独立推导 reward（rc=0→1 否则 0），与落盘逐条比对",
  coverage: {
    rows: rows.length,
    comparable: comparable.length,
    agree: agreeCount,
    perRowAgreement: graded.map((g) => ({ task: g.task, repeat: g.repeat, stored: g.stored, derived: g.derived, agree: g.agree })),
  },
  checks,
  summary: { total: checks.length, passed, failed: checks.length - passed, verdict: passed === checks.length ? "independent-grade-green" : "independent-grade-red" },
  honest: {
    scope: "独立核对 verifier rc→reward 一致性 + 数据可得性审计；不是对 agent 产出的真正重判",
    notProven: ["对 agent 终答/workspace 的独立重判（结果行未存 workspace/answer，物理不可做）",
                "榜单级能力结论（9/267 partial）", "第三方判分器一致性（verifier 与落盘同源，非独立评分者）"],
    gap: "要让 V2 真正成立，评测流水线需逐 trial 留存 workspace 快照与终答 hash，供独立判分器重判。本沙箱不伪造该数据。",
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(`F2 独立判分：${passed}/${checks.length} ${report.summary.verdict}`);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
console.log(`  一致性: ${agreeCount}/${comparable.length}（逐条见 evidence）`);
if (passed !== checks.length) process.exitCode = 1;
