# bro2 · 能力水位定位与 ROI 转向（2026-11-10）

> 诊断起点：v2.25.0 落盘状态 · 本诊断随 **v2.26.0** 发布 · 性质：**外部定位裁决 + 下一阶段方向**，不是验收报告，不产生能力分数。
> 配套可机读资产：[`data/reference-landscape.json`](../data/reference-landscape.json)（14 条外部公开参照）·
> 可复核视图：[`examples/position-check.ts`](../examples/position-check.ts)（17 项断言全过）。
> 全部数字检索于 2026-11-10；公开榜单按周变动，部分经聚合页转引，引用前须回查官方榜。

---

## 0. 一页结论（TL;DR）

**bro2 的能力水位 = 内部可验证、外部未测量。** 这不是「弱」，也不是「领先」——是**在公开可比尺子上还没有坐标**。

| 维度 | 结论 | 证据 |
| --- | --- | --- |
| 内部能力 | L0 结构连通 / L1 确定性行为回归 / L2 有界自我改进 **达成**；L3 meta RSI + ablation **partial** | `data/benchmark-report.json` `achievedLevels=[0,1,2]` |
| 外部能力 | L4 公开基准对齐 **not-achieved**；外部证据导入 **0 条**；`verdict` **not-proven** | `assessEvidenceLadder` + 空的 `data/benchmark/` |
| 现有"分数" | `overall=1.0` 是 **mock 脚本回放**（模型智能不参与评分）；`overall=0.7` 是 **kilo 免 Key 端点 10 题 k=1**（工具能力不稳） | `data/eval-report.json` / `data/eval-live-report.json`；BENCH-v2 §6 自述 |
| 公开对比参照 | **外部世界有一整套成熟参照系**：公开榜单、锁定 harness 协议、同模型增益实证、harness-RSI 赛道。bro2 侧 **0 条** | 见 §2 与参照系台账 |
| 定位是否完成 | **是**。诚实定位已完成：知道自己在哪一格、缺口是什么、根因是什么。不知道的是「能力多强」——那需要外部实验 | 本文件 §1 |
| 最高 ROI 下一步 | **不是再造治理门禁**，而是用 Harbor + mini-swe-agent/Terminus-2 把 `W5-05 同模型对照` 从依赖链末尾解耦成 P0，产出第一组可复现对照数 | 见 §4–§5 |

**一句话裁决**：过去 6 个版本（v2.20→v2.25）都在加固「尺子是否诚实」，这是必要且正确的；但**尺子再诚实，也代替不了把尺子放到公开赛道上量一次**。下一阶段重点从「治理可信」转向「能力可定位」。

---

## 1. 能力水位究竟如何了：精确诊断

### 1.1 两层要分开说，混在一起就会自欺

- **内部层（已充分验证）**：在自建确定性域里，bro2 跑通了结构连通、19 任务全链路行为回归、train/holdout 双门禁的有界自我改进、meta RSI 改进改进机制自身、外部真值 oracle 晋升 veto、代码预算防暗调。这些是**真实且可复核**的工程事实，`npm test 290/290`、门禁 24/24 支持它们。
- **外部层（未测量）**：「bro2 相对公开 agent 处于什么水平」是**外部比较命题**。项目自己在 `ladder.ts` 里把判据写成「在 BFCL/τ-bench/GAIA/SWE-bench 类公开基准上，与同期开源 harness 第三方可复现对比并胜出」——这条一次都没执行。

### 1.2 为什么现有分数不能回答「能力多强」

`docs/BENCH-v2.md §6` 已经把边界写得很清楚，这里不重复，只点出对定位最致命的三条：

1. **任务、fixture、隐藏断言全自建** → 不具备外部有效性；
2. **18 个 L2 + 1 个 L3 + 9 个故障任务，全部 k=1**，单题权重 5.6pp → 一次波动就改结论；
3. **L3 长程能力 standard/minimal 均 1/1（0pp）**，压缩、纠错、重规划**从未被真正触发** → harness 最该发力、也最能拉开差距的场景，恰恰没测。

`PLAN-TOP-HARNESS.md §0` 的诊断更直白：19 个 4–5 步脚本化短任务，真实强模型只跑出 `avgSteps=2.67`，「**用短任务测 harness，等于用直道测越野车**」。

### 1.3 诚实结论

> bro2 是一台**可验证、防自指的 RSI/harness 研究台**，L0–L2 达成、L3 partial。
> 它在「agent 能力水位」这个外部比较命题上**没有坐标**（L4 not-achieved、verdict not-proven、0 条外部证据）。
> `overall=1.0` 证明的是框架正确，不是模型聪明；`overall=0.7` 是弱端点上的一个不稳定样本，不构成基准。

---

## 2. 有没有一个公开 agent 的对比参照？——有，而且与 bro2 命题高度对齐

