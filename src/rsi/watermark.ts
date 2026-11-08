/**
 * bro2 · 迭代水位看板（v2.2.0）
 *
 * 回答一个此前没有答案的问题：「我哪里可以看到 bro2 的迭代水位变化？」
 * v2.1.0 只有冻结尺子（VelocityLedger）和临时目录里的演示——演示跑完即删，
 * 真实账本 0 条记录，因此「有尺子、没刻度」。本模块补上**只读投影层**：
 *
 *   1) 对只增账本做「逐轮前缀投影」：截至第 N 轮，冻结尺子会怎么判定？
 *      于是水位不再是单点数字，而是一条随时间变化的曲线。
 *   2) 判定口径完全委托 `velocitySnapshotFrom`——本模块**不实现任何趋势逻辑**，
 *      只负责把历史切成前缀再交给同一把尺子，杜绝出现第二套尺子。
 *   3) 输出结构化报告 + 人类可读表格 + 可直接在浏览器打开的 HTML 看板。
 *
 * 治理红线：本模块只读，绝不 append / 改写账本，不改 verdict，不采信自报分数。
 * 「看到水位」与「推进水位」是两件事：推进由 bin/evolve-loop.ts 负责。
 */
import { velocitySnapshotFrom } from "./velocity.ts";
import type { VelocityLedger, AttemptRecord, VelocitySnapshot, VelocityTrend } from "./velocity.ts";
import type { ExperienceBank, ExperienceStats } from "./experience.ts";

export const WATERMARK_VERSION = "2.2.0";

export interface WatermarkPoint {
  seq: number;
  ts: string;
  attempts: number;
  probesAvoided: number;
  experienceHits: number;
  improvement: number;
  firstTryHit: boolean;
  usedFallback: boolean;
  protocolViolations: number;
  /** 截至本轮（前缀）的冻结尺子判定。 */
  trend: VelocityTrend;
  /** 截至本轮的单位探测改进量（Σimprovement / Σattempts）。 */
  cumulativeIPA: number;
  /** 截至本轮的平均探测数。 */
  cumulativeAttempts: number;
  /** 截至本轮的首轮命中率。 */
  cumulativeHitRate: number;
  /** 截至本轮累计跳过探测数。 */
  cumulativeProbesAvoided: number;
  usableSamples: number;
}

export interface WatermarkTotals {
  rounds: number;
  attempts: number;
  probesAvoided: number;
  improvement: number;
  firstTryHits: number;
  protocolViolations: number;
}

export interface WatermarkReport {
  generatedAt: string;
  version: string;
  ledgerPath: string;
  experiencePath: string;
  points: WatermarkPoint[];
  current: VelocitySnapshot;
  experience: ExperienceStats;
  totals: WatermarkTotals;
  /** 第一次被冻结尺子判定为 accelerating 的轮次；null 表示尚未达到。 */
  firstAcceleratingAt: number | null;
  honesty: {
    frozenMetric: true;
    selfReported: false;
    dataSource: string;
    evidenceLevel: string;
    verdict: "not-proven";
    l4: "not-achieved";
    notes: string[];
  };
}

const prefixIPA = (rows: readonly AttemptRecord[]): number => {
  const a = rows.reduce((s, r) => s + r.attempts, 0);
  return a === 0 ? 0 : rows.reduce((s, r) => s + r.improvement, 0) / a;
};

