# bro2 · 从「测量发现」到「harness 改进」：预算软预警可证伪实验（v2.31.0）

> **性质**：用 v2.30.0 已取得的外部真值（Terminal-Bench 公开任务 + 公开 pytest 评分器）驱动一次**任务无关、不加预算、预注册判据**的 harness 改进实验。
> **红线**：自跑 / 非第三方复核 / 小样本 / 同集前后对照属弱证据 / **未写 `data/benchmark/external-results.json`** / **不改 L4 与 `leadership.verdict`**。
> 配套产物：`examples/traj-diag.ts`（逐轨迹诊断）、`data/bench/external/budget-advisory-report.json`（A/B 报告）、`tests/budget-advisory.test.ts`（机制契约）。

---

## 0. 一句话

用户问「先不管第二端点，用已有的信息可以优化 bro2 了吗」。答案是**可以，但前提是先承认 v2.30.0 的读数是噪声、其轨迹结论是错的**：逐轨迹诊断把「失败题为什么失败」从「空转不肯停」修正为「**累计 token 静默熔断发生在产出文件落地之前**」与「**模型约束求解不全**」两件完全不同的事。前者是 harness 层可修的机制缺口，后者属模型能力、不该靠 harness 硬凑。本轮只做前者，并用严格 A/B 判定它是否真的成立——**无论结果正负都如实发布**。

---

## 1. 诊断：逐轨迹证据（推翻聚合推测）

v2.30.0 报告（`tb-leaderboard-compare-kilo.json`）只有聚合指标：通过题 9/5 次工具调用、失败题 14/11 次。`TRAJECTORY-ANALYSIS.md` §4 据此读出「失败题工具调用更多 → 对解不出的题不会优雅停手 → 缺验证—停手闭环」。这个推断**方向是错的**，因为它没看 verifier 报了什么、也没看逐步轨迹。

用 `examples/traj-diag.ts` 重跑两道失败题（同一 kilo 端点、同一任务、同一输入），拿到逐事件证据：

| 任务 | v2.30.0 读数 | 诊断复跑 | 真实机理 |
| --- | --- | --- | --- |
| `tb-bank-trans-filter` | 7 步 / 14 工具 / **9 工具错误** / guard | 6 步 / 8 工具 / **0 工具错误** / `guard(kind=tokens)` | 模型已正确读 CSV、检索、列计划，正准备写 `data/output.json`，被 **`超过 token 预算 60000`** 静默熔断；轨迹中工具调用全部成功 |
| `tb-assign-seats` | 12 步 / 11 工具 / guard（报 `results.txt` 不存在） | 5 步 / 10 工具 / **`completed`**、真写了 `results.txt` | 写了 4 行邻居对，公开 verifier 只要 2 行（`alice, bob` / `alice, ethan`）——**模型约束求解不全，答案错** |

逐轨迹日志（已固化进仓库作可复现证据）：`data/bench/external/traj-diag-bank-trans-filter.out`、`data/bench/external/traj-diag-assign-seats.out`；A/B 原始日志 `budget-advisory-ablation.out`。

进一步量化 token 去向（`examples` 侧估算）：`standard` preset 的 system prompt 仅 **177 token**、30 个工具 schema **2519 token**；每步固定成本不高，**烧掉累计预算的是不断累积的历史工具结果**。而压缩阈值 `compactTokens = maxTokens × 0.6 = 36000` 用**本地估算**口径，硬熔断 `maxTokens = 60000` 用 **API 真实累计**口径，两者不同步——诊断轨迹里 `[compaction]` 事件**一次都没出现**，压缩在这批任务上完全没生效，步数预算 `maxSteps=12` 因此形同虚设。

### 1.1 一个决定性观察

A/B 实验第一条基线运行：`tb-analyze-access-logs` **撞了 `guard(tokens)` 却依然 verifier PASS**（`file=1`，产出文件已落地）。所以：