用户问「有没有」。答案是 **外部世界有，而且不是勉强凑的，是 2026 年正好成熟、且直接为 bro2 的核心命题背书的整套参照系**。bro2 缺的不是参照物，是把自己接上去。分四层：

### 2.1 公开榜单（分数坐标系，且明确「锁定 harness」）

| 基准 | 2026-10 状态 | 头部成绩 | 关键口径 |
| --- | --- | --- | --- |
| SWE-bench Pro | 有区分度 | 61.5% ±3.1 | 四强全跑在 **mini-swe-agent** 上；约 30% 任务被标记有问题 |
| Terminal-Bench 4.0 | 最活跃 | 64.85% ±3.11 | 官方维护最小脚手架 **Terminus-2** 解耦模型与 harness |
| OSWorld 2.0 | 未解决 | 20.6% binary / 54.8% partial | 长程 computer-use，500 步 |
| GAIA / OSWorld-Verified / WebArena / τ² | **饱和** | 94% / 90.2% / 74.3% / 87.9% | 已接近或超人类基线，**不再区分前沿 agent** |
| SWE-bench Verified | **退役** | 79.2%（冻结于 2026-02） | OpenAI 因 59.4% 抽查题有缺陷测试 + 训练污染停报 |

两条对定位极其重要的**元事实**：
- 榜单方明确**不采信厂商自报分**，因为「vendors run their own harnesses」→ **harness 必须被锁定/披露，分数才可比**。这正是 arXiv 2605.23950 的 Binding Constraint Thesis。
- **基准本身会腐坏**（Verified 退役、Pro 30% 任务有问题、UC Berkeley RDI 2026-04 审计 8 个主流基准全部可 reward-hack 到近 100%）→ 反向印证 bro2 全程防自指是对的，但也说明**不能靠自建隐藏断言「看起来通过」自封**。

### 2.2 锁定 harness 协议（可直接接入，不必自建基准）

这是本轮调研**最有价值的发现**：`W5-01 Headless SDK → W5-02 Docker → W5-03 REPRODUCE → W5-04 CI` 这条依赖链想自建的东西，外部已经开源了：

- **Harbor**：`harbor run --dataset X --agent Y --model Z`，原生支持 Terminus-2 / Claude Code / Codex CLI / OpenHands / **mini-swe-agent 及自定义 agent**，数据集/harness/环境三分离；
- **mini-swe-agent**：约 100 行 Python、MIT、只给一个 bash 工具、线性历史，是 Epoch AI 等推荐的跨模型比较 locked-harness 基线；
- **AgentCompass**（arXiv 2607.13705）：Benchmark/Harness/Environment 三分离 + reward-hacking 轨迹诊断，与 bro2 内核同构。

**结论**：bro2 不需要花 13 周重建基准，只需作为**自定义 agent 接入 Harbor**，就能和 mini-swe-agent / Terminus-2 在**同一模型、同一任务、同一预算**下跑出对照数。这一步把 W5-05 从「依赖链末尾」直接变成「可立即启动的 P0」。

### 2.3 同模型增益实证（bro2 命题的直接外部背书）

`Model + Harness = Agent` 不是 bro2 的自创口号，2026 年已是学界主流，且有量化数据：

| 固定模型，只换 harness | 增益 | 来源 |
| --- | --- | --- |
| Claude Opus 4.5：SEAL → Claude Code | 45.9% → 55.4%（**+9.5pp**） | arXiv 2605.23950 Table 1 |
| Claude Sonnet 4.5：Cline vs SWE-agent v1 | 59.8% vs 43.2%（**+16.6pp**） | 公开榜对照 |
| Terminal-Bench 2.0：prompt+middleware+verification | **+13.7pp** | 同上 |
| HAL 同模型跨 scaffold | 最大近 **48pp** | 同上 |
| 方差分解 | harness 诱导方差 ≈ 模型诱导方差 **7.8×**，6/9 模型对排名翻转 | arXiv 2605.23950 |

**紧上下文 Context 层**（arXiv 2608.26218）尤其相关：固定 20,480 token 窗口，只在 harness 里机械压缩旧工具结果 + 响应停滞，SWE-bench Verified 169 任务 mean F2P **28%→49%**、完整解 **43→72**，且同一冻结改动**免调参迁移到 3 个异构模型**；宽窗口下增益消失。这是「纯 harness、可跨模型迁移」的干净实证，也正是 bro2 已有 `src/context/` 骨架却从未在外部尺子上测过的方向。

### 2.4 harness-RSI 赛道（bro2 的公开同类）

2026 年已形成「让 LLM 提议并演化自身 harness」的公开赛道，**且全部在公开基准上交出可复现分数**：

