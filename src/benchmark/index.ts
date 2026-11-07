/**
 * bro2 · 能力基准总入口
 *
 * 把「证明领先」变成一台可运行、可复核、可证伪的机器：
 *   ablation（内部可控对照） → evidence ladder（5 级判据自动判定） → leadershipClaim（诚实结论）
 * 报告落盘到 data/benchmark-report.json，供 ladder 下一轮读取，形成自洽证据链。
 *
 * 注意：benchmark-report.json 是 bro2 自己的产物，属于**内部证据**；
 * 外部证据只认 data/benchmark/external-results.json 且须过 external.ts 校验。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runAblation, formatAblationReport, DEFAULT_VARIANTS } from "./ablation.ts";
import type { AblationReport } from "./ablation.ts";
import { assessEvidenceLadder } from "./ladder.ts";
import type { LadderAssessment, LeadershipClaim } from "./ladder.ts";

export interface CrossProviderStatus {
  adaptersReady: string[];
  capabilityProbe: boolean;
  protocolLevelVerified: boolean;
  realModelMatrix: boolean;
  pendingCommands: string[];
  note: string;
}

export interface BenchmarkReport {
  version: 1;
  agent: "bro2";
  timestamp: string;
  ablation: AblationReport;
  ladder: LadderAssessment;
  crossProvider: CrossProviderStatus;
  leadership: LeadershipClaim;
  /** 复现本报告所需的全部命令 */
  reproduce: string[];
}

export interface BenchmarkOptions {
  root: string;
  onProgress?: (line: string) => void;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const root = options.root;
  const reportPath = join(root, "data/benchmark-report.json");
  mkdirSync(dirname(reportPath), { recursive: true });

  const ablation = await runAblation({
    root,
    extraTasksPaths: [join(root, "data/eval-tasks.jsonl")],
    onProgress: options.onProgress,
  });

  // 先写中间态，让 evidence ladder 能读到本轮 ablation 变体数（自洽证据链）。
  // 不再写 external 占位字段：benchmark-report.json 是内部产物，不能被误当成外部证据来源。
  writeFileSync(reportPath, JSON.stringify({ ablation: ablation.results }, null, 2));
  const ladder = assessEvidenceLadder(root);

  const crossProvider: CrossProviderStatus = {
    adaptersReady: ["mock（离线确定性）", "openai（任意 OpenAI 兼容端点）", "ollama（本地，免 API Key）"],
    capabilityProbe: true,
    protocolLevelVerified: true,
    realModelMatrix: false,
    pendingCommands: [
      "npm run doctor             # 探测真实端点的 tool_calling 能力",
      "npm run ollama:check       # 协议级高保真仿真（已在沙箱验证）",
      "npm run eval:live          # 需本地起 Ollama，产出第一份真实模型分数",
      "AGENTOS_MODEL=openai npm run eval:live   # 云端 provider 对比",
    ],
    note:
      "沙箱无 GPU / 无 Ollama / 无 API Key，跨 provider 对比目前只有协议级证据；" +
      "provider 适配、能力探针与 strict 模式已就绪，接上真实端点即可跑出矩阵。" +
      "真机接管流程见 docs/TAKEOVER.md。",
  };

  const report: BenchmarkReport = {
    version: 1,
    agent: "bro2",
    timestamp: new Date().toISOString(),
    ablation,
    ladder,
    crossProvider,
    leadership: ladder.claim,
    reproduce: [
      "npm test",
      "npm run eval",
      "npm run evolve",
      "npm run meta",
      "npm run benchmark",
      "npm run external:check     # 外部证据导入通道的防伪造实证",
      "npm run doctor && npm run eval:live   # 真实模型（需用户自备端点）",
    ],
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}

export function formatBenchmarkReport(r: BenchmarkReport): string {
  const L: string[] = [];
  const bar = "=".repeat(84);
  L.push(bar);
  L.push("  bro2 · 能力基准与领先度评估（可证伪）");
  L.push(bar);
  L.push("");
  L.push(formatAblationReport(r.ablation));
  L.push("");
  L.push("  【证据阶梯】");
  for (const l of r.ladder.levels) {
    const mark = l.status === "achieved" ? "✓" : l.status === "partial" ? "~" : "✗";
    L.push(`   ${mark} L${l.id} ${l.name.padEnd(30)} ${l.status}`);
    L.push(`      判据: ${l.criterion}`);
    if (l.evidence.length) L.push(`      证据: ${l.evidence.join(" | ")}`);
    L.push(`      缺口: ${l.gap}`);
  }
  L.push("");
  L.push("  【外部证据校验】");
  const x = r.ladder.externalValidation;
  L.push(`   来源: ${x.source}`);
  L.push(`   提交 ${x.submitted} / 采纳 ${x.accepted} / 拒绝 ${x.rejected.length} / 文件错误 ${x.fileErrors.length}`);
  if (x.benchmarks.length) L.push(`   已采纳基准: ${x.benchmarks.join(" / ")}`);
  for (const e of x.rejected) L.push(`   拒绝 #${e.index}: ${e.reason}`);
  for (const e of x.fileErrors) L.push(`   文件错误: ${e}`);
  L.push("   校验通过只把 L4 提到 partial；verdict 恒为 not-proven（需第三方复核）");
  L.push("");
  L.push("  【领先度结论】");
  L.push(`   verdict: ${r.leadership.verdict}`);
  L.push(`   ${r.leadership.headline}`);
  L.push("   尚缺：");
  for (const m of r.leadership.missingForIndustryLeading) L.push(`     - ${m}`);
  L.push(`   可证伪性: ${r.leadership.falsification}`);
  L.push("");
  L.push("  【跨 provider 就绪度】");
  L.push(`   适配器 ${r.crossProvider.adaptersReady.join(" / ")}`);
  L.push(`   真实模型矩阵: ${r.crossProvider.realModelMatrix ? "已跑" : "未跑（沙箱无端点）"}`);
  L.push("");
  L.push("  【复现命令】");
  for (const c of r.reproduce) L.push(`   ${c}`);
  L.push(bar);
  return L.join("\n");
}

export { formatAblationReport, DEFAULT_VARIANTS };
export { assessEvidenceLadder, EXTERNAL_RESULT_SCHEMA } from "./ladder.ts";
export { validateExternalResult, loadExternalResults } from "./external.ts";
export { capabilityProfile, profileDelta, measureMetaFitness } from "./scoring.ts";