> **熔断本身不致命；致命的是熔断发生的那一刻，任务要求的产出文件还没写。**

这把「优化」从「让模型更聪明」精确收敛为「**在硬熔断前给一次落盘收尾的机会**」——这是 harness 层、任务无关、且不需要增加任何预算的改动。

---

## 2. 对 v2.30.0 结论的修正（只增，不抹历史）

| v2.30.0 `TRAJECTORY-ANALYSIS.md` §4 的说法 | v2.31.0 逐轨迹结论 |
| --- | --- |
| 失败题工具调用数高于通过题 → 「不优雅停手、空转到预算上限」 | 14 次工具调用来自**每步并行 2 个工具**（7 步），不是空转更多轮；真正停因是 `tokens` 熔断 |
| 「无验证—停手闭环的证据」、「缺把 verifier 信号接回决策」 | 框架里 bro2 **本来就看不到**公开 pytest verifier（判分在 Docker 事后执行），「verifier 回灌」在本测量框架下不成立；缺口是**预算将尽时无收尾提示**，不是 verifier 回灌 |
| 「瓶颈在何时停、怎么从失败反馈里退出」 | 一半是 harness 预算问题（可修），一半是**模型约束推理错误**（`assign-seats` 写了错答案），后者不该用 harness 硬凑 |
| 隐含「K=1 读数可作改进依据」 | **同题两次跑机理完全不同**（9 工具错误 vs 0；文件不存在 vs 文件存在但答案错）→ K=1 免费端点噪声极大，**不能拿它调参** |

> 诚实处理：不删除 v2.30.0 原文，在 `TRAJECTORY-ANALYSIS.md` §4 末尾追加「§4.1 后续修正」指向本文件；历史结论保留、修正留痕。

---

## 3. 改进机制：预算软预警（budget advisory）

**代码**（`src/governance/guards.ts` / `src/kernel/loop.ts` / `src/index.ts` / `src/kernel/runtime.ts` / `src/kernel/events.ts`）：

- `Guards.check()` 在未熔断时，若 `budgetAdvisoryRatio > 0` 且 `累计 token / 步数 / 墙钟` 任一达到该比例（实验取 **0.8**），返回 `ok:true, advisory:true`，并置 `state.budgetAdvisoryFired` 保证**整轮仅一次**。
- `AgentLoop` 收到该 advisory 后注入一次通用提示：

  > 「本轮步数或 token 预算即将耗尽。请立即停止探索性工具调用，把你已经得到的结论按任务要求写入文件（或落盘当前最好结果）后再给出最终回答；尚未产出文件时不要直接宣告完成。」

- 提示**不含任何任务名、文件名、答案片段**；不重置计数、不改阈值、不放宽预算；新增独立事件 `guard.budget-advisory`，不污染 `guards` / `loopAdvisories` 统计。
- **默认关闭**：`budgetAdvisoryRatio ?? 0`。A/B 判据未全成立（见 §5），按「默认值全部是保守变体、由 train/holdout 外部断言决定」的既有纪律，不改默认行为；仅实验 B 臂与显式配置 `0.8` 时开启。

**为什么它不是「加预算刷分」**：`maxTokens` 保持 60000、`maxSteps` 保持 12，两臂完全一致；唯一变量是「熔断前是否有一次收尾提示」。若通过率提升，只能归因于**同样的资源被用在了落盘上**。

**机制契约单测**（`tests/budget-advisory.test.ts`，6/6）：缺省关闭、显式关闭不触发、开启时只触发一次、步数口径同样触发、**预警不重置计数且随后仍按原阈值硬熔断**、短任务不受干扰。全量回归 `npm test` 全绿（见 §5）。

---

## 4. 实验设计（预注册，先固化再看结果）

