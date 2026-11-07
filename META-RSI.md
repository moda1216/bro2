# bro2 · meta RSI：改进「改进机制」自身

> 本文说明 bro2 如何在**有界、可验证、防自确认循环**的前提下，让自我改进机制自身也进入迭代闭环。
> 概念与调研背景见 [RSI.md](./RSI.md)，能力面演进见 [EVAL.md](./EVAL.md)，多轮迭代日志见 [ITERATIONS.md](./ITERATIONS.md)。

---

## 1. 为什么需要 meta RSI

上一版 bro2 已实现 L3 自我改进（[RSI.md](./RSI.md)）：从失败轨迹挖信号 → 生成单原子候选 → 影子 train/holdout 双门禁 → 单调晋升。但那个闭环里有一组参数是**写死的**：

- 失败挖掘保留几条证据；
- 候选按什么顺序评估；
- 哪些算子参与搜索；
- 平台期等几代才停；
- 晋升判据有多严；
- 编辑预算是否随平台期调整。

这些参数决定了「找改进有多快、多省」，却从未被改进过。D2I 的 RSI 分级里，只有 `Imp_t → Imp_{t+1}`——**本代实证成败改变了下一代如何改变自身**——才算跨入 L4/L5。bro2 的算子权重漂移只是最弱的一层自指（改变候选排序先验），且没有经过影子评测晋升。

meta RSI 的目标就是：把这组"元参数"也纳入可验证迭代，同时**不让系统碰到自己的尺子**。

---

## 2. 三层分离（最关键的设计）

| 层 | 对象 | 可变？ | 由谁判定 | 落盘 |
| --- | --- | --- | --- | --- |
| **能力面** `EvolvableState` | budget 参数 + 5 个行为策略 + 技能增量 | ✅ RSI 可改 | train + holdout 双严格提升 + 门禁 | `data/evolve/state.json` |
| **改进机制** `MetaState` | 证据窗口 / 排序 / 算子集 / 平台期 / 破平局判据 | ✅ meta RSI 可改 | **冻结 fitness** 单调提升 + 能力不退化 | `data/evolve/meta-state.json` |
| **冻结尺子** `scoring.ts` + `ladder.ts` + `eval.ts` + 任务集 + 治理源码 | fitness 公式、评分、门禁、验证层级 | ❌ 写保护 | 每代 SHA-256 重算，变更即 `integrity_violation` 停机 | `PROTECTED_FILES` |

> **为什么尺子必须冻结**：RSI 文献里最典型的失败是 *objective hacking* —— DGM 曾删掉评估器依赖的 logging 拿满分，STOP 有 0.42% 的生成代码关掉 sandbox flag。如果改进器能改评分公式，所有"提升"都不可信。因此 `measureMetaFitness` 放在 `src/benchmark/scoring.ts`，与被测系统分离，且在 `PROTECTED_FILES` 写保护面内。

**能力面与元面的判据也不同**：能力面看「分数有没有涨」，元面看「单位评测预算拿到多少提升」——后者才对应"改进机制变高效了"。

---

## 3. MetaState：被改进的是什么

`src/rsi/types.ts` 定义 7 个维度，全部是有限枚举或有限范围，由 `parseMeta` 白名单解析（非法值回退默认）：

| 维度 | 取值 | 作用点 |
| --- | --- | --- |
| `evidenceLimit` | 4–24 | `mineFailures` 每类失败的证据窗口；太窄漏策略，太宽引入噪声候选 |
| `policyRule` | true/false | 是否启用「策略失败优先」分类规则 |
| `candidateOrder` | weight / round-robin / evidence-first | `proposePatches` 的候选排序 |
| `operatorSet` | all / lean | 参与搜索的算子集合（lean 裁剪从未命中的算子） |
| `plateauPatience` | 1–4 | 无晋升多少代后停止 |
| `promotionStrictness` | strict / efficiency-tiebreak | 是否允许「train 提升 + holdout 打平 + 步数更少」破平局 |
| `editBudgetAdaptation` | fixed / plateau-expand | 平台期是否临时扩大编辑预算 |

**`lenient` 是被明确禁止的危险值**。元层白名单只允许 `strict` / `efficiency-tiebreak`；后者也没有把 holdout 判据放松成 `>=`，只是在严格打平时用步数破局。`checkMetaPatch` 还会拒绝任何字段名命中 `gate|threshold|task|holdout|train|eval|score|integrity|fitness|ledger|verifier|scoring` 的候选。

---

## 4. 冻结 fitness（尺子怎么量）

`src/benchmark/scoring.ts` → `measureMetaFitness(report)`，输入只有一次 evolve 的**外部可观测产物**：

```
finalHoldout = holdoutCurve.at(-1)
area         = mean(holdoutCurve)              // 曲线下面积，奖励「上升更快」
efficiency   = min(1, area / evalRuns * 20)    // 单位评测预算拿到的提升
score        = 0.6 * finalHoldout + 0.4 * efficiency
```

