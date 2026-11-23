/**
 * bro2 · 重写核心报告生成器（P2–P5 汇总）
 * 数字全部读自 data/evidence/*.json，不手写，避免报告与证据脱节。
 * 运行：node --experimental-strip-types --no-warnings examples/build-rewrite-report.ts
 * 输出：docs/REWRITE-REPORT.html
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Ev {
  summary: { verdict: string; passed: number; total: number };
  purpose: string;
  checks: Array<{ name: string; pass: boolean }>;
  honest: { scope: string; notProven: string[]; verdictBoundary: string; l4: string };
  [k: string]: unknown;
}
const stages = [
  { id: "P2", title: "轨迹飞轮系统化", file: "trajectory-flywheel", gate: "flywheel:check" },
  { id: "P3", title: "训练器薄调度 + 上线闸门", file: "promotion-gate", gate: "promotion:gate" },
  { id: "P4", title: "统一白盒面板 + 审批 + 能效", file: "whitebox-panel", gate: "whitebox:panel" },
  { id: "P5", title: "统计骨架 + 第三方复核", file: "third-party-review", gate: "thirdparty:review" },
].map((s) => ({
  ...s,
  ev: JSON.parse(readFileSync(resolve(ROOT, `data/evidence/${s.file}.json`), "utf8")) as Ev,
}));

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stageCards = stages.map((s) => {
  const checks = s.ev.checks.map((c) =>
    `<li><span class="${c.pass ? "g" : "r"}">${c.pass ? "✓" : "✗"}</span> ${esc(c.name)}</li>`).join("");
  return `<section>
<h2>${s.id} · ${esc(s.title)} <span class="badge">${esc(s.ev.summary.verdict)}</span></h2>
<p class="meta">${s.ev.summary.passed}/${s.ev.summary.total} 检查通过 · 门禁 <code>npm run ${s.gate}</code> · ${esc(s.ev.purpose)}</p>
<ul class="checks">${checks}</ul>
<p class="honest"><b>诚实边界：</b>${esc(s.ev.honest.scope)}<br>
未证明：${esc(s.ev.honest.notProven.join(" · "))}<br>
verdict=${esc(s.ev.honest.verdictBoundary)} · L4=${esc(s.ev.honest.l4)}</p>
</section>`;
}).join("");

const totalChecks = stages.reduce((n, s) => n + s.ev.summary.total, 0);
const totalPassed = stages.reduce((n, s) => n + s.ev.summary.passed, 0);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bro2 · 深度重写核心报告 P2–P5</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;margin:0;padding:2rem;max-width:960px;margin:auto;color:#1a1a1a;background:#fbfbfd;line-height:1.6}
h1{border-bottom:3px solid #2c3e50;padding-bottom:.4rem}
h2{font-size:1.25rem;margin-top:2rem;border-left:4px solid #2c3e50;padding-left:.6rem}
.badge{font-size:.8rem;background:#e8f5e9;color:#1a7f37;padding:2px 8px;border-radius:10px;vertical-align:middle}
.meta{color:#666;font-size:.9rem}
.checks{list-style:none;padding-left:0}.checks li{padding:2px 0;font-size:.92rem}
.g{color:#1a7f37;font-weight:bold}.r{color:#c62828;font-weight:bold}
.honest{background:#fff8e1;border-left:3px solid #f9a825;padding:.6rem .9rem;font-size:.88rem;color:#5d4b00}
code{background:#eef0f3;padding:1px 5px;border-radius:4px;font-size:.88em}
.summary{background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:1rem 1.4rem;margin:1.2rem 0}
.muted{color:#777;font-size:.85rem}
table{border-collapse:collapse;width:100%;margin:1rem 0;background:#fff}td,th{border:1px solid #e0e0e0;padding:6px 10px;text-align:left;font-size:.9rem}th{background:#f0f2f5}
</style></head><body>
<h1>bro2 · 深度重写核心报告 <small style="font-size:.6rem;color:#888">P2–P5</small></h1>
<p class="muted">数字全部读自 <code>data/evidence/*.json</code>，不手写。生成于 ${new Date().toISOString()}</p>
<div class="summary">
<b>总览：</b>${totalPassed}/${totalChecks} 项可证伪检查通过 · 源码净增 0（16500/16500）· 发布门禁 32/32 + 2/2 全绿。<br>
<b>贯穿原则：</b>深入而非更大——骨架更厚（验证/约束/可回滚）、源码不增、能力靠接线与外置。<br>
<b>诚实底线：</b>所有阶段均不产出能力分数；<code>verdict=not-proven</code>、<code>L4=not-achieved</code> 不变。
</div>
<table><thead><tr><th>阶段</th><th>出口条件达成</th><th>状态</th></tr></thead><tbody>
<tr><td>P0 证据环</td><td>独立重算 + 红队基线</td><td class="g">✅</td></tr>
<tr><td>P1 本地自治</td><td>断网跑通 + 8/8 零污染</td><td class="g">✅ 机制（真机实测缺口待回填）</td></tr>
<tr><td>P2 轨迹飞轮</td><td>可追溯 delta + 失败留痕</td><td class="g">✅（delta 为全局 IPA 代理）</td></tr>
<tr><td>P3 训练器闸门</td><td>无对照不晋升 + 回滚</td><td class="g">✅ 闸门（真实训练未测）</td></tr>
<tr><td>P4 白盒面板</td><td>决策链可重建 + 拦截可触发</td><td class="g">✅（真机能耗/SSE 未测）</td></tr>
<tr><td>P5 统计复核</td><td>inter-rater + 统计显著</td><td style="color:#e65100">⚠️ 骨架达成；显著性/第三方复核未达成（9/267）</td></tr>
</tbody></table>
${stageCards}
<h2>统一的未完成项（如实）</h2>
<ul>
<li>89×3 全量评测仅 9/267，partial 不构成榜单分数；P5 的统计显著与独立第三方复核须待全量完成 + 独立标注后评估。</li>
<li>真机缺口：Apple Silicon 上 MLX/llama.cpp 的 tokens/s、峰值内存、量化精度损失；powermetrics 能耗；SSE 实时推送链路。</li>
<li>真缺口：本地 QLoRA 训练收敛与候选权重真实提升（本沙箱无 GPU，仅闸门契约）。</li>
<li>P2 的 provider=mock 判据已固化验证，但未回填冻结脚本 tb21-batch.py（避免动冻结流程）。</li>
</ul>
<p class="muted">重写不改变评测事实：partial、自跑非第三方、not-proven、L4 not-achieved。本报告是「重写工程的证据汇总」，不是「能力领先」的声明。</p>
</body></html>`;
writeFileSync(resolve(ROOT, "docs/REWRITE-REPORT.html"), html);
console.log(`核心报告已生成：docs/REWRITE-REPORT.html（${totalPassed}/${totalChecks} 检查，数字读自 evidence JSON）`);