- **RRSI**：Terminal-Bench 2.1 `64.6 → 78.7`（Gemini 3.5 Flash，Apache-2.0），用 L0/L1/L2 式正则抑制对 evolve set 过拟合；
- **Meta-Harness**：TB2.0 `76.4%`；**ModularRSI**：TB2.0 `47.57→52.43%`、Verified `73.4→76.45%`；**AHE**：每个 edit 是「可证伪契约」，<24h 超专家 harness；
- **Continual Learning Exam**（2026-10-25）：17 配置、中位 `+5.33pp`，最好仅 47.7% levels，但被 rsi.watch 评 **Low certainty**（无置信区间、无跨 seed 方差、无第三方复现、未分离「跨任务保留知识」与「多一次提交机会」）。

**这层的定位含义最尖锐**：bro2 与这些系统是同一命题（冻结模型、有界 RSI 演进 harness），差别只在——**它们在公开尺子上交数，bro2 在自建域内自证**。连外部 RSI 研究的增益都常被方法学高估，说明 bro2 的诚实纪律是相对优势，但**不能替代外部可复现数**。

---

## 3. 为什么至今无法定位：根因不是「没 GPU/没 Key」

`ladder.ts` 的 L4 gap 写的是「沙箱无 GPU / 无 Ollama / 无 API Key」，但本轮取证后判定这是**表层原因**，真正的根因是结构性的：

1. **外部证据通道是「被动导入 + 从未启用」**：`external.ts` 只认 `data/benchmark/external-results.json`，且明确禁止 bro2 自生成的报告算外部证据（正确的防自写自证设计）。但结果是——这个通道**从未被写入过任何一条**，`data/benchmark/` 是空目录。
2. **计划齐备，执行度为零**：`docs/PLAN-TOP-HARNESS.md` 已定义北极星指标 `HLR ≥ 0.30`、五战役、13 周里程碑；`backlog W5-05「同期 harness 同模型对照」` 也已登记。但仓库里**没有任何 HLR 测量命令**、`data/bench/external/` 不存在、`data/benchmark/` 为空。`W5-05` 被 `W5-01→02→03→04` 串行依赖链压在末尾，永远轮不到。
3. **过去 6 版的方向性偏差**：v2.20 oracle 原语 → v2.21 真值任务集 → v2.22 晋升审计 → v2.23 运行时 veto → v2.24 自锁诊断 → v2.25 冻结量尺。**六版全部落在治理/防篡改/尺子诚实层（E/T/C/S/O/V 中的 O + governance）**。而 `The Scaffold Effect` 的公开实证是：O 层对 pass rate 影响仅约 **2pp**，主要影响的是成本（tokens/solved-task 差 40×）。即——**这六版把力气花在了外部证据显示增益最小的层上**。

> 诚实地说：这六版不是「做错了」（防自指是接外部尺子的前置条件，UC Berkeley RDI 的 8/8 reward-hack 结论证明它必要），
> 而是**边际收益已经拐点**——再加固一层治理，不会让 bro2 在 SWE-bench Pro 上多解一道题。
> 「完成定位」这件事，被「持续加固定位工具」本身挤掉了。

---

## 4. 如何突破完成定位

关键转向：**从「造更诚实的尺子」转向「把现有尺子接到公开赛道量一次」**。不新增治理门禁，不加 `src` 代码，不动任何阈值。

### 4.1 突破路径（三层，可增量验证）

**P0 · 解耦 W5-05，产出第一组同模型对照数（最高 ROI）**

用 §2.2 的现成协议，把「同期 harness 同模型对照」从依赖链末尾解放出来：

- 对照组：`mini-swe-agent`（locked-harness 基线）/ `Terminus-2`；实验组：bro2 作为 **Harbor 自定义 agent**；
- **同一模型、同一任务子集、同一预算、同一评分器**（Harbor 已提供前三者，评分器用公开基准自带 verifier）；
- 产物落到隔离的 `data/bench/external/` 供复核，**明确标注「bro2 自跑、非第三方复核、仅内部对照」**；
- **绝不写入 `data/benchmark/external-results.json`**——`external.ts` 明确禁止 bro2 自生成的报告算外部证据，自跑对照冒充外部证据正是本项目全程防的 self-confirming loop；L4 不因此改变。

> **一个必须点破的诚实陷阱**：零 Key 沙箱里**唯一能做的是「协议接入验证」**（Harbor 能否装载 bro2 为自定义 agent、任务/预算/评分器能否三方对齐、可复现命令能否跑通），**不是能力对照**。确定性 mock 是脚本回放、模型智能不参与评分，换 harness 量出的 Δ 恒不反映 harness 价值——那会是一块空转仪表盘，用「可跑」冒充「已定位」。**第一组真实对照数必须有可工具调用的模型端点参与**，这是硬门槛，本轮不虚报已完成。

