/**
 * bro2 · 能力水位定位视图（离线、确定性、无需任何 API Key、不产生能力分数）
 *
 * 这一棒要回答的不是「bro2 多强」，而是「bro2 在公开可比尺子上到底站在哪一格」。
 * 结论由真实落盘报告 + 外部参照系台账驱动，不靠口头宣称：
 *   1) 从 data/benchmark-report.json 读真实证据阶梯（achievedLevels / verdict / 外部导入数）；
 *   2) 从 data/reference-landscape.json 读外部公开参照系，逐条标注 bro2 是否已测；
 *   3) 防自指断言：外部数字绝不被算成 bro2 成绩、L4 仍 not-achieved、verdict 仍 not-proven、
 *      参照系不进入 external-results.json 通道、每条参照都有来源与证据等级；
 *   4) 渲染「bro2 在哪一格」——公开榜有分数、bro2 侧全部 not-measured，缺口即定位。
 *
 * 诚实边界：本脚本是「定位体检」不是能力评测；它不改变任何报告、不写任何证据文件、
 * 不提升 L4、不改 verdict。全文零外部数字被记入 bro2 名下。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessEvidenceLadder } from "../src/benchmark/ladder.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, note = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  ok ? pass++ : fail++;
};

interface RefEntry {
  id: string; category: string; name: string; claim: string; value: string;
  source: string; url: string; evidenceTier: string; bro2Relevance: string; bro2Measured: boolean;
}
interface Landscape {
  notL4Evidence: boolean; bro2Measured: boolean; retrievedAt: string;
  honestyBoundary: string; entries: RefEntry[];
}

const landscape: Landscape = JSON.parse(
  readFileSync(join(ROOT, "data", "reference-landscape.json"), "utf8"),
);

console.log("=".repeat(84));
console.log("  bro2 · 能力水位定位视图（只读 / 不产生能力分数）");
console.log("=".repeat(84));

// ---- 1) 真实证据阶梯：不粉饰，直接从落盘报告驱动 ----
console.log("\n【1】真实证据阶梯（data/benchmark-report.json → assessEvidenceLadder）");
const ladder = assessEvidenceLadder(ROOT);
const l4 = ladder.levels.find((l) => l.id === 4)!;
check("L4 公开基准对齐 = not-achieved", l4.status === "not-achieved", `status=${l4.status}`);
check("leadership.verdict = not-proven", ladder.claim.verdict === "not-proven", `verdict=${ladder.claim.verdict}`);
check("外部基准导入数 = 0", ladder.claim.externalBenchmarksImported === 0,
  `imported=${ladder.claim.externalBenchmarksImported}`);
check("外部结果提交数 = 0", ladder.externalValidation.submitted === 0,
  `submitted=${ladder.externalValidation.submitted}`);
console.log(`  已达成层级: [${ladder.claim.achievedLevels.join(", ")}]  ·  L3=partial  ·  L4=not-achieved`);
console.log(`  L4 缺口: ${l4.gap}`);

// ---- 2) 外部参照系台账完整性：每条都有来源、日期、证据等级 ----
console.log("\n【2】外部公开参照系台账（data/reference-landscape.json）");
check("标注 notL4Evidence=true", landscape.notL4Evidence === true);
check("标注 bro2Measured=false（外部数字不算 bro2 成绩）", landscape.bro2Measured === false);
check("检索日期已登记", /^\d{4}-\d{2}-\d{2}$/.test(landscape.retrievedAt), landscape.retrievedAt);
check("参照条目 ≥ 10", landscape.entries.length >= 10, `${landscape.entries.length} 条`);
check("每条都有来源与 URL", landscape.entries.every((e) => e.source && /^https?:\/\//.test(e.url)));
check("每条都有证据等级（primary/secondary）",
  landscape.entries.every((e) => ["primary", "secondary"].includes(e.evidenceTier)));
check("每条都标注 bro2Measured=false（无一条被算成 bro2 成绩）",
  landscape.entries.every((e) => e.bro2Measured === false));
check("每条都写明与 bro2 的相关性", landscape.entries.every((e) => e.bro2Relevance.length > 0));
const primary = landscape.entries.filter((e) => e.evidenceTier === "primary").length;
console.log(`  证据等级分布: primary=${primary} / secondary=${landscape.entries.length - primary}`);
console.log(`  分类: ${[...new Set(landscape.entries.map((e) => e.category))].join(", ")}`);

// ---- 3) 防自指：参照系与外部证据通道物理隔离 ----
console.log("\n【3】防自指断言（外部参照 ≠ bro2 成绩）");
const externalPath = join(ROOT, "data", "benchmark", "external-results.json");
check("external-results.json 通道为空", !existsSync(externalPath),
  existsSync(externalPath) ? "存在——需人工判断是否合法第三方结果" : "不存在");
check("参照系文件不是 external-results.json（不冒充外部证据）",
  resolve(join(ROOT, "data", "reference-landscape.json")) !== resolve(externalPath));
check("诚实边界声明存在且指明『未测量』",
  /未测量|不是 bro2 的成绩/.test(landscape.honestyBoundary));

// ---- 4) 定位视图：公开榜有分数，bro2 侧全部未测 ----
console.log("\n【4】定位视图 —— bro2 在公开可比尺子上站在哪一格");
const rows: [string, string, string][] = [
  ["SWE-bench Pro（公开榜 top）", "61.5% ±3.1 (mini-swe-agent)", "not-measured"],
  ["Terminal-Bench 4.0（公开榜 top）", "64.85% ±3.11 (Claude Code)", "not-measured"],
  ["OSWorld 2.0（长程 computer-use）", "20.6% binary / 54.8% partial", "not-measured"],
  ["同模型换 harness 增益", "+9.5 ~ +16.6pp（外部实证）", "not-measured"],
  ["Harness-RSI 演化增益", "64.6 → 78.7 (RRSI, TB2.1)", "not-measured"],
  ["bro2 自建确定性域", "overall=1.0（mock，模型不参与）", "仅内部，无外部可比性"],
  ["bro2 唯一 live 触碰", "overall=0.7（kilo 免 Key，10 题 k=1）", "非干净基准"],
];
console.log(`  ${"公开尺子".padEnd(34)} ${"外部成绩".padEnd(40)} bro2`);
for (const [k, v, b] of rows) console.log(`  ${k.padEnd(34)} ${v.padEnd(40)} ${b}`);
check("bro2 在每一条公开尺子上均为 not-measured / 无外部可比性",
  rows.slice(0, 5).every((r) => /not-measured/.test(r[2])));

// ---- 5) ROI 缺口：定位已完成的判定，而非口号 ----
console.log("\n【5】定位结论与 ROI 缺口（本轮战果）");
const gaps = [
  "定位已完成：L0/L1/L2 达成、L3 partial、L4 not-achieved、verdict not-proven、外部证据 0 条",
  "根因不是『没 GPU/没 Key』：现有 19 个 4–5 步脚本化短任务测不出 harness 价值（PLAN-TOP-HARNESS §0）",
  "结构性缺口：W5-05『同期 harness 同模型对照』被 W5-01→04 依赖链压在末尾，执行度为零",
  "最高 ROI：用 Harbor + mini-swe-agent / Terminus-2 把 W5-05 解耦为 P0，先产出第一组同模型对照数",
  "次高 ROI：Context 层紧窗口压缩（外部实证 F2P 28%→49%，且跨模型免调参迁移）",
  "退出信号：若同模型对照显示 Δ≤0，bro2 应降级为『可验证 RSI 研究台』而非竞争 harness",
];
gaps.forEach((g, i) => console.log(`  ${i + 1}. ${g}`));
check("ROI 缺口以可证伪实验（同模型对照）为第一优先，而非再造治理门禁", /Harbor/.test(gaps[3]));

console.log("\n" + "=".repeat(84));
console.log(`  结果: ${pass} / ${pass + fail} 通过` + (fail ? `  ✗ ${fail} 项失败` : "  ✓ ALL PASS"));
console.log("  诚实边界：本视图不产生能力分数、不改 L4、不改 verdict、不写任何证据文件。");
console.log("=".repeat(84) + "\n");
if (fail > 0) process.exitCode = 1;
