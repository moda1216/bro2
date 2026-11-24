/**
 * bro2 · F3 能效真系统计数器（替换 whitebox-panel 的仿真数字）
 * ----------------------------------------------------------------
 * 审计发现（DEEP-REWRITE-AUDIT §3 需求6 / §5 发现3）：
 *   whitebox-panel.json 的 energy 段 externalTokens=4200/selfReportedTokens=1500
 *   是为演示告警构造的数字；唯一真实数字是 rssMB=78.3。honest 自认 token 为仿真。
 *   验收要求「系统工具独立测量」。本工具用真实 OS 计数器替换仿真值。
 *
 * 真实数据源（本环境可用，已探测）：
 *   - /proc/self/status VmRSS        → 进程常驻内存（kB → MB）
 *   - /sys/fs/cgroup/cpu.stat usage_usec → cgroup CPU 累计时间（μs）
 *   - /sys/fs/cgroup/memory.current  → cgroup 内存当前值（bytes）
 *   - 端点 token usage 字段           → 若不存在，标 unmeasured，绝不仿真填充
 *
 * 可证伪对照（改坏就变红）：
 *   A VmRSS 真实读取 → 返回有限正数；
 *   B 分配 8MB 缓冲区后 VmRSS 单调不减（真随内存变化）；
 *   C cgroup CPU 读数在忙等后单调增（真计数器）；
 *   D 无 usage 字段 → token 标 unmeasured（不沿用 4200、不造数）；
 *   E 有 usage 字段 → 采信原始值并标注来源；
 *   F dev=selfReported 与 external 一致时不误报告警（防恒真告警）。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/energy-meter.ts
 * 输出：data/evidence/energy-meter.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/evidence/energy-meter.json");

interface Check { name: string; pass: boolean; evidence: Record<string, unknown> }
const checks: Check[] = [];
const check = (name: string, pass: boolean, evidence: Record<string, unknown>): void => {
  checks.push({ name, pass, evidence });
};

// ---- 真实 OS 计数器 ----
function readVmRSSkB(): number {
  const s = readFileSync("/proc/self/status", "utf8");
  const m = s.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return m ? Number(m[1]) : NaN;
}
function readCgroupCpuUsec(): number {
  if (!existsSync("/sys/fs/cgroup/cpu.stat")) return NaN;
  const s = readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
  const m = s.match(/^usage_usec\s+(\d+)/m);
  return m ? Number(m[1]) : NaN;
}
function readCgroupMemBytes(): number {
  if (!existsSync("/sys/fs/cgroup/memory.current")) return NaN;
  return Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
}

const rss0 = readVmRSSkB();
const cpu0 = readCgroupCpuUsec();
const mem0 = readCgroupMemBytes();

check("A VmRSS 真实读取为有限正数", Number.isFinite(rss0) && rss0 > 0, { rssKB: rss0, rssMB: +(rss0 / 1024).toFixed(2) });
// cgroup 计数器在部分 CI runner 不存在：不可用时诚实标 unmeasured（不造数、不硬失败）。
const cgroupAvailable = Number.isFinite(mem0) && Number.isFinite(cpu0);
check("A2 cgroup memory.current（可用则真读，不可用标 unmeasured）",
  !Number.isFinite(mem0) ? true : mem0 > 0,
  Number.isFinite(mem0) ? { memBytes: mem0, memMB: +(mem0 / 1048576).toFixed(2) } : { memBytes: "unmeasured", note: "cgroup 计数器不可用" });

// B 分配 8MB 后 VmRSS 单调不减（真随内存变化）
const hold: number[] = [];
for (let i = 0; i < 8 * 1024 * 1024 / 8; i++) hold.push(i); // ~64MB，确保触及 RSS
let sink = 0;
for (let i = 0; i < hold.length; i += 997) sink += hold[i]!;
const rss1 = readVmRSSkB();
check("B 分配缓冲区后 VmRSS 单调不减", Number.isFinite(rss1) && rss1 >= rss0, {
  rss0KB: rss0, rss1KB: rss1, deltaKB: rss1 - rss0, sink: sink > 0,
});

// C cgroup CPU 在忙等后单调增
const spinUntil = Date.now() + 30;
while (Date.now() < spinUntil) { /* 忙等 30ms */ }
const cpu1 = readCgroupCpuUsec();
check("C cgroup CPU（可用则单调增，不可用标 unmeasured）",
  !cgroupAvailable ? true : (Number.isFinite(cpu1) && cpu1 >= cpu0),
  cgroupAvailable ? { cpu0Usec: cpu0, cpu1Usec: cpu1, deltaUsec: cpu1 - cpu0 } : { cpu: "unmeasured", note: "cgroup 计数器不可用" });
