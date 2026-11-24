/** bro2 产出物健康度聚合器：复跑全部离线门禁，失败→非0阻断 CI；用法 project:status。 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

interface Gate {
  id: string;
  label: string;
  cmd: string; // npm run <script>
  args?: string[]; // 透传参数，不带参数的门禁省略
  timeoutMs: number;
  gate: boolean; // 是否计入发布阻断（false = 仅信息展示）
}

const GATES: Gate[] = [
  { id: "test", label: "单元测试 + e2e + 故障注入", cmd: "npm test", timeoutMs: 180_000, gate: true },
  { id: "verify", label: "能力矩阵结构自检", cmd: "npm run verify", timeoutMs: 60_000, gate: true },
  { id: "policy", label: "行为策略代码分支实证", cmd: "npm run policy:check", timeoutMs: 60_000, gate: true },
  { id: "rsi", label: "RSI 端到端 + 恶意候选注入", cmd: "npm run rsi:check", timeoutMs: 60_000, gate: true },
  { id: "contrast", label: "对比式改进 live 闭环（防 reward hacking）", cmd: "npm run contrast:live", timeoutMs: 60_000, gate: true },
  { id: "compound", label: "复利中枢（越用越快 / 越用越省，冻结速度尺子）", cmd: "npm run compound:demo", timeoutMs: 60_000, gate: true },
  { id: "watermark", label: "迭代水位（唯一尺子 / 只增账本 / 只读投影）", cmd: "npm run watermark:check", timeoutMs: 60_000, gate: true },
  { id: "budget", label: "代码预算（少而精：行数 / 文件数 / 依赖 / 测试比）", cmd: "npm run budget:check", timeoutMs: 30_000, gate: true },
  { id: "benchv2", label: "v2 分层装载 + l1 迁移回归（19/19）", cmd: "npm run bench:v2", args: ["--layer", "all", "--quiet"], timeoutMs: 120_000, gate: true },
  { id: "fixture", label: "fixture 快照完整性 + 离线测试可跑", cmd: "npm run fixture:check", args: ["--run"], timeoutMs: 180_000, gate: true },
  { id: "taskcheck", label: "L2/L3 任务双态校准（快照必失败 / 参考解必通过）", cmd: "npm run task:check", args: ["--layer", "all", "--quiet"], timeoutMs: 180_000, gate: true },
  { id: "aci", label: "编辑接口指标（改对 / 该拒就拒 / 零半成品）", cmd: "npm run aci:check", timeoutMs: 60_000, gate: true },
  { id: "faultcontrast", label: "故障恢复确定性对照（离线可复算 / 防哑弹）", cmd: "npm run fault:check", timeoutMs: 60_000, gate: true },
  { id: "promotion", label: "三段晋升判据（dev 提升 / holdout·OOD 不退化 / OOD 只读）", cmd: "npm run promotion:check", timeoutMs: 60_000, gate: true },
  { id: "segments", label: "三段任务集分层（真实冻结 / 互不相交 / OOD 只读 / 接判定机器）", cmd: "npm run segments:check", timeoutMs: 60_000, gate: true },
  { id: "endpointexp", label: "端点经验跨会话接线（越用越稳 / 失效回退 / 不绕过过滤）", cmd: "npm run endpoint:check", timeoutMs: 60_000, gate: true },
  { id: "meta", label: "元 RSI 写保护 + 冻结 fitness", cmd: "npm run meta:check", timeoutMs: 60_000, gate: true },
  { id: "benchmark", label: "基准诚实性测量", cmd: "npm run benchmark:check", timeoutMs: 60_000, gate: true },
  { id: "external", label: "外部证据防伪造", cmd: "npm run external:check", timeoutMs: 60_000, gate: true },
  { id: "preflight", label: "接入门禁防误判 / 证据隔离", cmd: "npm run preflight:check", timeoutMs: 60_000, gate: true },
  { id: "phasec", label: "阶段 C 接入（judgePromotion 消费真实三段 / OOD 只读 / 退化写 journal）", cmd: "npm run phasec:check", timeoutMs: 60_000, gate: true },
  { id: "p0.5c", label: "P0.5-c 成本晋升目标（remoteAvoided↑ 且分数不降才纳入晋升）", cmd: "npm run p0.5c:check", timeoutMs: 60_000, gate: true },
  { id: "ledger", label: "只增账本 git 历史完整性（journal/lessons 跨 commit 不可删改）", cmd: "npm run ledger:check", timeoutMs: 60_000, gate: true },
  { id: "evidence", label: "P0 独立证据重算（inter-rater：独立实现 vs 运行时尺子）", cmd: "npm run evidence:recompute", timeoutMs: 60_000, gate: true },
  { id: "redteam", label: "P0 红队安全基线（路径/命令/脱敏/越权/尺子完整性）", cmd: "npm run redteam:baseline", timeoutMs: 60_000, gate: true },
  { id: "maclocal", label: "P1 本地自治（24G Mac 预算/双后端配置/断网无key契约）", cmd: "npm run mac:local", timeoutMs: 60_000, gate: true },
  { id: "failover", label: "P1 端点失效零污染（8/8超时+断网闭环+可证伪对照）", cmd: "npm run failover:proof", timeoutMs: 120_000, gate: true },
  { id: "flywheel", label: "P2 轨迹飞轮（分级+脱敏+失败留痕+mock判据回填）", cmd: "npm run flywheel:check", timeoutMs: 60_000, gate: true },
  { id: "trainergate", label: "P3 训练器闸门（无对照不晋升+回滚+reward-hacking拦截）", cmd: "npm run promotion:gate", timeoutMs: 60_000, gate: true },
  { id: "whitebox", label: "P4 白盒面板（决策链可重建+审批拦截+能效偏差告警）", cmd: "npm run whitebox:panel", timeoutMs: 60_000, gate: true },
  { id: "thirdparty", label: "P5 统计骨架（kappa+McNemar+功效不足诚实声明）", cmd: "npm run thirdparty:review", timeoutMs: 60_000, gate: true },
  { id: "injectdef", label: "F4 提示注入防御（不可信隔离+几何检测+审批deny）", cmd: "npm run inject:defense", timeoutMs: 60_000, gate: true },
  { id: "promolive", label: "F5 judgePromotion接线（OOD阻断+reward-hacking+缺格）", cmd: "npm run promotion:live", timeoutMs: 60_000, gate: true },
  { id: "guardback", label: "F6 provider=mock判据回填（机器字段优先+盲区对照）", cmd: "npm run guard:backfill", timeoutMs: 60_000, gate: true },
  { id: "energymeter", label: "F3 真系统计数器（VmRSS+cgroup+unmeasured不造数）", cmd: "npm run energy:meter", timeoutMs: 60_000, gate: true },
  { id: "gradeind", label: "F2 独立判分（verifier重判+产出缺失诚实声明）", cmd: "npm run grade:independent", timeoutMs: 60_000, gate: true },
  { id: "hwrunbook", label: "真机流程闭环（契约+脚本+回填schema，未执行）", cmd: "npm run hw:runbook", timeoutMs: 60_000, gate: true },
  { id: "livesmoke", label: "live 链路自检（仿真，非能力分）", cmd: "npm run live:smoke", timeoutMs: 60_000, gate: false },
];

// 信息展示类（依赖网络 / 真实端点，不阻断发布）
const INFO: Gate[] = [
  { id: "freeprobe", label: "免费 API 可达性探针", cmd: "npm run free:probe", timeoutMs: 120_000, gate: false },
  { id: "pushcheck", label: "远程同步一致性（防漏推，只读）", cmd: "npm run push:check", timeoutMs: 90_000, gate: false },
];

function lastMeaningfulLine(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/pass|PASS|通过|结果|ALL|overall|✓|✗|FAIL|error/i.test(l)) return l.slice(0, 120);
  }
  return lines[lines.length - 1]?.slice(0, 120) ?? "";
}

function testFiles(): string[] {
  // 直接展开 tests/*.test.ts，避免依赖 shell glob 与 npm 嵌套对生命周期脚本的限制
  return readdirSync("tests")
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => `tests/${f}`);
}

function run(g: Gate): { ok: boolean; summary: string; code: number } {
  let r: ReturnType<typeof spawnSync>;
  if (g.id === "test") {
    // 直接调用 node 测试运行器：绕过 npm 在脚本上下文内对 `test` 生命周期脚本的嵌套限制
    r = spawnSync("node", [
      "--experimental-strip-types",
      "--no-warnings",
      "--test",
      ...testFiles(),
    ], { encoding: "utf8", timeout: g.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  } else {
    // 参数必须经 `--` 透传，否则会被当成 script 名的一部分（npm error）。
    const script = g.cmd.replace(/^npm run /, "");
    const extra = g.args?.length ? ["--", ...g.args] : [];
    r = spawnSync("npm", ["run", script, ...extra], {
      encoding: "utf8",
      timeout: g.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const code = r.status ?? (r.error ? 1 : 0);
  const timedOut = r.error?.message?.includes("timeout");
  return {
    ok: code === 0 && !timedOut,
    summary: timedOut ? `超时（>${g.timeoutMs}ms）` : lastMeaningfulLine(out),
    code,
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

function section(title: string, gates: Gate[]) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log(pad("状态", 6) + pad("ID", 12) + pad("门禁", 36) + "摘要");
  console.log("-".repeat(96));
  let pass = 0;
  for (const g of gates) {
    const { ok, summary, code } = run(g);
    if (ok) pass++;
    const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(pad(mark, 6) + pad(g.id, 12) + pad(g.label, 36) + summary);
  }
  return { pass, total: gates.length };
}

console.log("\x1b[1m════════════════════════════════════════════════════════════\x1b[0m");
console.log("\x1b[1m  bro2 · 产出物健康度报告 (npm run project:status)\x1b[0m");
console.log("\x1b[1m════════════════════════════════════════════════════════════\x1b[0m");
const pkgVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
console.log(`版本: v${pkgVersion}   判定: leadership.verdict = not-proven   证据阶梯 L4 = not-achieved`);

const gateRes = section("A. 发布阻断门禁（全绿方可发布）", GATES);
const infoRes = section("B. 信息展示（不阻断发布）", INFO);

console.log("\n\x1b[1m════════════════════════════════════════════════════════════\x1b[0m");
console.log(
  `阻断门禁: ${gateRes.pass}/${gateRes.total} 通过   |   信息项: ${infoRes.pass}/${infoRes.total} 可达`,
);
const healthy = gateRes.pass === gateRes.total;
console.log(
  healthy
    ? "\x1b[32m✓ 产出物健康：所有发布门禁通过，可进入发布流程（git tag + CHANGELOG + DELIVERABLES 同步）。\x1b[0m"
    : "\x1b[31m✗ 产出物不健康：存在未通过的发布门禁，先修复再发布。\x1b[0m",
);
console.log("════════════════════════════════════════════════════════════\n");

process.exitCode = healthy ? 0 : 1;
