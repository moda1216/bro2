/**
 * bro2 · 生成 docs/ITERATION-WATERMARK.md（水位看板的文档视图）
 * 与 HTML/JSON 同源，均由 buildWatermark 的只增账本投影生成，不含第二套判定口径。
 */
import type { WatermarkReport } from "../src/rsi/watermark.ts";

export function markdownWatermark(r: WatermarkReport): string {
  const c = r.current;
  const out: string[] = [];
  out.push("# bro2 · 迭代水位");
  out.push("");
  out.push("> 本页由 `npm run evolve:tick` / `npm run watermark` 自动生成，请勿手工编辑。");
  out.push("> 单一事实源是只增账本 `data/rsi/velocity.jsonl` + `data/rsi/experience.jsonl`。");
  out.push("");
  out.push("## 在哪里看");
  out.push("");
  out.push("| 入口 | 用途 |");
  out.push("| --- | --- |");
  out.push("| `data/rsi/watermark.html` | 可视化看板（曲线 + 逐轮表），浏览器直接打开 |");
  out.push("| `npm run watermark` | 终端打印当前水位与逐轮变化（只读，不推进） |");
  out.push("| `data/rsi/watermark.json` | 结构化水位数据，供二次消费 |");
  out.push("| `data/rsi/velocity.jsonl` | 只增速度账本（每一轮一条，永不回写） |");
  out.push("| `data/rsi/experience.jsonl` | 只增经验账本（跨会话复用） |");
  out.push("");
  out.push("## 当前水位");
  out.push("");
  out.push(`- **趋势**：\`${c.trend}\` · 样本 ${c.usableSamples}/${c.samples} · ${c.honesty.reason}`);
  out.push(`- **单位探测改进 IPA**：${c.improvementPerAttempt.toFixed(3)}（前半 ${c.firstHalfIPA.toFixed(3)} → 后半 ${c.secondHalfIPA.toFixed(3)}）`);
  out.push(`- **平均探测数**：${c.avgAttempts.toFixed(3)} · **平均跳过探测**：${c.avgProbesAvoided.toFixed(3)}`);
  out.push(`- **首轮命中率**：${c.firstTryHitRate.toFixed(3)} · **经验复用率**：${c.reuseRate.toFixed(3)}`);
  out.push(`- **累计**：${r.totals.rounds} 轮 / ${r.totals.attempts} 次真实探测 / 跳过 ${r.totals.probesAvoided} 次 / 接受改进 ${r.totals.improvement} 次`);
  out.push(`- **经验库**：${r.experience.events} 事件 / ${r.experience.entries} 条目 / 可复用 ${r.experience.reusable} / 已失效 ${r.experience.invalidated}`);
  out.push(`- **首次判定加速**：${r.firstAcceleratingAt !== null ? `第 ${r.firstAcceleratingAt + 1} 轮` : "尚未达到（样本不足或趋势未成立）"}`);
  out.push("");
  out.push("## 逐轮变化");
  out.push("");
  if (r.points.length === 0) {
    out.push("_账本为空。运行 `npm run evolve:tick -- --rounds 8` 启动进化。_");
  } else {
    out.push("| 轮 | 探测 | 跳过 | 经验命中 | 接受 | 首轮命中 | 回退 | 累计 IPA | 累计均探测 | 截至该轮趋势 |");
    out.push("| ---: | ---: | ---: | ---: | ---: | :---: | :---: | ---: | ---: | --- |");
    for (const p of r.points) {
      out.push(`| ${p.seq + 1} | ${p.attempts} | ${p.probesAvoided} | ${p.experienceHits}`
        + ` | ${p.improvement} | ${p.firstTryHit ? "✓" : "—"} | ${p.usedFallback ? "是" : "否"}`
        + ` | ${p.cumulativeIPA.toFixed(3)} | ${p.cumulativeAttempts.toFixed(2)} | \`${p.trend}\` |`);
    }
  }
  out.push("");
  out.push("## 如何推进水位");
  out.push("");
  out.push("```bash");
  out.push("npm run evolve:tick -- --rounds 8   # 推进 8 轮真实迭代，账本只增、跨会话累积");
  out.push("npm run watermark                   # 只看不改");
  out.push("npm run evolve:tick -- --reset --rounds 8   # 显式清空账本重新起跑");
  out.push("```");
  out.push("");
  out.push("每次运行都会新建 `ExperienceBank` / `VelocityLedger` 实例读取同一账本，");
  out.push("因此「越用越快」不是进程内缓存，而是**跨会话**只增账本上的可复核事实。");
  out.push("");
  out.push("## 诚实边界");
  out.push("");
  out.push(`- 数据来源：${r.honesty.dataSource}。`);
  out.push(`- 证据等级：${r.honesty.evidenceLevel}。`);
  out.push(`- \`leadership.verdict=${r.honesty.verdict}\`、\`L4=${r.honesty.l4}\`，未因水位变化而改动。`);
  out.push(`- frozenMetric=${r.honesty.frozenMetric}、selfReported=${r.honesty.selfReported}。`);
  for (const n of r.honesty.notes) out.push(`- ${n}`);
  out.push("");
  out.push(`_生成时间 ${r.generatedAt} · 看板版本 v${r.version}_`);
  out.push("");
  return out.join("\n");
}