**为什么这是最高 ROI**：只有这一步能让 §2 的全部外部参照从「信息」变成「bro2 的坐标」。在它之前，任何关于能力水位的改进都无法被外部验证；在它之后，每一个后续 harness 改动都能用同一把尺子量出 Δ。它同时是可证伪的——**若 Δ≤0，就诚实降级定位**（见 §6）。

**P1 · Context 层紧窗口压缩（次高 ROI，有干净外部实证）**

`src/context/` 已有 budget/builder 骨架。按 arXiv 2608.26218 的方式实现「旧工具结果压缩 + 停滞检测」，在 P0 的对照框架下量 Δ。选它是因为：纯 harness、跨模型免调参迁移已验证、增益量级最大（28%→49%）、且与 bro2 已有的 `loopDetection`/`budget` 分支天然贴合。

**P2 · 长程任务集重建（W1 的精简版）**

不是重建 13 周基准，而是在 P0 跑通后，把公开基准的**长程子集**（OSWorld 2.0 / TB4.0 的多步任务形态）映射成 bro2 的 L3 任务，专门触发此前 0pp 的压缩/纠错/重规划。这一步才真正回答「bro2 的 harness 在长程上值多少」。

### 4.2 明确的退出/降级信号（可证伪，不是口号）

- 若 P0 同模型对照显示 **Δ ≤ 0**：bro2 应把定位从「竞争顶级 harness」**降级为「可验证 RSI 研究台」**，停止在能力比较上投入，转而深耕它已验证的诚实治理价值；
- 若 Δ > 0 但**换 holdout 模型后消失**：判为对单一模型/任务集过拟合，不计入 L4；
- 若去掉 RSI 后分数不变：改进来自任务集过拟合而非机制（沿用 `ladder.ts falsification`）。

---

## 5. 如何发现新的 ROI 大的改进方向（本轮方法论，可复用）

用户问的不只是「下一步做什么」，而是「**怎么发现**」。给一条可复用的判据，避免下次又凭直觉挑方向：

> **ROI(方向) ≈ 外部可证伪增益 Δ ÷ 实现成本，且 Δ 必须能在锁定 harness 的公开对照里被量出来。**
> 任何无法在 P0 建立的对照框架下产生可测 Δ 的改动，ROI 记为 0，不进入主攻方向。

四个筛选器，按此排除掉大量「看起来该做」的事：

1. **公开实证优先**：该方向的增益在外部已有可复现数据吗？（Context 压缩 28→49%、同模型换 harness +9.5~16.6pp → 通过；再造一层治理门禁 → 无外部数据 → 淘汰）
2. **解锁性优先**：这个方向能否让**其它方向**的 Δ 变得可测？（P0 同模型对照 → 解锁全部，最高杠杆）
3. **依赖链最短优先**：是否必须等 N 个前置工程？（W5-05 原需等 4 个 → 用 Harbor 绕过后需等 0 个）
4. **诚实成本计入分母**：需要新治理/新阈值/新证据通道来「证明有效」的方向，成本更高、ROI 更低。

按此对当前候选排序：

| 优先级 | 方向 | 外部实证 | 依赖 | 判定 |
| --- | --- | --- | --- | --- |
| **P0** | W5-05 同模型对照（Harbor 接入） | 锁定 harness 是公开榜既有做法 | 工程依赖 0（Harbor 开源）；**资源门槛：需可工具调用模型端点** | **最高 ROI** |
| P1 | Context 紧窗口压缩 | F2P 28→49%、跨模型迁移 | P0 的对照框架 | 高 |
| P2 | 长程任务集（触发 0pp 的 L3） | TB4.0 / OSWorld 2.0 长程形态 | P0 | 中高 |
| P3 | 真实模型矩阵 / 第三方复现 | `missingForIndustryLeading` 明列 | 需 Key/外部人 | 中（定位后） |
| — | 再加治理门禁 / 防篡改层 | Scaffold Effect：pass rate Δ≈2pp | — | **本阶段淘汰**（边际拐点） |

**这套判据本身也要防自指**：它由外部公开证据（§2）驱动，不由 bro2 内部自评驱动；`data/reference-landscape.json` 每条都标 `bro2Measured=false`，`position-check.ts` 断言外部数字绝不算成 bro2 成绩。

---

## 6. 诚实边界（不变且更严）

- 本诊断**不产生能力分数、不提升 L4、不改 `leadership.verdict`（仍 not-proven）、不写 `external-results.json`**；
- §2 的全部数字是**外部第三方成绩/研究结论**，经聚合页转引、按周变动，未经 bro2 复核；它们是「参照系」不是「bro2 坐标」；
- 定位完成 ≠ 能力达标。bro2 目前在公开尺子上仍是 **not-measured**；
- 过去六版的治理工作**未被否定**，只是被外部证据判定为边际收益拐点；本转向是 ROI 裁决，不是翻案；
- 无 API Key 沙箱内，P0 只能完成**协议接入验证**（Harbor 装载 bro2 为自定义 agent、任务/预算/评分器对齐、可复现命令跑通，可离线跑、可复核），**不能完成能力对照**：确定性 mock 是脚本回放、模型智能不参与评分，用它量 harness Δ 会是一块空转仪表盘。**真实模型对照与第三方复现需外部资源**，本轮不虚报已完成。