**控制变量**：同一端点 kilo / 同一 4 个 SOUND 任务 / 同一输入与 `ENV_NOTE` / 同一公开 pytest verifier / 同一 `maxSteps=12` / **同一 `maxTokens=60000`** / 同一 `standard` preset 与 `DEFAULT_POLICY` / 同一 `evolvedState=false`。
**唯一变量**：`budget.budgetAdvisoryRatio`（A=0 基线 vs B=0.8 预警）。**K=2** 重复。

**防过拟合划分**：

| 集合 | 任务 | 作用 |
| --- | --- | --- |
| design set | `tb-bank-trans-filter` | 诊断出问题的样本（机制针对它，但不看它调参） |
| holdout（回归） | `tb-analyze-access-logs`、`tb-constraints-scheduling` | v2.30.0 已通过、**未参与机制设计**，检查改动不使其退化 |
| 反证锚点 | `tb-assign-seats` | 失败源于模型推理错误，机制**不该**把它修好；若意外通过，优先标注为噪声/泄漏而非增益 |

**预注册判据**（写在 `examples/budget-advisory-ablation.ts` 的 `PREREGISTERED` 常量，运行前固化）：

- **P1 机制**：B 臂出现预算预警事件、A 臂为 0；
- **P2 行为对比**：B 臂「产出文件未落地」次数 ≤ A 臂 —— 呼应 `src/rsi/contrast.ts`「自报分数提升但无行为对比 → reward hacking，拒绝」，**不只看分数**；
- **P3 结果**：B 通过率 ≥ A，且两个 holdout 通过题不退化；
- **接受条件**：仅 `P1 ∧ P2 ∧ P3` 全成立才称「有初步正向证据」；否则如实判定不成立/无差异，**不硬凑优化成功**。

---

## 5. 结果（实测，非预填）

16 次运行（4 任务 × 2 臂 × K=2），耗时 20m25s。明细见 `data/bench/external/budget-advisory-report.json` 的 `trials` 字段（逐条含 `stoppedBy` / `reason` / `guardKinds` / `fileLanded` / `tokens`），原始日志 `budget-advisory-ablation.out`。复现脚本 `examples/budget-advisory-ablation.ts`。

| 指标 | A 基线 | B 预警 | 判据 |
| --- | --- | --- | --- |
| verifier 通过率 | **4/8 (0.5)** | **4/8 (0.5)** | P3 不退化 ✓ |
| 产出文件未落地 | **1** | **2** | **P2 要求 B ≤ A → ✗** |
| 预算预警触发 | 0 | 2 | P1 机制生效 ✓ |
| `guard(kind=tokens)` 次数 | 3 | 2 | 观察项 |
| holdout 通过率 | 0.5 | 0.75 | P3 不退化 ✓ |
| 平均累计 token | 57122 | 50986 | 观察项（不宣称） |

逐题（passes/trials）：

| 任务 | 集合 | A | B |
| --- | --- | --- | --- |
| `tb-analyze-access-logs` | holdout | 1/2 | 1/2 |
| `tb-bank-trans-filter` | design | 2/2 | 1/2 |
| `tb-assign-seats` | 反证锚点 | 0/2 | **0/2** |
| `tb-constraints-scheduling` | holdout | 1/2 | 2/2 |

**`P1=true, P2=false, P3=true` → 预注册接受条件未满足，判定「判据未全成立／无差异」，不宣称增益。**

### 5.1 为什么 P2 失败：不只是噪声，还有结构性局限

`B r1 tb-bank-trans-filter` 的记录是 `stop=guard(kind=tokens) adv=0 file=0` —— **预警一次都没触发就熔断了**。`check()` 在**步首**按累计值判定，而单步 token 增量可达 15000+，足以一次跨过 `[0.8×60000, 60000]` 整个预警区间。因此在固定预算下，步首式软预警**结构性地来不及**；要让它在单步跨阈时仍生效，只能延后熔断（等于放宽预算）或提前大幅降低阈值，前者是刷分、后者是看着结果调参——两者都不做。

