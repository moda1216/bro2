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