---

## 7. 本轮落地清单（全部在预算豁免区，零 `src` 改动）

| 产物 | 作用 |
| --- | --- |
| `data/reference-landscape.json` | 14 条外部公开参照，逐条带来源/日期/证据等级/`bro2Measured=false`，标注 `notL4Evidence` |
| `examples/position-check.ts` | 17 项断言的可复核定位视图：真实阶梯 + 防自指隔离 + 「bro2 在哪一格」表格 + ROI 缺口 |
| `docs/CAPABILITY-POSITION.md` | 本诊断与方向裁决 |
| `data/plan/backlog.jsonl` | 新增 `P0-POSITION` 条目：把 W5-05 解耦为无前置依赖的 P0（见下） |
| `docs/INDEX.md` | 文档导航登记 |

> 一句话：**定位已经完成——bro2 站在「内部 L0–L2 达成、外部未测量」这一格。**
> 下一步不再是加固这一格的描述，而是走上去量一次。

---

## 8. 后续执行记录

### 8.1 v2.27.0（2026-11-11）

**「走上去量一次」已执行**，见 [`EXTERNAL-MEASUREMENT.md`](./EXTERNAL-MEASUREMENT.md)。三条通道实测接通（公开任务按固定 commit 取用、`kilo` 免 Key 端点原生 `tool_calls`、Docker 执行上游公开 pytest），在 3 个公开任务上产出第一组同模型对照：**bro2 2/3 · minimal scaffold 1/3 · Δ=+1**（k=1，评分器三反证全过）。

- **修正 §4.1 / §6 的一处判断**：「需可工具调用模型端点」不是资源硬门槛，本沙箱内早已满足；**防自指纪律不变**（确定性 mock 仍量不出 harness Δ），变的是「因此做不了」的结论——缺的是接线，不是资源。
- **定位不变**：仍是自跑内部对照、非第三方复核、k=1、免费匿名端点、3 个 easy 任务；L4 仍 `not-achieved`、`verdict` 仍 `not-proven`、外部证据仍 0 条。
- Δ=+1 在 3 题 k=1 下单题权重 33pp，**不构成统计结论**；按 §4.2 必须换 holdout 模型并增大 k 复测，Δ 消失则降级定位为「可验证 RSI 研究台」。
- `P0-01`（Harbor 装载 bro2 为自定义 agent）、与 `mini-swe-agent` / `Terminus-2` 的第三方可复核对照、长程任务子集**仍未完成**，不作已完成登记。

### 8.2 v2.28.0（2026-11-11）· P0-04 硬化：k=3 通过率 + 跨模型复刻尝试

把 §8.1 的 k=1 单发快照**硬化为 k=3 通过率**（每题 3 次、9 次/arm），并接第二个模型族 `ovhcloud` / `gpt-oss-120b` 作跨模型 holdout。详见 [`EXTERNAL-MEASUREMENT.md §4`](./EXTERNAL-MEASUREMENT.md)。

- **kilo（主端点，k=3）**：bro2 **6/9（0.67）** · minimal **2/9（0.22）** · **Δ=+4**（约 +0.44 通过率差）。单发运气被消解后信号更稳更强；`bank-trans-filter` 在 k=3 下 **bro2 3/3 vs minimal 0/3**，成为 harness 增益最干净的证据。
- **ovhcloud（holdout，k=3）**：被 `provider_error` 反复打断（agent 几乎没产出文件，verifier 报 `FileNotFoundError`），9 次全失败 → **无效对照**，Δ=+1 无意义。**跨模型有效复刻未完成**。
- **未触发 §4.2 降级**：降级条件是 Δ≤0 或 holdout 模型上 Δ 消失；这里两个端点 Δ 都 ≥ 0，且 ovhcloud 是端点本身驱动失败（非 Δ 消失），所以定位**维持**——但跨模型确认**仍缺失**，需换一个能在完整 harness 下稳定驱动工具调用的第二端点。
- **定位不变（仍诚实）**：自跑内部对照、非第三方复核、k=3、免费端点（kilo 稳定 / ovhcloud 报错）、3 个 easy 任务、非榜单分数；L4 仍 `not-achieved`、`verdict` 仍 `not-proven`、外部证据仍 0 条、不写 `external-results.json`。
- `P0-01`（Harbor 装载）、与 `mini-swe-agent` / `Terminus-2` 的第三方可复核对照、**跨 holdout 模型有效复测**、扩任务集（仍 3 个 easy）、长程任务子集**仍未完成**，不作已完成登记。