端点噪声同样显著：A 臂 `bank-trans-filter` 2/2 通过、`constraints-scheduling` 1/2，而 v2.30.0 同题 K=1 记的是 0/1 与 1/1。同题跨轮翻转，K=2 仍不足以给出稳定信号。B 平均 token 低 10.7%、token guard 少 1 次、holdout 高 0.25，但**样本小且噪声大，不构成增益证据**（P3 只要求「不退化」，成立不等于「更好」）。

**反证锚点成立**：`tb-assign-seats` 两臂 0/2、0/2，全部 `completed`、文件均已落地，失败原因是答案写多 2 行（模型约束求解不全）。机制没有把它「修好」，符合「模型推理错误不该由 harness 硬凑」的预期，也说明新提示**没有泄漏任何答案信息**。

### 5.2 附带发现（比机制本身更重要）：v2.30.0 的读数是预算配置失真

16 次运行里 `steps` 最高只有 **9**，而 `maxSteps=12`；A 臂 3 次、B 臂 2 次撞 `guard(kind=tokens)`。也就是说 **v2.30.0 声称的「12 次模型调用预算」实际只有 4–9 次有效步**：`tb-leaderboard-compare.ts` 的 `configOverride` 只覆盖了 `maxSteps`，没同步 `maxTokens`，累计 60000 token 才是真瓶颈。

> **结论：v2.30.0 的 `2/4` 不是 bro2 能力的公平读数，而是预算配置失真下的读数。**

诚实处理：**不通过调大 token 预算去抬高这个数字**——那等于把「加资源」包装成「能力优化」。修正测量配置属于独立工作，且必须标注为**读数修正**、不是能力提升；同模型隔离锚点仍需稳定端点。

### 5.3 本轮实际产出

- **证伪**了 v2.30.0 轨迹结论（§2），并量化了 K=1 噪声（§1）；
- 交付一个**任务无关、不加预算、可关闭、有 6 项契约测试**的候选机制，默认关闭；
- 交付一个**预注册判据 + 行为对比 + holdout + 反证锚点**的可复现实验框架；
- 如实发布**负结果**，没有硬凑「优化成功」；
- 定位了下一轮真正该修的东西（测量配置失真），而不是继续给 harness 打补丁。

---

## 6. 诚实边界

- **自跑、非第三方复核**；公开 verifier 是上游 `pytest`，健全性已双向验证（空工作区 fail / 官方解 pass），但对照数值不进 L4。
- **样本极小**（4 任务、K=2）、免费匿名端点、单次结果随机性大（本文件 §1 已给出同题两次机理不同的证据）。
- **同集前后对照属弱证据**，可能过拟合到设计集；不宣称泛化能力提升、不做能力位次断言。
- **未写 `data/benchmark/external-results.json`**，**不改 L4 / `leadership.verdict`**；`CAPABILITY-POSITION` 的定位结论不因本实验变化。
- 本轮**不接第二端点**（按用户指示）；同模型 harness-Δ 隔离锚点仍为未竟项。
- 判据未全成立（见 §5），故机制**默认关闭**、仅作可显式开启的候选变体保留；不因「想优化」而掩盖负结果或改变默认行为。
- **未通过调大 `maxTokens` 抬高通过率**：§5.2 指出的预算配置失真单独记录、留待下轮修正，并标注为读数修正而非能力提升。

---

## 7. 复现

```bash
sh examples/fetch-external-tasks.sh
docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile

# 逐轨迹诊断（只读）
AGENTOS_LIVE_PROVIDER=kilo node --experimental-strip-types --no-warnings \
  examples/traj-diag.ts tb-bank-trans-filter tb-assign-seats

# 机制契约
node --experimental-strip-types --no-warnings --test tests/budget-advisory.test.ts

# A/B 消融（预注册判据在脚本常量里）
AGENTOS_LIVE_PROVIDER=kilo EXT_K=2 node --experimental-strip-types --no-warnings \
  examples/budget-advisory-ablation.ts
```