晋升判据（`metaPromotionOk`）三者同时成立：

1. `candidate.finalHoldout >= base.finalHoldout` —— **能力不退化是硬前提**；
2. `candidate.score > base.score` —— 严格单调；
3. `integrityOk` —— 写保护面本轮未被修改。

**为什么这个公式抗「少干活」**：如果一个元候选让 evolve 立刻停止，`finalHoldout` 会掉到初始值（权重 0.6），且 `area` 也会变小（在 efficiency 分子里）。实测中 `plateauPatience 2→1` 能赢，是因为它只在**收敛之后**少跑两代无效基线评测，没有牺牲任何一代有效提升。

元候选集是有限的 6 个白名单改动，不能注入任意代码，因此操控面本身就很窄；这一边界在第 7 节如实标注。

---

## 5. 防自确认循环的具体措施

| 风险 | 对应措施 |
| --- | --- |
| 改评分公式刷分 | 尺子在 `PROTECTED_FILES`，每代重算 SHA-256，变更即停机 |
| 放松验证层级 | `checkMetaPatch` 白名单 + 禁用字段名 + `lenient` 明确拒绝 |
| 用效率换正确性 | `finalHoldout >= base` 硬门槛，退化一律拒绝 |
| 候选污染真实状态 | 每个元候选在 `scratchDir` 里跑 `dryRun` + `reset` 的短程 evolve，账本/incidents 全部隔离 |
| 多改动无法归因 | 单原子 patch + 每轮最多晋升 1 个 + 只增元账本（含被拒） |
| 振荡 | `proposeMetaCandidates` 不重复提议已生效维度；能力层另有拒绝编辑缓冲 |
| 模型自评参与打分 | fitness 只从 Trajectory 派生的报告曲线计算，无任何 LLM judge / 自评 |

元账本 `data/evolve/meta-ledger.jsonl` 记录 genesis + 全部候选的 `baseline/candidate fitness` 与决策，可完整复核与分叉。

---

## 6. 实证结果

命令：`npm run meta`（`--rounds 3 --generations 6`），报告 `data/meta-report.json`。

| 轮 | 候选 | 晋升 | 拒绝 | 事件 |
| --- | --- | --- | --- | --- |
| 1 | 6 | 1 | 5 | `plateauPatience 2→1`：score **0.8879 → 0.9**，eval **22 → 20**，holdout **1 → 1** |
| 2 | 5 | 0 | 5 | 其余 5 个候选 fitness 均未严格提升，收敛停止 |

- **能力不退化**：finalHoldout 全程 1.0；
- **写保护面**：`integrity.ok = true`，0 文件变更；
- **晋升 1 / 拒绝 10 / 拦截 0**（危险值注入在 `npm run meta:check` 中单独验证，25/25 断言全过）；
- **真实落地**：`meta-state.json` 写入 `plateauPatience=1`，`runEvolve` 默认加载它 —— 下一次 `npm run evolve` 确实少跑 2 次无效基线评测。这就是 `Imp_t → Imp_{t+1}` 的可观测证据，而不只是报告里的数字。

被拒绝的 5 个候选（收窄证据窗口、换排序、裁剪算子、平台期扩预算、破平局判据）在本任务域内都没有带来净收益，被如实记入账本而非悄悄丢弃。

---

## 7. 明确不做的事与已知局限

- **不是 L5**：不自动改核心源码、不重训模型权重、不做无监督开放式递归。元改动只落在 7 个有限枚举上。
- **fitness 不是真理**：`area = mean(curve)` 对不同长度的曲线并非严格同尺度，`efficiency` 里的常数 `20` 是量纲归一，权重 0.6/0.4 是设计选择而非推导结果。它们都固定在写保护面内、可被人工复核，但换任务域应重新校准。
- **候选集有限**：只有 6 个预设元改动，不存在"搜索任意改进机制"的能力；这是有界 RSI 的自觉约束。
- **单域结论**：效率提升只在该自建确定性评测域成立。沙箱无真实模型，未验证 meta 改进在真实模型下是否同样有效。
- **元层不替代能力层**：`MetaState` 改变的是"怎么找改进"，不改变 agent 的能力面；两者共用同一套影子评测基础设施，但账本、报告、晋升链完全独立。

---

## 8. 运行

```bash
npm run meta            # 正式 3 轮元迭代，写 meta-state / meta-report / 元账本
npm run meta:dry        # 只诊断不写回
npm run meta:check      # 25 项断言：危险值拦截、冻结 fitness、单调晋升、正式报告
npm run evolve          # 会自动加载已晋升的 meta-state
npm test                # 含 tests/meta.test.ts 的纯函数回归
```

复现路径：`meta` → `evolve` → `benchmark` → 读 `data/meta-report.json` 与 `data/evolve/meta-ledger.jsonl`。