### 8.3 v2.29.0（2026-11-12）· P0 接入口收口：Harbor 装载 + 跨 agent 对照框架 + 跨模型复测启动

把 §8.2 之后遗留的三条 P0 接入口补齐为**可复核的协议与框架**（均零 Key、不产能力分数、不写 external-results、不改 L4/verdict）：

- **P0-01 Harbor 装载（协议接入验证）**：`examples/harbor/bro2_agent.py` 实现 Harbor `BaseInstalledAgent` 契约，`examples/harbor-verify.ts` 零 Key 复用 `external-measure.ts` 真相源做三方对齐验证（空工作区 fail / 官方解 pass / SHA256 一致全过、预算 max_steps=12 对齐、护栏守住），契约测试 5/5 通过。live 对照需 Harbor 运行时 + 端点，沙箱默认不具——故为**协议接入验证而非能力对照**，这正是 §4.1/§6 划定的诚实边界。
- **P0-02 跨 agent 第三方可复核对照框架**：`data/bench/external/agent-comparison.json` 给出同任务/同预算/同评分器三方对齐模板，填 bro2 自跑数（kilo k=3：bro2 6/9 vs minimal 2/9，Δ=+4），`mini-swe-agent` / `Terminus-2` 留 `thirdPartyToFill` 槽位（不可伪造）；`minimal scaffold` 明确标注 ≠ 公开基线。契约测试 4/4 通过。沙箱无法运行那两个 agent，其数值需第三方按同协议复跑填入。
- **跨 holdout 模型有效复测（启动 + 有界复现，结论诚实更新）**：重新探测确认 `ovhcloud / gpt-oss-120b` 现已返回原生 `tool_calls`（与 kilo 的 nemotron 不同模型族），harness 实跑中确实驱动 gpt-oss-120b 完成 4–5 次工具调用后才中断；但 ovhcloud 免 Key **限流约 3 次/窗口**，持续多步走分仍被 429 拖垮——有界复测（`examples/cross-model-retest.ts`，k=1 + 每轮 40s 冷却）结果为 **bro2 0/3 · minimal 0/3 · Δ=0**，两端点均 `provider_error` / `FileNotFoundError`。这是**端点稳定性问题、非 Δ 消失**（两 arm 同因限流失败，不是 harness 增益归零），故该 holdout 结果**无效、不可作 Δ 判据**，不触发 §4.2 降级。**跨 holdout 模型有效复测仍被「缺稳定第二端点」阻断**；kilo 上的 bro2 6/9 vs minimal 2/9（Δ=+4）仍是唯一有效内部 Δ，单端点、非统计结论。
- **定位不变（仍诚实）**：自跑内部对照、非第三方复核、免费端点、3 个 easy 任务、非榜单分数；L4 仍 `not-achieved`、`verdict` 仍 `not-proven`、外部证据仍 0 条、不写 `external-results.json`。`P0-01` / `P0-02` 在 backlog 标记为 resolved（协议/框架已交付）；跨模型复测的 live 结论随复测结果更新，扩任务集与长程子集仍为下一步。

### 8.4 v2.30.0（2026-11-12）· 走出去测量硬化（二）：公开榜单任务集直跑 + 轨迹层面能力画像

按用户方向纠正上一轮「P0-02 留成等第三方来填的空槽」这一非真正走出去测量的做法——**不等人填，直接把第三方已有公开成绩的任务集给 bro2 跑、对公开数字**；并补策略 B：靠轨迹差异判断能力。

- **A2 公开榜单任务集直跑**：`examples/tb-leaderboard-compare.ts` 在 Terminal-Bench `original-tasks @ d28711d0` 的 **4 个 SOUND 任务**上用 bro2 完整 harness 自跑，把样本 pass@1 与公开榜快照（`tb-leaderboard-snapshot.json`，llmleaderboard.com 2026-11-09，带出处）对照。**kilo 主端点（匿名，不在榜）bro2 2/4（0.5）→ positioning-only 位次定位**；ovhcloud 同模型锚点（gpt-oss-120b，公开榜 26.217%）因端点限流 `provider_error` 无法取得有效数据，**按 §4.2 回退为 positioning-only、不做误导 Δ**。
- **诚实发现（扩展样本受阻的根因）**：试图扩到 8 任务，但 `dna-assembly`/`dna-insert`/`gcode-to-text` 官方解需 `apt-get`/`pip` 装依赖、`circuit-fibsqrt` 评分器需 `gcc`——统一离线 verifier（仅 stdlib+pytest）无法复现。**Terminal-Bench 任务绝大多数是「构建时环境重」，只有静态输入 + 纯 stdlib 评分器的子集可直跑**；这对任何「复跑公开榜」尝试都是硬约束，已据实剔除并留痕。
- **B1 轨迹层面画像（策略 B）**：`docs/TRAJECTORY-ANALYSIS.md` 把 bro2 的步数/工具调用/停止行为与公开轨迹统计（SWE-bench `Avg. $ Trajs`、2025 研究每题 5–20 轨迹）对照（HF 不可达，不用逐条轨迹数据集，只取公开聚合作参照轴）。读出一条**可证伪的 harness 行为结论**：失败题工具调用数（14、11）高于通过题（9、5），即 bro2 对解不出的任务不会优雅停手、缺失「验证—停手」闭环——这是行为层信号、可直接变成后续 harness 迭代的可证伪实验。
- **定位不变（仍诚实）**：自跑内部对照、非第三方复核、4 题/K=1/免费端点、非榜单口径；L4 仍 `not-achieved`、`verdict` 仍 `not-proven`、外部证据仍 0 条、不写 `external-results.json`。**唯一明确的未竟 = 同模型隔离锚点因端点限流未取得**，下一步需一个能在完整 harness 下稳定驱动工具调用的第二端点。

