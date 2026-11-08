# bro2 · 复利中枢（Compound Loop）设计说明

> 把两大设计目标——**「越用改进越快」**与**「越用越省、越用越稳」**——做成可证伪、
> 防 reward hacking、诚实标注边界的工程闭环。v2.1.0 引入，对应 [ROADMAP.md §0](../ROADMAP.md)。

---

## 1. 问题：两大目标缺的是同一个中枢

| 目标 | v2.0.6 之前的机制 | 缺什么 |
| --- | --- | --- |
| 1 · harness 持续自我改进、越用越快 | `Ledger.stats()` 按算子聚合成功率 → 更新搜索先验；`MetaState` 7 个有限枚举 + 6 个固定元候选 | 都是「搜索参数」而非「搜索经验」；每轮从默认态重新搜索（**memoryless**）；从未度量「达到改进花了多少次探测」 |
| 2 · 本地小模型 + 免费免 Key 大模型胜任多数任务、容错高成本低 | `cheapToLocalPolicy` 静态启发式；`KeylessAggregator` 进程内健康态；`InferenceStats` 仪表盘 | 路由不学习实际成败、端点质量重启清零、成本只被观测**从不回控路由** |

结论：需要一个**跨会话、只增、可检索的经验层**，外加把**改进速度**与**单位任务成本**
变成冻结尺子下的一等公民。两个目标共享这套底座与同一组治理红线。

---

## 2. 架构：两条主线 + 一个共享中枢

```
目标 1 · 复利主线
  P1 behavioralContrast ──▶【P2 ExperienceBank】──▶【VelocityLedger】──▶ P3 OOD ──▶ P4 Router
                                  ▲                        ▲
                                  │ 共享：事件式只增账本 / 指纹 / 检索 / 失效
目标 2 · 容错成本主线 ───────────┴────────────────────────┘
  P0.5 双层叠加 ──▶【LearnedRoutePolicy + 端点经验】──▶ P0.5-b 语义缓存 ──▶ P0.5-c 成本入 RSI
```

| 文件 | 职责 | 层 |
| --- | --- | --- |
| `src/rsi/experience.ts` | 经验库：三类指纹、只增事件、折叠快照、检索/重排、OOD 失效 | 共享中枢 |
| `src/rsi/velocity.ts` | 冻结速度尺子：attempts / IPA / firstTryHitRate / 趋势判定 | 目标 1 度量 |
| `src/rsi/compound.ts` | 复利闭环编排：裁剪探测集、回退、经验回写、速度记账 | 目标 1 闭环 |
| `src/models/route-experience.ts` | 学习型路由 + 跨会话端点质量经验 | 目标 2 闭环 |

三者都是**纯 TypeScript、零第三方依赖、可离线单测**。

---

## 3. 关键设计决策

### 3.1 经验只裁剪探测集，绝不改判定

`contrast.ts` 的 `proposeProbeCompose` 是**全量判定**（遍历所有候选、逐个做行为对比）。
因此「有经验后变快」不能靠改变判定结果实现——那会退化成 reward hacking。
复利只能体现在 **Propose 阶段少探测几个候选**：

- 无经验：`effectiveTopK = 全部候选`，老实全探测（冷启动不退化）。
- 有经验：`effectiveTopK = 命中数 + EXPLORE_SLOTS(1)`，只探测经验推荐的 + 1 个探索位。
- 判定逻辑**一字不改**，仍走 `behavioralContrast`；自报 `scoreGain` 依旧不参与。
- 首批无接受项 → **必回退**探测 deferred，绝不因「有经验」就跳过验证。

`EXPLORE_SLOTS=1` 对应 RRSI「鼓励探索未试轨迹」的正则思想，防止经验库过早收敛到局部。

### 3.2 经验回写只由行为判定驱动

`compoundProbe` 对每个**实际探测过**的候选回写：`accepted && !rewardHackingBlocked` 记
`success`，其余记 `failure`。失败项同样留痕（只增账本），避免经验库只记好事而自我确认。
`retrieve()` 只返回未失效且净成功为正的经验；被污染的经验库也无法让伪修复通过判定
（`tests/compound.test.ts` 有专门用例）。

### 3.3 指纹防记忆任务集

| 域 | 指纹构成 | 明确排除 |
| --- | --- | --- |
| `harness-edit` | 失败模式类别 + 量级桶 + 是否调用工具 | 任务 id、答案、`answerMatches` 真值 |
| `routing` | 是否有工具 + 长度桶 + 轮次桶 | 内容文本、**末条角色** |
| `endpoint` | 归一化的上游名 | 请求内容 |

`requestSignature` **刻意不含末条角色**：`cheapToLocalPolicy` 正是用末条角色判断当前回合走
local/remote；若经验指纹也含它，两者视角完全重合，经验永远无法覆盖启发式、学习型路由就没有
增益。去掉后经验站在「这类任务结构本地是否够用」的视角，与「当前回合」视角正交；
是否采信由 `minSamples=3` + `minLocalSuccessRate=0.7` 双重冷启动保护把关。

### 3.4 OOD 失效而非删除