/** 从两个只增账本构造水位报告。纯读，无副作用。 */
export function buildWatermark(ledger: VelocityLedger, bank: ExperienceBank): WatermarkReport {
  const records = ledger.records();
  const points: WatermarkPoint[] = records.map((r, i) => {
    const prefix = records.slice(0, i + 1);
    const snap = velocitySnapshotFrom(prefix);
    return {
      seq: r.seq,
      ts: r.ts,
      attempts: r.attempts,
      probesAvoided: r.probesAvoided,
      experienceHits: r.experienceHits,
      improvement: r.improvement,
      firstTryHit: r.firstTryHit,
      usedFallback: r.usedFallback,
      protocolViolations: r.protocolViolations,
      trend: snap.trend,
      cumulativeIPA: snap.improvementPerAttempt,
      cumulativeAttempts: snap.avgAttempts,
      cumulativeHitRate: snap.firstTryHitRate,
      cumulativeProbesAvoided: prefix.reduce((s, x) => s + x.probesAvoided, 0),
      usableSamples: snap.usableSamples,
    };
  });

  const totals: WatermarkTotals = {
    rounds: records.length,
    attempts: records.reduce((s, r) => s + r.attempts, 0),
    probesAvoided: records.reduce((s, r) => s + r.probesAvoided, 0),
    improvement: records.reduce((s, r) => s + r.improvement, 0),
    firstTryHits: records.filter((r) => r.firstTryHit).length,
    protocolViolations: records.reduce((s, r) => s + r.protocolViolations, 0),
  };

  const current = ledger.snapshot();
  // 一致性自检：最后一点必须等于整本账本的快照（同一把尺子、同一份数据）
  const last = points[points.length - 1];
  if (last && last.trend !== current.trend) {
    throw new Error("水位投影与冻结尺子不一致：拒绝输出可能被篡改的报告");
  }

  return {
    generatedAt: new Date().toISOString(),
    version: WATERMARK_VERSION,
    ledgerPath: ledger.path,
    experiencePath: bank.path,
    points,
    current,
    experience: bank.stats(),
    totals,
    firstAcceleratingAt: points.find((p) => p.trend === "accelerating")?.seq ?? null,
    honesty: {
      frozenMetric: true,
      selfReported: false,
      dataSource: "runEval 真实评测轨迹（deterministic 模型脚本 + 真实 harness 策略分支），逐轮写入只增账本",
      evidenceLevel: "行为对比轨迹；不是模型能力分数，也不构成业界水平结论",
      verdict: "not-proven",
      l4: "not-achieved",
      notes: [
        "趋势判定只使用唯一冻结尺子 velocitySnapshotFrom；看板只做前缀投影，不实现第二套口径。",
        "improvement 只数行为对比成立的接受项，候选自报 scoreGain 全程不参与判定。",
        "可用样本 < 6 一律 insufficient-data；出现协议违规的轮次不计入趋势。",
        "经验只裁剪 Propose 的探测集，接受判定仍走全量行为对比；经验不灵会回退并留痕。",
        "跨失败模式泛化（P3 OOD）/ 异步按需探测（P4）尚未实现，复利结论仅限同类失败模式。",
      ],
    },
  };
}

const pad = (s: string, n: number): string => s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);

/** CLI 文本视图：npm run watermark。 */
export function formatWatermark(report: WatermarkReport): string {
  const out: string[] = [];
  out.push("");
  out.push("════════════════════════════════════════════════════════════════════════");
  out.push("  bro2 · 迭代水位 (npm run watermark)");
  out.push("════════════════════════════════════════════════════════════════════════");
  out.push(`  生成时间 ${report.generatedAt}   账本 ${report.ledgerPath}`);
  out.push(`  累计轮次 ${report.totals.rounds}   真实探测 ${report.totals.attempts}   跳过探测 ${report.totals.probesAvoided}`
    + `   接受改进 ${report.totals.improvement}   协议违规 ${report.totals.protocolViolations}`);
  out.push(`  经验库 ${report.experience.events} 事件 / ${report.experience.entries} 快照 / 可复用 ${report.experience.reusable}`);
  const c = report.current;
  out.push("");
  out.push(`  当前水位  trend=${c.trend}   样本 ${c.usableSamples}/${c.samples}   frozenMetric=${c.honesty.frozenMetric}  selfReported=${c.honesty.selfReported}`);
  out.push(`    firstTryHitRate=${c.firstTryHitRate.toFixed(3)}  avgAttempts=${c.avgAttempts.toFixed(3)}`
    + `  avgProbesAvoided=${c.avgProbesAvoided.toFixed(3)}  IPA=${c.improvementPerAttempt.toFixed(3)}`);
  out.push(`    前半 IPA ${c.firstHalfIPA.toFixed(3)} → 后半 IPA ${c.secondHalfIPA.toFixed(3)}`);
  out.push(`    ${c.honesty.reason}`);
  if (report.firstAcceleratingAt !== null) {
    out.push(`  首次判定 accelerating：第 ${report.firstAcceleratingAt + 1} 轮`);
  }
  out.push("");
  if (report.points.length === 0) {
    out.push("  （账本为空：尚未启动进化。运行 npm run evolve:tick -- --rounds 8 开始累积水位）");
  } else {
    out.push("  " + pad("轮", 4) + pad("探测", 7) + pad("跳过", 7) + pad("命中", 7)
      + pad("接受", 7) + pad("回退", 7) + pad("累计IPA", 11) + pad("累计均探测", 13) + "截至该轮趋势");
    out.push("  " + "-".repeat(88));
    for (const p of report.points) {
      out.push("  " + pad(String(p.seq + 1), 4) + pad(String(p.attempts), 7)
        + pad(String(p.probesAvoided), 7) + pad(String(p.experienceHits), 7)
        + pad(String(p.improvement), 7) + pad(p.usedFallback ? "是" : "否", 7)
        + pad(p.cumulativeIPA.toFixed(3), 11) + pad(p.cumulativeAttempts.toFixed(3), 13) + p.trend);
    }
  }
  out.push("");
  out.push("  诚实边界：" + report.honesty.evidenceLevel + `；leadership.verdict=${report.honesty.verdict}、L4=${report.honesty.l4}。`);
  out.push("  查看可视化：data/rsi/watermark.html（npm run evolve:tick 或 npm run watermark 自动刷新）");
  out.push("════════════════════════════════════════════════════════════════════════\n");
  return out.join("\n");
}