### 8.5 v2.31.0（2026-11-13）· 用已有外部真值证伪一次优化假设（诚实负结果）

> 用户问「先不管第二端点，用已有的信息可以优化 bro2 了吗」。本轮没有拿 `2/4` 直接调参，而是先诊断、再改、再用预注册判据判定；**结果是否定的，如实记录**。

- **§8.4 的 B1 行为结论已被逐轨迹诊断证伪**（只增修正，见 `TRAJECTORY-ANALYSIS.md` §4.1）：失败不是「空转不肯停」，而是 `guard(kind=tokens)` 静默熔断早于产出落地（`bank-trans-filter`）与模型约束求解不全（`assign-seats` 写 4 行、正确 2 行）。同题两次 K=1 机理完全不同（9 工具错误撞 guard vs 0 错误正常完成）→ **免费端点噪声大，v2.30.0 的 2/4 不能作为调参依据**。
- **改进实验（预注册 A/B，负结果）**：预算软预警（默认关闭、不加预算、6 项契约单测）在 4 任务 × 2 臂 × K=2 = 16 次运行上，`P1 机制✓ / P3 不退化✓ / P2 行为（文件未落地 B=2 > A=1）✗` → **判据未全成立，不宣称增益，机制保持默认关闭**。含行为对比（呼应 `src/rsi/contrast.ts` 的 reward-hacking 拦截）、holdout 回归与反证锚点（`assign-seats` 两臂 0/2 全 fail，无答案泄漏）。结构性归因：单步 token 增量可一次跨过 0.8 预警区间，步首预警在固定预算下来不及生效；修它只能延后熔断（刷分）或看着结果调阈值（过拟合），均不做。
- **附带发现（影响对 §8.4 读数的解释）**：16 次运行 `steps` 最高 9 而 `maxSteps=12`，A 臂 3 次、B 臂 2 次撞 `guard(kind=tokens)`——**v2.30.0 的 `2/4` 是预算配置失真下的读数，不是 bro2 能力的公平读数**（`configOverride` 只覆盖 `maxSteps` 未同步 `maxTokens`）。**未通过调大 `maxTokens` 抬高该数字**。
- **定位不变（仍诚实）**：自跑、非第三方复核、4 题/K=2/免费端点、同集前后对照属弱证据；L4 仍 `not-achieved`、`verdict` 仍 `not-proven`、外部证据仍 0 条、不写 `external-results.json`。本轮是 harness 层可证伪实验，**不是能力位次变化**。
- **下一步优先级**：① 修测量预算配置失真（明确标注为读数修正、非能力提升）；② 稳定端点 / 更大 K 下复验候选机制；③ 同模型隔离锚点仍需第二端点。详见 [`BUDGET-ADVISORY-EXPERIMENT.md`](./BUDGET-ADVISORY-EXPERIMENT.md)。（①② 已在 v2.32.0 执行，见 §8.6）

### 8.6 v2.32.0（2026-11-13）· 执行下一步①②：读数修正 + 更大 K 机制复验

> 用户要求「执行下一步 1 和 2，整理产出物，给一个核心报告即可」。全部结论收敛于唯一交付物 [`CORE-REPORT.html`](./CORE-REPORT.html)（从可复核 JSON 生成）。

