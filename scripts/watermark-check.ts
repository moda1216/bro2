/**
 * bro2 · 水位完整性门禁（project:status 第 12 道）
 *
 * 验证「看到的水位」确实来自只增账本 + 唯一冻结尺子，没有被改写或伪造：
 *   1) velocity.ts 的 Ledger.snapshot 必须委托 velocitySnapshotFrom（尺子只有一份）；
 *   2) 账本每条记录结构完整、seq 连续，且本脚本运行前后账本字节不变（只读）；
 *   3) buildWatermark 的当前趋势 == 同一把尺子对全量记录的判定；
 *   4) 派生视图（HTML / JSON / DOC）存在、JSON 与账本一致、HTML 无异常数值。
 *
 * 空账本不算失败：只提示尚未启动进化（发布门禁不应因「还没跑」而阻断）。
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { VelocityLedger, velocitySnapshotFrom, velocityPath } from "../src/rsi/velocity.ts";
import { ExperienceBank, experiencePath } from "../src/rsi/experience.ts";
import { buildWatermark } from "../src/rsi/watermark.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = velocityPath(ROOT);
const BANK = experiencePath(ROOT);
const HTML = resolve(ROOT, "data/rsi/watermark.html");
const JSON_OUT = resolve(ROOT, "data/rsi/watermark.json");
const DOC = resolve(ROOT, "docs/ITERATION-WATERMARK.md");

const line = (s = ""): void => { process.stdout.write(s + "\n"); };
const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean): void => { checks.push([label, ok]); };

// 1) 冻结尺子唯一性（静态源码约束，防止有人在水位看板里另起一套判定）
const velocitySrc = readFileSync(resolve(ROOT, "src/rsi/velocity.ts"), "utf8");
check("Ledger.snapshot 委托冻结尺子纯函数", /snapshot\(\):\s*VelocitySnapshot\s*\{[\s\S]{0,160}velocitySnapshotFrom\(this\.records\(\)\)/.test(velocitySrc));
check("冻结尺子为唯一导出实现", /export function velocitySnapshotFrom\(/.test(velocitySrc));

// 2) 账本结构 + 只读性
const before = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : "";
const ledger = new VelocityLedger(LEDGER);
const bank = new ExperienceBank(BANK);
const records = ledger.records();
const wellFormed = records.every((r, i) =>
  r.seq === i && typeof r.ts === "string"
  && Number.isFinite(r.attempts) && Number.isFinite(r.improvement)
  && Number.isFinite(r.probesAvoided) && Number.isFinite(r.protocolViolations));
check(`速度账本 ${records.length} 条记录结构完整、seq 连续`, wellFormed);

// 3) 报告与尺子一致
const report = buildWatermark(ledger, bank);
check("水位当前趋势 == 冻结尺子对全量账本的判定", report.current.trend === velocitySnapshotFrom(records).trend);
check("逐轮点数 == 账本记录数", report.points.length === records.length);
check("水位报告自述 frozenMetric / 非自报", report.honesty.frozenMetric === true && report.honesty.selfReported === false);
check("水位报告不改动 verdict / L4", report.honesty.verdict === "not-proven" && report.honesty.l4 === "not-achieved");

// 4) 派生视图
const html = existsSync(HTML) ? readFileSync(HTML, "utf8") : "";
const md = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
const json = existsSync(JSON_OUT) ? JSON.parse(readFileSync(JSON_OUT, "utf8")) : null;
check("HTML 看板存在且含四条曲线", html.length > 0 && (html.match(/<path d=/g) ?? []).length === 4);
check("HTML 无 NaN/Infinity/undefined", !/NaN|Infinity|undefined/.test(html));
check("HTML 标注诚实边界", /leadership\.verdict=not-proven/.test(html) && /frozenMetric/.test(html));
check("Markdown 文档存在且指向查看入口", /data\/rsi\/watermark\.html/.test(md));
check("JSON 与账本趋势一致", json !== null && json.current.trend === report.current.trend);

// 只读性：本脚本不得 append / 改写账本
const after = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : "";
check("门禁运行前后账本字节不变（只读）", before === after);

line(`\n  水位账本: ${records.length} 轮  trend=${report.current.trend}  可复用经验=${report.experience.reusable}`);
if (records.length === 0) line("  提示：账本为空，运行 npm run evolve:tick -- --rounds 8 启动进化（不阻断发布）");
for (const [label, ok] of checks) line(`  ${ok ? "✓" : "✗"} ${label}`);

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  line(`\n  ✗ 水位门禁失败：${failed.map(([l]) => l).join(" / ")}`);
  process.exitCode = 1;
} else {
  line(`\n  ✓ 水位门禁：${checks.length}/${checks.length} 项通过（唯一尺子、只增账本、只读投影）`);
}
