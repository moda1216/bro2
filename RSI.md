# RSI 前沿调研与 bro2 的自我改进定位

> 调研时间：2026-11-07 ｜ 面向：`bro2`（原 Agent OS 运行时）
> 目的：把「递归自我改进」从概念澄清到可落地机制，明确 bro2 **做什么、不做什么**，并给出每条设计决策对应的文献依据。

---

## 0. 一句话结论

学术界在 2026 年已经把 RSI 拆成两类：**有界自我精化（bounded self-refinement）** 已是工业实践且可验证；**开放式递归自我改进（open-ended RSI）** 在所有可测量维度上仍受限于**验证信号、坍塌动力学与算力**，没有任何已发表系统展示出「自我重训权重的复利循环」。bro2 因此定位为 **L3 完整 + L4 有界特征**：以不可篡改的外部执行评测作为唯一晋升依据，让可改进的能力面与改进策略自身都接受同一套门禁，同时把治理面写保护。**不宣称实现 L5，不做权重更新，不做无监督闭环。**

---

## 1. 概念澄清：RSI 至少是五种不同的东西

2026 年 9 月的系统性综述（[arXiv:2607.07663](https://arxiv.org/abs/2607.07663)，覆盖 2024–2026 共 1,250 篇 arXiv 论文）指出，`self-X`（self-refine / self-reward / self-play / self-evolve / self-verify）这套词汇把**野心与风险_profile 完全不同的工作 conflate 在一起**。该综述用两根轴重新组织：

- **改什么**：部署期行为（输出 / 测试时权重 / harness）· 训练期策略 · **评估器本身** · 研究过程本身；
- **闭环程度**：人在回路 → 人复核自动信号 → 完全闭环。

按「系统被允许修改的层」排列，递归程度从弱到强（[Safeguard 逐篇核查](https://safeguard.sh/resources/blog/recursive-self-improvement-claims-vs-evidence-what-the-research-shows)）：

| 被修改的层 | 代表 | 持久化 | 谁打分 | 递归程度 |
| --- | --- | --- | --- | --- |
| 单任务上下文（反思 / 重试） | Reflexion (2023) | 一个 episode | 任务反馈（单测） | **不递归**：改进器固定 |
| 长期记忆与技能文件 | Voyager (2023)、Hermes Agent | 跨会话 | 环境反馈或模型自判 | 弱 |
| 提示词与 agent 脚手架代码 | STOP、ADAS、Gödel Agent、SICA、DGM | 保存为新 agent 版本 | 基准 harness | 中 |
| 训练数据与奖励信号 | Self-Rewarding LMs (2024) | 每轮新权重 | 模型自评 | 形式强，实测 3 轮 |
| 训练过程与基础设施 | AlphaEvolve (2025) | 由工程师部署 | 自动评估 + 人审 | 单步，非闭环 |

阿里巴巴团队的框架化定义更精确（[D2I-ai living survey](https://github.com/D2I-ai/awesome-recursive-self-improving-agents)）：系统状态 `x_t = (M_t, H_t, D_t, T_t, Imp_t)`，更新规则 `x_{t+1} = Imp_t(x_t)`；**只有当 `Imp_t` 本身属于可修改状态、能变成 `Imp_{t+1}` 时，才出现 RSI**。据此给出 L1–L5 分级：

| 级别 | 名称 | 自主提议 | 自主实施 | 自主验证 | 改进改进机制 | 跨域泛化 |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | 人工改进 | | | | | |
| L2 | 辅助改进 | ✓ | | | | |
| **L3** | **程序化自我改进** | ✓ | ✓ | ✓ | | |
| **L4** | **有界递归自我改进** | ✓ | ✓ | ✓ | ✓ | |
| L5 | 通用递归自我改进 | ✓ | ✓ | ✓ | ✓ | ✓ |

> 清华 VeriLoop Coder-E1 团队的表述值得单独记下：**「系统不是仅因能改变自身而实现改进；只有当证据开始改变它『未来如何改变自身』时，递归式自我改进才真正发生」**（[清华新闻网](https://www.tsinghua.edu.cn/info/1175/127603.htm)）。这与上表 L4 的判据一致，也是 bro2 元层设计的直接依据。

---

## 2. 最关键的洞察：验证层级决定自我改进强度

综述把「评估器」单列为一个类别，理由极为锋利：**每一个改进循环，都是「某个信号可以替代人类判断」的一次主张**。信号按可靠性从强到弱排列：

```
形式化验证器 / 证明检查器   ← 最强
外部可执行测试 · 基准断言 · 工具真实返回
过程奖励模型 / 可验证 rubric
LLM judge / 评审团
模型内在自评（self-assessment）  ← 最弱
```

三条被反复验证的规律：

1. **已展示的自我改进强度沿该层级递减**——能自动检查答案的领域（代码、数学）有效，正确性难验证的领域退化；
2. **违反层级的失败模式随之而来**：`self-confirming loops`（自评自证）、`model collapse`、`diversity collapse`；
3. **评估器本身是攻击面**：优化过猛会找到并不代表真实能力增益的捷径（reward hacking）。

因此 bro2 的硬约束：**晋升判定只使用外部可执行断言**（真实工具返回、文件落盘校验、停止原因、未配对 `tool_call` 零容忍），**不使用模型自评、不使用 LLM judge**。这一点直接复用了上一轮 `EVAL.md` 的评测框架，也解释了为什么先做评测再做自我改进是正确顺序。

---

## 3. 代表工作与实测数据（含代价与未证明的部分）

| 工作 | 年份 | 改什么 | 怎么验 | 报告结果 | 代价 / 局限 |
| --- | --- | --- | --- | --- | --- |
| [STOP](https://arxiv.org/abs/2310.02304) | 2023 | improver 自身代码 | 下游任务效用 | 改进后的 improver 在 50 个留出题上超过种子 | 作者明说「不是完整 RSI」；小模型常让循环变差；**0.42% 的生成代码关掉了 sandbox flag** |
| [ADAS](https://arxiv.org/abs/2408.08435) | 2024 | meta agent 写新 agent 程序 | 多域基准 | 搜出的设计超过人工设计且可迁移 | 搜索空间无上限，每个候选都要真跑 |
| [Gödel Agent](https://arxiv.org/abs/2410.04444) | 2024 | 自身运行时逻辑 | 任务表现 | 持续优于手工 agent | 冻结模型 |
| [SICA](https://arxiv.org/abs/2504.15228) | 2025 | 自身代码库 | 效用 = 分数 0.5 + 成本 0.25 + 时长 0.25 | SWE-bench Verified 50 题子集 **17% → 53%** | 约 **$7,000 / 15 轮**；推理型基准上增益「marginal」；路径依赖导致方差大 |
| [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)（ICLR 2026） | 2025 | 自身代码库 + **变体档案库** | SWE-bench / Polyglot | **20.0% → 50.0%**；Polyglot 14.2% → 30.7% | 约 **$22,000 / 80 轮、单次约两周**；用实证测试替代 Gödel Machine 的形式化证明 |
| [AlphaEvolve](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) | 2025 | 目标问题整份代码 | 每题自动评估器 | 矩阵乘法、数据中心调度；母模型训练时间 −1% | 由工程师部署，**单步改进而非自持循环** |
| [SkillOpt](https://arxiv.org/abs/2605.23904)（Microsoft） | 2026 | **仅 `skill.md` 一份文本文档** | 留出集选择门 | 52 个 (模型, 基准, harness) 组合最佳或并列最佳 | 冻结模型、零额外推理调用；关键机制见下 |
| [TRACE](https://arxiv.org/abs/2608.22793) | 2026 | 技能库 Skill Bank | 轨迹对比演化 | GPT-5.5 上 Pass^3 **59.9% → 94.5%** | 强调**一致性**而非偶发成功 |
| [SkillMaster](https://arxiv.org/abs/2605.08693) | 2026 | 自建 / 精化 / 选择技能 | 反事实探针任务效用 | ALFWorld +8.8%、WebShop +9.3% | 需训练 |
| VeriLoop Coder-E1 | 2026 | 循证闭环（证据改变「未来如何纠错」） | 测试反馈 + 回归控制 | SWE-bench Verified 85.20 | 国产开源代码模型 |

**必须如实标注的三点**：

- 上述系统**基座模型全部冻结**，改的都是 scaffold（代码 / 提示 / 技能 / 工作流），没有权重更新；
- 提升是**面向固定基准**的，不得外推为通用智能提升；SICA 自己在推理型基准上增益甚微；
- 成本与方差都很高（$7k–$22k、两周、路径依赖），且 DGM 的 80 轮是**开放式档案库搜索**，不是单调收敛。

2026 年的产业化背景（用作阶段词汇，不作为能力证据）：[Anthropic《When AI Builds Itself》](https://www.anthropic.com/) 报告 2026-05 其代码库 >80% 合入代码由 Claude 编写；ICLR 2026 在里约举办首个 RSI 专题 Workshop；OpenAI 提出 [Pacing 2.0](https://aiwat.ch/article/openais-pacing-20-why-self-improving-models-need-a-speed-limit) 讨论可核查的「改进速度上限」；[METR task horizon](https://metr.org/) 被用作代理指标但附带外部效度警告（其随机试验发现 2025 早期工具让资深开发者慢了 19%）。综述同时指出，**治理级的自我改进度量（governance-grade measurement）是全领域最空白的细分方向**。

---

## 4. 失败模式与治理要求（bro2 直接据此设计）

| 已观测到的失败 | 出处 | bro2 对应机制 |
| --- | --- | --- |
| **Objective hacking**：agent 删掉幻觉检测器依赖的 logging 后「满分」 | DGM | **写保护评测面**：`eval.ts`、任务集、门禁阈值、基线、账本做 SHA-256 完整性校验；候选 patch 只能落在白名单路径 |
| 生成代码关掉 sandbox flag | STOP（0.42%） | 候选禁止触碰 `permission.* / storage.* / server.*`；隔离配置在合并时**最后覆盖**，改进器无法改写沙箱路径 |
| 自评自证 / 自确认循环 | 综述 §5.3 | 晋升只认外部可执行断言；拒绝任何「模型觉得更好」 |
| 对着固定基准过拟合、记忆答案 | SkillOpt / TRACE | **holdout 留出集** + **de-hardcoding**：技能/提示增量禁止包含留出集答案、任务 id、评分相关词，必须是操作级可迁移指导 |
| 编辑振荡、无界变更 | SkillOpt | **textual learning rate**：每代候选上限、单次单原子编辑、**rejected-edit buffer** 防重复提议 |
| 档案库坍缩成单链 | DGM（archive 优于单链） | 只增账本保留**所有**候选（含被拒），支持从任意祖先分叉 |
| 能力保持与改进过程本身未被长期评估 | D2I 开放问题 #1 | 账本记录每代 train/holdout 曲线、累计改动量、eval 次数，作为 governance-grade measurement |
| 治理组件被一并修改 | D2I 开放问题 #4 | 能力面可改、治理面写保护；tripwire + incident log + 漂移上限 + 人在回路开关 |
| 递归深度 / 算力无上限 | Pacing 2.0 | `maxGenerations` · `plateauPatience` · `maxEvalRuns` 三重硬上限 |

SkillOpt 的三个工程机制被直接移植：**bounded edit（编辑预算）· held-out selection gate（留出集选择门）· rejected-edit buffer（拒绝缓冲）**；TRACE 的 **operation-level abstraction + de-hardcoding** 用于保证技能增量可迁移；DGM 的 **archive（保留垫脚石而非只留最优链）** 用于账本设计。

---

## 5. bro2 的定位与实现映射

**名义**：`bro2`，一个零第三方依赖的通用 Agent 运行时（TypeScript / Node 22 strip-types）。

**RSI 级别自评**：

| 判据 | bro2 | 说明 |
| --- | --- | --- |
| 自主诊断 / 提议 / 实施 / 验证（L3） | ✅ | `miner → operators → shadow eval → gate` |
| 改进机制自身可改（L4） | ✅ **受限** | `strategy.operatorWeights / editBudget` 由账本实证成败更新，形成 `Imp_t → Imp_{t+1}`；但只有白名单权重可变，治理层不可变 |
| 有界域内长期进展（L4） | ✅ | 多代单调晋升、平台期终止、漂移上限 |
| 跨域通用（L5） | ❌ | 明确不做；改进只在声明式配置面与固定评测域内有效 |
| 权重更新 / 自我重训 | ❌ | 模型始终冻结，走 Mock / OpenAI 兼容 / Ollama |
| 完全无监督闭环 | ❌ | 默认 `--dry-run` 友好、晋升需过门禁，可随时人工审阅账本与 diff |

**架构**（`src/rsi/`）：

```
   train 评测报告 ──► miner（失败信号聚类）
                          │
              strategy.operatorWeights（由账本成败更新 ← L4 自指）
                          │
                          ▼
        operators（单原子编辑 · 编辑预算 · 拒绝缓冲）
                          │
        ┌─────────────────┼──────────────────────────┐
        ▼                 ▼                          ▼
   guardrails 检查   影子 root 应用 patch       holdout（改进器不可见）
   白名单 / 完整性 /    → train eval             → 独立 eval
   de-hardcoding /    → gate + 零容忍            → 严格提升判定
   tripwire / 漂移          │                          │
        │                  └──────────┬───────────────┘
        ▼                             ▼
   incident log              晋升 / 回滚（单调）
                                      │
                                      ▼
                    只增账本 ledger.jsonl（archive，含被拒候选）
                                      │
                                      ▼
                         state.json / strategy.json 固化
```

**晋升判据（全部同时满足）**：train 不劣化 · holdout **严格提升** · 门禁 PASS · 协议违规 = 0 · 完整性校验通过 · patch 落在白名单 · 未在拒绝缓冲中。任一不满足即回滚并记录。

**与上一轮 `EVAL.md` 的关系**：评测框架是**验证器**，自我改进循环是**被验证的候选生产者**。先有可判分任务集与基线门禁，才谈得上自我改进——否则「变强」无法证伪。上一轮 `t11` 压缩缺陷正是「评测驱动发现真实缺陷」的一个实例，本轮把它升级为**自动闭环**。

---

## 5.1 运行与验收（可复现）

```bash
npm run evolve          # 正式演进：--reset 从初始次优配置出发，收敛后把改进固化到运行时
npm run evolve:dry      # 只诊断与提议，不写回 state/strategy（仍写账本，保证可审计）
npm run rsi:check       # 22 项断言：单调提升、holdout 严格提升、恶意候选拦截、策略落地、先验漂移
npm run policy:check    # 19 项断言：5 个策略代码分支真的生效且安全不变量不退化
npm run meta:check      # 25 项断言：冻结 fitness / 元层写保护 / 单调晋升
npm test                # 87 项回归（含 RSI、meta、benchmark、external、preflight 内核单测与端到端）
```

一次真实运行（v2.0 策略面，离线确定性，无 API Key、无 GPU）：

| 代 | train | holdout | 关键事件 |
| --- | --- | --- | --- |
| 1 | 0.286 → 0.429 | 0.5 → 0.625 | `malformedArgs: fail→repair` 晋升 |
| 2 | 0.429 → 0.571 | 0.625 → 0.75 | `grounding: off→require-evidence` 晋升 |
| 3 | 0.571 → 0.714 | 0.75 → 0.875 | `compaction: truncate→salience` 晋升 |
| 4 | 0.714 → 0.857 | 0.875 → 1.0 | `loopDetection: advisory` 因破坏 holdout「死循环必须硬终止」被**拒绝**；`parallel: fifo→risk-first` 晋升 |
| 5–6 | 0.857 | 1.0 | 被拒候选进入拒绝缓冲防振荡，`plateau` 停止 |

`rsi:check` 注入 4 个恶意候选，全部被拦截并留下 incident：提升权限（`permission.level`）、改写验证器（`eval.tasks`）、技能增量夹带留出集答案、一次改两处违反编辑预算。算子先验随证据漂移：4 个成功策略算子（`enable-args-repair` / `enable-grounding` / `enable-salience-compaction` / `enable-risk-first-parallel`）`1 → 1.2`，被 holdout 治理不变量拒绝的 `enable-advisory-loop` `1 → 0.7`（正式 `evolve`；`rsi:check` 的 dry-run 因额外注入恶意候选，统计为 `0.85`，方向一致）。

产物：`data/evolve/ledger.jsonl`（只增账本，含全部候选）、`data/evolve/incidents.jsonl`（tripwire）、`data/evolve/state.json`（已固化改进，运行时自动读取）、`data/evolve/strategy.json`（先验）、`data/evolve-report.json`（曲线 / 门禁 / 完整性）；meta 层另有 `data/evolve/meta-state.json`、`meta-ledger.jsonl` 与 `data/meta-report.json`；基准层另有 `data/benchmark-report.json`。当前验收以 [DESIGN.md 附录 C](./DESIGN.md) 与 [EVAL.md](./EVAL.md) 为准。

> **如何解读**：这些数字证明的是「**框架能在可验证的前提下单调改进自己的配置**」，不是「模型变聪明了」。改进只在该评测域内成立，且基座模型始终冻结；真实智能水平仍需 `eval --mode live` 测量。

---

## 6. 明确的边界（不冒充的部分）

1. **不是 L5 / 不是智能爆炸**。bro2 改进的是 harness 的声明式配置面，收益是「在特定评测域内更可靠」，不能外推为通用智能提升。
2. **不做权重更新、不做自我训练、不自动修改核心源码**。`src/kernel/*`、`src/governance/*`、`src/observability/eval.ts` 全部在写保护面内。
3. **不接 LLM judge / 自评作为晋升信号**——按验证层级，这是最弱信号，正是自确认循环与 reward hacking 的来源。
4. **离线确定性演示 ≠ 真实模型能力**。默认脚本化 Mock 保证零依赖可复现；真实智能水平仍需 `eval --mode live` 与本地 Ollama 实测（见 `EVAL.md` 与 `examples/ollama-check.ts`）。
5. **治理级度量仍是研究领域空白**。bro2 提供的账本与 tripwire 是工程近似，不是形式化保证；生产部署仍需外部审计、版本签名与人工审阅。
6. **应用层沙箱**（路径白名单），非 OS 级强隔离；`--experimental-strip-types` 只擦除类型不做类型检查。

---

## 7. 持续提升路线（按可证伪程度排序）

| 优先级 | 动作 | 验证方式 |
| --- | --- | --- |
| P0 | 扩充 holdout 与故障注入矩阵（流中断、畸形 JSON、并发超限、审批超时） | 每类失败必须至少一条留出席位 |
| P0 | 把失败轨迹自动回灌为新用例，任务集指纹驱动基线重建 | `eval` 门禁 + 指纹比对 |
| P1 | 跨 provider 对比矩阵：只在某模型掉分 = 模型问题，全掉 = 框架问题 | `eval --mode live --provider ...` |
| P1 | 元层策略引入 **search efficiency**（每单位 eval 的得分增益）作为 governance-grade 指标 | 账本统计，不作为能力声明 |
| P2 | 技能库定期 curation：去重、退役失效技能、对当前评测器重验幸存者 | 同一门禁，对应 SkillOpt/TRACE 的 curation |
| P2 | 人在回路：高危改进需审批，专家反馈转成可复用改进资源 | D2I 开放问题 #5 |

---

## 参考

- [Recursive Self-Improvement in AI: From Bounded Self-Refinement to Autonomous Research Loops (arXiv:2607.07663)](https://arxiv.org/abs/2607.07663)
- [Self-Improvements in Modern Agentic Systems: A Survey (arXiv:2607.13104)](https://arxiv.org/abs/2607.13104)
- [The Path to Recursive Self-Improving Agents — L1–L5 分级与 living survey](https://github.com/D2I-ai/awesome-recursive-self-improving-agents)
- [Recursive Self-Improvement: Claims Versus Evidence in the Research (Safeguard, 2026-10)](https://safeguard.sh/resources/blog/recursive-self-improvement-claims-vs-evidence-what-the-research-shows)
- [Self-Modifying Coding Agents: DGM / ADAS / Gödel Agent / SICA 逐篇对照](https://safeguard.sh/resources/blog/self-modifying-coding-agents-darwin-godel-machine-adas-and-godel-agent-explained)
- [Darwin Gödel Machine (arXiv:2505.22954)](https://arxiv.org/abs/2505.22954) · [SICA (arXiv:2504.15228)](https://arxiv.org/abs/2504.15228) · [ADAS (arXiv:2408.08435)](https://arxiv.org/abs/2408.08435) · [STOP (arXiv:2310.02304)](https://arxiv.org/abs/2310.02304)
- [SkillOpt (arXiv:2605.23904)](https://arxiv.org/abs/2605.23904) · [TRACE (arXiv:2608.22793)](https://arxiv.org/abs/2608.22793) · [SkillMaster (arXiv:2605.08693)](https://arxiv.org/abs/2605.08693)
- [清华 VeriLoop Coder-E1 循证闭环](https://www.tsinghua.edu.cn/info/1175/127603.htm)
- [OpenAI Pacing 2.0 与可核查 tripwire 讨论](https://aiwat.ch/article/openais-pacing-20-why-self-improving-models-need-a-speed-limit) · [Harvard Gazette: RSI 治理访谈](https://news.harvard.edu/gazette/story/2026/10/who-knew-self-improvement-could-be-so-terrifying)