void hold; // 防止被优化掉

// D/E token：无 usage 字段标 unmeasured，绝不仿真
interface TokenSample { source: string; promptTokens?: number; completionTokens?: number; usage?: unknown }
const noUsage: TokenSample = { source: "local-llm-stats.json", promptTokens: 35446, completionTokens: 105 };
const withUsage: TokenSample = { source: "endpoint-response", usage: { prompt_tokens: 120, completion_tokens: 30 } };

function tokenReading(s: TokenSample): { measured: boolean; prompt?: number; completion?: number; note: string } {
  // 只认端点原始 usage 字段；不存在则 unmeasured，不用 promptTokens 等聚合字段冒充「外部 usage」。
  const u = s.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
    return { measured: true, prompt: u.prompt_tokens, completion: u.completion_tokens, note: "端点原始 usage 字段" };
  }
  return { measured: false, note: "unmeasured: 端点未提供 usage 字段，token 未测量（不仿真填充）" };
}

const d = tokenReading(noUsage);
check("D 无 usage 字段 → token 标 unmeasured（不造数）", d.measured === false && d.note.includes("unmeasured"), d);
const e = tokenReading(withUsage);
check("E 有 usage 字段 → 采信原始值并标注来源", e.measured === true && e.prompt === 120 && e.completion === 30, e);

// F 自报 vs 外部一致性：一致时不误报告警（防恒真告警）
function deviationAlert(external: number, selfReported: number, threshold = 0.5): { deviation: number; alert: boolean } {
  const deviation = external === 0 ? (selfReported === 0 ? 0 : 1) : Math.abs(external - selfReported) / external;
  return { deviation: +deviation.toFixed(3), alert: deviation > threshold };
}
const consistent = deviationAlert(1500, 1500);
check("F 自报与外部一致 → 不误报告警", consistent.deviation === 0 && !consistent.alert, consistent);
const inconsistent = deviationAlert(4200, 1500);
check("F2 自报显著偏低 → 告警（真偏差）", inconsistent.alert === true, inconsistent);

// 真实测量快照（末尾再取一次，作为交付值）
const memB = readCgroupMemBytes();
const cpuU = readCgroupCpuUsec();
const snapshot = {
  rssMB: +(readVmRSSkB() / 1024).toFixed(2),
  cgroupMemMB: Number.isFinite(memB) ? +(memB / 1048576).toFixed(2) : "unmeasured",
  cgroupCpuUsec: Number.isFinite(cpuU) ? cpuU : "unmeasured",
  measuredAt: new Date().toISOString(),
  source: "OS /proc + cgroup v2（不可用时标 unmeasured，非 agent 自报、不造数）",
};

const passed = checks.filter((c) => c.pass).length;
const report = {
  generatedAt: new Date().toISOString(),
  purpose: "F3：用真实 OS 计数器替换 whitebox 的仿真能效值；无 usage 标 unmeasured",
  realSnapshot: snapshot,
  checks,
  summary: { total: checks.length, passed, failed: checks.length - passed, verdict: passed === checks.length ? "energy-meter-green" : "energy-meter-red" },
  honest: {
    scope: "VmRSS/cgroup CPU/内存为真实 OS 计数；token 只认端点 usage 字段，缺失标 unmeasured",
    notProven: ["整机能耗（无 powermetrics/RAPL，本环境不测）", "Apple Silicon 统一内存峰值", "端点 usage 字段的真实可得性（取决于端点实现）"],
    replacedSimulated: "whitebox-panel.json 的 externalTokens=4200/selfReportedTokens=1500 为构造演示值，本工具不再沿用",
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(`F3 真系统计数器：${passed}/${checks.length} ${report.summary.verdict}`);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
console.log(`真实快照: RSS=${snapshot.rssMB}MB cgroupMem=${snapshot.cgroupMemMB}MB cpu=${snapshot.cgroupCpuUsec}us`);
if (passed !== checks.length) process.exitCode = 1;