经验带 `applicableTo` 适用条件；出现分布外退化时调用 `invalidate()` 追加失效事件，**不删历史**
（与 Trajectory 一致）。失效后 `retrieve` 为空，探测集自动恢复全量——`compound-demo.ts` 有演练。
这是 P3 OOD 通道的接口预留。

---

## 4. 冻结速度尺子（为什么它和 meta fitness 同源）

`VelocityLedger` 把四个指标变成一等公民：

```
firstTryHitRate        首轮即命中有效编辑的比例
avgAttempts            平均探测次数（应随使用递减）
avgProbesAvoided       平均因经验裁剪跳过的探测数（应随使用递增）
improvementPerAttempt  Σimprovement / Σattempts（应随使用递增）
```

判定 `accelerating` 需**同时**满足：后半 IPA 上升 > 5%、后半探测次数不上升、后半首轮命中率不下降。
硬约束：

1. 尺子定义、`MIN_SAMPLES=6`、`TREND_EPSILON=0.05` 固定在代码中，经验库与 `MetaState` 都改不了
   ——与 `measureMetaFitness` 放在 `PROTECTED_FILES` 写保护面同源，防止「把尺子改松」伪造加速。
2. `improvement` 只数行为对比成立的接受项，**绝不采信自报分数**。
3. 样本不足一律 `insufficient-data`，宁可不下结论也不宣称加速。
4. 出现协议违规的轮次不计入趋势（治理不变量优先于效率叙事）。
5. `honesty.selfReported=false`、`honesty.frozenMetric=true` 随快照输出，附人类可读判据说明。

与 meta RSI 的层级边界见 [META-RSI.md §7.1](../META-RSI.md)：复利层不修改 `MetaState`、
不改动 `measureMetaFitness`、不做晋升；它只把搜索从 memoryless 变成 compounding。

---

## 5. 目标 2：容错经验如何转化为成本优势

`LearnedRoutePolicy` 实现 `RoutePolicy` 接口，**注入** `HybridProvider` 即可，对 `hybrid.ts` 零侵入：

- 冷启动（样本不足 / 成功率不够）→ 回退 `cheapToLocalPolicy`。
- 累积「这类请求本地够用」的实证经验后 → 直接 `local`，把原本启发式要走 remote 的请求压到本地。
- **远程失败 → 本地兜底成功**时，同时记 `remote: failure` 与 `local: success`：
  下次同等结构的请求可直接本地，容错经验直接变成远程调用削减。
- `endpointOutcome()` 把上游成败与延迟桶写入只增账本，**跨会话**保留，
  补充 `KeylessAggregator` 进程内内存态重启清零的短板。

`observe()` 由调用链在 `complete()` 返回后显式调用（本版保持零侵入；接入 runtime 时挂调用后钩子）。

---

## 6. 实证结果（v2.1.0）

`npm run compound:demo`（离线、无网络、无凭据，临时目录，10/10 断言）：

| 目标 | 观测 | 结果 |
| --- | --- | --- |
| 1 | 同一失败模式第 1 轮探测 3 次，第 2 轮起 2 次 | `attempts 3→2`，`probesAvoided=1/轮`，8 轮均找到真修复 |
| 1 | 冻结速度尺子 | `trend=accelerating`，IPA `0.444→0.500`，探测 `2.25→2.00`，`selfReported=false` |
| 1 | OOD 失效演练 | 失效后 `autoPruned=false`、`attempts` 恢复 3 |
| 2 | 8 个请求中 5 个原本走远程 | 学习型路由实际远程调用 **0**，`remoteAvoided=6` |
| 2 | 跨会话 | 新实例仍直接选 `local`；`kilo` 历史 1 成功 / 1 失败完整保留 |

`npm test` **149/149**， `npm run project:status` **11/11 阻断门禁**（新增 `compound`）。

---

## 7. 诚实边界与后续

- 复利在**同一失败模式类内**成立；经验库按精确指纹检索，**不做跨失败模式泛化**。
  跨类泛化属于 P3 OOD 通道 / P4 HarnessRouter，尚未实现。
- `VelocityLedger` 判定的是**搜索成本下降**，不是能力分数提升，更不是「领先」证据。
  `leadership.verdict` 仍为 `not-proven`、L4 仍 `not-achieved`。
- 学习型路由的成本收益在离线确定性轨迹上实证；真实模型下需 `eval:live --provider hybrid` 复测。
- 演示与单测都用临时目录，不写仓库运行时账本。

**下一步（按依赖顺序，不能颠倒）**：

1. P0.5-b 语义 / 近似缓存（扩展命中面）、P0.5-c 把 `remoteAvoided↑ 且分数不降` 正式纳入 evolve 晋升判据。
2. P3 RRSI 正则 + OOD 校验通道：先证明经验库不过拟合，再谈跨签名复用。
3. P4 OO-Harness 类族 / HarnessRouter：把经验检索从「精确指纹」升级为「任务簇 → harness 子类」。
4. 最后才考虑把 `VelocityLedger` 趋势接入 meta fitness 效率维度（须先过 OOD 校验）。

---

## 8. 运行

```bash
npm run compound:demo     # 两大目标离线演示 + 10/10 断言（第 11 道发布门禁）
npm test                  # 含 tests/compound.test.ts 的 18 项回归
npm run project:status    # 11/11 阻断门禁
```
