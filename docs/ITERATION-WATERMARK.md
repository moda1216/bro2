# bro2 · 迭代水位

> 本页由 `npm run evolve:tick` / `npm run watermark` 自动生成，请勿手工编辑。
> 单一事实源是只增账本 `data/rsi/velocity.jsonl` + `data/rsi/experience.jsonl`。

## 在哪里看

| 入口 | 用途 |
| --- | --- |
| `data/rsi/watermark.html` | 可视化看板（曲线 + 逐轮表），浏览器直接打开 |
| `npm run watermark` | 终端打印当前水位与逐轮变化（只读，不推进） |
| `data/rsi/watermark.json` | 结构化水位数据，供二次消费 |
| `data/rsi/velocity.jsonl` | 只增速度账本（每一轮一条，永不回写） |
| `data/rsi/experience.jsonl` | 只增经验账本（跨会话复用） |

## 当前水位

- **趋势**：`accelerating` · 样本 8/8 · 样本 8（前半 4 / 后半 4）；IPA 0.444→0.500，探测 2.25→2.00，首轮命中 1.00→1.00；协议违规 0 轮已排除
- **单位探测改进 IPA**：0.471（前半 0.444 → 后半 0.500）
- **平均探测数**：2.125 · **平均跳过探测**：0.875
- **首轮命中率**：1.000 · **经验复用率**：0.875
- **累计**：8 轮 / 17 次真实探测 / 跳过 7 次 / 接受改进 8 次
- **经验库**：17 事件 / 3 条目 / 可复用 1 / 已失效 0
- **首次判定加速**：第 6 轮

## 逐轮变化

| 轮 | 探测 | 跳过 | 经验命中 | 接受 | 首轮命中 | 回退 | 累计 IPA | 累计均探测 | 截至该轮趋势 |
| ---: | ---: | ---: | ---: | ---: | :---: | :---: | ---: | ---: | --- |
| 1 | 3 | 0 | 0 | 1 | ✓ | 否 | 0.333 | 3.00 | `insufficient-data` |
| 2 | 2 | 1 | 1 | 1 | ✓ | 否 | 0.400 | 2.50 | `insufficient-data` |
| 3 | 2 | 1 | 1 | 1 | ✓ | 否 | 0.429 | 2.33 | `insufficient-data` |
| 4 | 2 | 1 | 1 | 1 | ✓ | 否 | 0.444 | 2.25 | `insufficient-data` |
| 5 | 2 | 1 | 1 | 1 | ✓ | 否 | 0.455 | 2.20 | `insufficient-data` |
| 6 | 2 | 1 | 1 | 1 | ✓ | 否 | 0.462 | 2.17 | `accelerating` |
| 7 | 2 | 1 | 1 | 1 | ✓ | 否 | 0.467 | 2.14 | `accelerating` |
| 8 | 2 | 1 | 1 | 1 | ✓ | 否 | 0.471 | 2.13 | `accelerating` |

## 如何推进水位

```bash
npm run evolve:tick -- --rounds 8   # 推进 8 轮真实迭代，账本只增、跨会话累积
npm run watermark                   # 只看不改
npm run evolve:tick -- --reset --rounds 8   # 显式清空账本重新起跑
```

每次运行都会新建 `ExperienceBank` / `VelocityLedger` 实例读取同一账本，
因此「越用越快」不是进程内缓存，而是**跨会话**只增账本上的可复核事实。

## 诚实边界

- 数据来源：runEval 真实评测轨迹（deterministic 模型脚本 + 真实 harness 策略分支），逐轮写入只增账本。
- 证据等级：行为对比轨迹；不是模型能力分数，也不构成业界水平结论。
- `leadership.verdict=not-proven`、`L4=not-achieved`，未因水位变化而改动。
- frozenMetric=true、selfReported=false。
- 趋势判定只使用唯一冻结尺子 velocitySnapshotFrom；看板只做前缀投影，不实现第二套口径。
- improvement 只数行为对比成立的接受项，候选自报 scoreGain 全程不参与判定。
- 可用样本 < 6 一律 insufficient-data；出现协议违规的轮次不计入趋势。
- 经验只裁剪 Propose 的探测集，接受判定仍走全量行为对比；经验不灵会回退并留痕。
- 跨失败模式泛化（P3 OOD）/ 异步按需探测（P4）尚未实现，复利结论仅限同类失败模式。

_生成时间 2026-11-08T04:54:34.422Z · 看板版本 v2.2.0_