- **① 读数修正已落地且被证成**：失真根因是测量脚本 `configOverride` 只覆盖 `maxSteps=12`、`maxTokens=60000` 靠默认静默生效，报告的 `budget` 字段未披露真正的 binding constraint。已改为成套显式声明（`LEGACY_MAX_TOKENS` + `effectiveBindingConstraint` 标签，语义零变化、历史可复现）。36 次对照（K=3）实测 L 组 2 次 `guard(tokens)`（steps<12）、C 组 0 次；**读数 0.75→0.667（Δ=−0.083，不升反降）**——校准让 12 步预算真正生效，且明确排除「加资源刷分」。归因锁死 `measurement-wiring-not-capability`，**不写入任何能力/位次字段**。
- **② 更大 K 机制复验：机械全绿但判定证据不足**：公平口径 + K=3 下 `C vs A` 的 P1/P2/P3 全成立，但只增的「诚实二次判读」层指出：A−C 通过差仅 1 个 trial、可被 C 组独有的 1 次 `provider_error` 完全解释；软预警在 A 组 12 次仅触发 1 次（校准后 token 不再是瓶颈，机制几乎未被检验）。**维持默认关闭、不据此开启**——预注册判据结果原样保留，不事后改判据，呼应 `src/rsi/contrast.ts` 防 reward-hacking。
- **定位不变（仍诚实）**：读数口径从失真修到自洽，但**能力水位未变**；L4 仍 `not-achieved`、`verdict` 仍 `not-proven`、外部证据仍 0 条、不写 `external-results.json`（R3 校验通过）。反证锚点 `assign-seats` 三组 0/9 全 fail，确认无答案泄漏。
- **下一步优先级（v2.32.0 当时）**：① 同模型隔离锚点仍需一个能稳定驱动工具调用的第二端点（ovhcloud 限流无效）；② 在公平口径下扩大 K / 扩任务集，把机制复验从「弱证据」推向可辩护；③ 任何改进仍走预注册判据 + 行为对比 + holdout + 二次判读，不靠分数叙事。（①③ 已在 v2.33.0 处理，见 §8.7）

### 8.7 v2.33.0（2026-11-13）· 自己找可用第二端点：端点扫描 + 同模型隔离锚点

> 用户要求「自己找找可用的第二端点，不要被这个吓到」。全部结论收敛于唯一交付物 [`CORE-REPORT.html`](./CORE-REPORT.html)。

- **§8.4/§8.6 的「ovhcloud 限流无效」被证伪**：主动扫描 15 个端点/模型组合（`endpoint-scan.ts`），5 个可原生 tool_calls，唯一身份匹配公开榜的锚点 `ovhcloud/gpt-oss-120b`（响应 `model=gpt-oss-120b`）。端点本身单次调用返回 200 + `tool_calls`；v2.30.0 的 `provider_error` 根因是**匿名层 2 req/min** 与 harness 退避（1s/2s/4s、maxRetries=2）不匹配，**不是端点故障**。第二端点从来不缺，缺的是限流适配。
- **联网新端点也有，但有身份陷阱**：BlockRun 免 Key、支持原生 tool_calls，不过 `nvidia/gpt-oss-120b` 已退役重定向到 `nemotron-3-super-120b`，且免费容量 4 次 3 次 429，不能冒充锚点。kilo 471 个模型里的榜单模型具体 ID 全部 `401`（只有 `kilo-auto/free` 匿名）、opencode-zen `*-free` 429、llm7 榜单模型 401 —— 模型身份一律以响应 `model` 字段为准，写进前置门禁。
- **测量侧节流适配**（`same-model-anchor.ts`）：`fetch` 层对 ovhcloud chat 请求加「相邻 ≥31s + 429 同节奏重试」，**不改 src / 不改默认行为 / 不改 token·步数口径**（沿用 §8.6 校准值），仅显式放宽墙钟。1 任务验证 `PASS / completed / provider_error=0 / 429重试=0`；全量 4 任务 × K=2 = 8 次稳定跑通，**4/8 = 0.5 / `provider_error=0` / `429重试=0` / 停止分布 `completed:4 guard:4`**（4 次失败均为 12 步用完的真实能力表现），产出 bro2 在 `gpt-oss-120b` 上的首个可复核读数。
- **同模型对照仍诚实降级为「位次参照」**：对照公开榜 Terminal-Bench 全量 `gpt-oss-120b = 26.217%`，但两者**任务集不同（4 curated 静态输入子集 vs 全量）、难度不可比**，`kind=non-strict-positioning-reference`、`isStrictHarnessDelta=false`，名义差**不可归因于 harness**。要构成可归因 Δ，需官方 harness 在同子集成绩或 bro2 跑全量任务集（当前统一离线 verifier 只支持静态输入子集）。**本轮价值是把卡点从「端点不可用」推进到「端点可用 + 有读数 + Δ 边界清楚」，不是能力水位提升**。
- **定位不变（仍诚实）**：自跑、非第三方复核、小样本、免费匿名端点；不写 `external-results.json`、L4 仍 `not-achieved`、`verdict` 仍 `not-proven`。
- **下一步优先级**：① 让同模型对照成为**可归因 Δ**（补官方 harness 同子集成绩 / 扩任务集到全量）；② 在稳定端点 / 更大 K / 更多任务下把机制复验从「弱证据」推向可辩护；③ 任何改进仍走预注册判据 + 行为对比 + holdout + 二次判读，不靠分数叙事。