// ---------------------------------------------------------------- HTML 看板

const esc = (s: string): string => s
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 生成一张独立量纲的 SVG 折线图（纯服务端渲染，无脚本依赖）。 */
function sparkline(
  points: readonly WatermarkPoint[],
  valueOf: (p: WatermarkPoint) => number,
  color: string,
  label: string,
  unit: string,
): string {
  const W = 540, H = 150, PL = 44, PR = 16, PT = 18, PB = 28;
  if (points.length === 0) return `<div class="empty">尚无数据</div>`;
  const vals = points.map(valueOf);
  const max = Math.max(...vals, 1e-9);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = (i: number): number => PL + (points.length === 1 ? 0 : (i / (points.length - 1)) * (W - PL - PR));
  const y = (v: number): number => PT + (1 - (v - min) / span) * (H - PT - PB);
  const path = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = vals.map((v, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${color}"><title>第 ${i + 1} 轮: ${v.toFixed(3)}${unit}</title></circle>`).join("");
  const grid = [0, 0.5, 1].map((f) => {
    const gy = PT + f * (H - PT - PB);
    const gv = max - f * span;
    return `<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${W - PR}" y2="${gy.toFixed(1)}" stroke="var(--grid)" stroke-dasharray="3 4"/>`
      + `<text x="${PL - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="axis">${gv.toFixed(2)}</text>`;
  }).join("");
  const xlabels = points.map((p, i) =>
    (points.length <= 12 || i % Math.ceil(points.length / 12) === 0 || i === points.length - 1)
      ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis">${p.seq + 1}</text>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}">
    ${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}${xlabels}
    <text x="${PL}" y="12" class="axis">${esc(label)}</text>
  </svg>`;
}

const TREND_STYLE: Record<VelocityTrend, [string, string]> = {
  accelerating: ["#c0392b", "加速中（冻结尺子判定）"],
  flat: ["#7f8c8d", "持平"],
  decelerating: ["#d35400", "减速"],
  "insufficient-data": ["#2c6fbb", "样本不足，禁止宣称趋势"],
};

/** 渲染可直接打开的 HTML 看板。 */
export function renderWatermarkHtml(report: WatermarkReport): string {
  const [trendColor, trendText] = TREND_STYLE[report.current.trend];
  const c = report.current;
  const rows = report.points.map((p) => `<tr>
    <td>${p.seq + 1}</td><td>${p.attempts}</td><td>${p.probesAvoided}</td>
    <td>${p.experienceHits}</td><td>${p.improvement}</td>
    <td>${p.firstTryHit ? "✓" : "—"}</td><td>${p.usedFallback ? "是" : "否"}</td>
    <td>${p.cumulativeIPA.toFixed(3)}</td><td>${p.cumulativeAttempts.toFixed(2)}</td>
    <td><span class="tag" style="--tag:${TREND_STYLE[p.trend][0]}">${esc(p.trend)}</span></td>
  </tr>`).join("");
  const notes = report.honesty.notes.map((n) => `<li>${esc(n)}</li>`).join("");
  const first = report.firstAcceleratingAt !== null
    ? `第 ${report.firstAcceleratingAt + 1} 轮起被冻结尺子判定为 accelerating`
    : "尚未达到加速判定（样本不足或趋势未成立）";

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bro2 · 迭代水位看板</title>
<style>
  :root { --bg:#f7f8fa; --card:#fff; --fg:#1f2430; --muted:#6b7280; --grid:#e3e7ee; --line:#e8ebf0; --accent:#2c6fbb; --good:#c0392b; }
  @media (prefers-color-scheme:dark){:root{--bg:#141820;--card:#1d222c;--fg:#e8ecf3;--muted:#98a2b3;--grid:#333b49;--line:#2c3442;--accent:#6fa8e8;--good:#ff7b72}}
  *{box-sizing:border-box}
  body{margin:0;padding:28px;background:var(--bg);color:var(--fg);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1160px;margin:0 auto}
  h1{font-size:24px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 22px;font-size:13px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card .k{color:var(--muted);font-size:12px} .card .v{font-size:24px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}
  .card .d{color:var(--muted);font-size:11px;margin-top:2px}
  .banner{background:var(--card);border:1px solid var(--line);border-left:4px solid ${trendColor};border-radius:10px;padding:14px 18px;margin-bottom:20px}
  .banner b{color:${trendColor}} .banner .reason{color:var(--muted);font-size:12px;margin-top:6px;font-variant-numeric:tabular-nums}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;margin-bottom:20px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px 6px}
  .panel h2{font-size:14px;margin:0 0 6px;color:var(--muted);font-weight:600}
  .axis{font-size:10px;fill:var(--muted)}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-variant-numeric:tabular-nums}
  th,td{padding:9px 10px;text-align:right;border-bottom:1px solid var(--line);font-size:12px}
  th:first-child,td:first-child{text-align:left} th{color:var(--muted);font-weight:600;background:var(--bg)}
  tr:last-child td{border-bottom:none}
  .tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;color:var(--tag);border:1px solid var(--tag)}
  .honesty{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 20px;margin-top:20px}
  .honesty h2{font-size:15px;margin:0 0 8px} .honesty ul{margin:6px 0 0;padding-left:20px;color:var(--muted);font-size:12px}
  .empty{color:var(--muted);padding:40px;text-align:center}
  code{background:var(--bg);padding:1px 5px;border-radius:4px;font-size:12px}
  footer{color:var(--muted);font-size:11px;margin-top:18px;text-align:center}
</style></head><body><div class="wrap">
  <h1>bro2 · 迭代水位看板</h1>
  <p class="sub">只增账本 <code>data/rsi/velocity.jsonl</code> · 冻结尺子 <code>velocitySnapshotFrom</code> · 生成 ${esc(report.generatedAt)} · v${esc(report.version)}</p>

  <div class="cards">
    <div class="card"><div class="k">累计迭代轮次</div><div class="v">${report.totals.rounds}</div><div class="d">每次 evolve:tick 追加</div></div>
    <div class="card"><div class="k">真实探测次数</div><div class="v">${report.totals.attempts}</div><div class="d">行为对比判定成本</div></div>
    <div class="card"><div class="k">经验跳过探测</div><div class="v">${report.totals.probesAvoided}</div><div class="d">复利省下的搜索</div></div>
    <div class="card"><div class="k">单位探测改进 IPA</div><div class="v">${c.improvementPerAttempt.toFixed(3)}</div><div class="d">前半 ${c.firstHalfIPA.toFixed(3)} → 后半 ${c.secondHalfIPA.toFixed(3)}</div></div>
    <div class="card"><div class="k">平均探测数</div><div class="v">${c.avgAttempts.toFixed(2)}</div><div class="d">越低越快</div></div>
    <div class="card"><div class="k">可复用经验</div><div class="v">${report.experience.reusable}</div><div class="d">${report.experience.events} 事件 / ${report.experience.entries} 条目</div></div>
  </div>

  <div class="banner">
    <div><b>当前趋势：${esc(trendText)}</b>　<code>trend=${esc(c.trend)}</code>　样本 ${c.usableSamples}/${c.samples}　${esc(first)}</div>
    <div class="reason">${esc(c.honesty.reason)}　·　frozenMetric=${c.honesty.frozenMetric}　selfReported=${c.honesty.selfReported}</div>
  </div>

  <div class="grid">
    <div class="panel"><h2>每轮探测数（应随使用下降）</h2>${sparkline(report.points, (p) => p.attempts, "#2c6fbb", "attempts / 轮", "")}</div>
    <div class="panel"><h2>累计单位探测改进 IPA（应随使用上升）</h2>${sparkline(report.points, (p) => p.cumulativeIPA, "#c0392b", "Σimprovement / Σattempts", "")}</div>
    <div class="panel"><h2>累计跳过探测数（应随使用上升）</h2>${sparkline(report.points, (p) => p.cumulativeProbesAvoided, "#27865a", "probes avoided", "")}</div>
    <div class="panel"><h2>截至每轮的冻结尺子判定</h2>${sparkline(report.points, (p) => p.cumulativeAttempts, "#8e6bbf", "累计平均探测数", "")}</div>
  </div>

  <table><thead><tr><th>轮</th><th>探测</th><th>跳过</th><th>经验命中</th><th>接受</th><th>首轮命中</th><th>回退</th><th>累计 IPA</th><th>累计均探测</th><th>截至该轮趋势</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="10" style="text-align:center;color:var(--muted)">账本为空，运行 <code>npm run evolve:tick -- --rounds 8</code> 启动进化</td></tr>`}</tbody></table>

  <div class="honesty"><h2>诚实边界（看板不得越过）</h2>
    <p style="margin:0;color:var(--muted);font-size:12px">数据来源：${esc(report.honesty.dataSource)}。证据等级：${esc(report.honesty.evidenceLevel)}。<code>leadership.verdict=${report.honesty.verdict}</code>、<code>L4=${report.honesty.l4}</code>。</p>
    <ul>${notes}</ul>
  </div>
  <footer>推进水位：<code>npm run evolve:tick -- --rounds N</code>　·　只看不改：<code>npm run watermark</code>　·　账本为只增事件，不回写历史</footer>
</div></body></html>`;
}
