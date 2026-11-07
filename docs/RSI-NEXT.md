# bro2 · RSI 演进路线图（对齐 2025–2026 学界前沿）

> 用户原问：「本地跑不了大模型，是不是就完全无法验证 bro2 的业界水平？」
> 答：**不是**。两条路径都成立——（A）免费 LLM API（见 `FREE-LLM-APIS.md`）
> 让 bro2 在真实强模型上跑 `eval:live`；（B）harness 工程质量本身可由 RSI 在冻结模型下持续进化，
> 而下面四篇论文正好给了可落地的进化机制。
>
> 本文把四篇**真实存在**的论文逐篇映射到 bro2 的下一步，标注「已实现 / 已实现模块 / 待接入」。

---

## 0. 现状（已完成）

| 能力 | 状态 | 落点 |
|---|---|---|
| 有界可验证 RSI（holdout 严格提升 + 写保护 + 只增账本） | ✅ 已实现 | `src/rsi/loop.ts` `guardrails.ts` |
| 元 RSI（改进机制自身由实证成败更新） | ✅ 已实现 | `src/rsi/meta.ts` `types.ts` MetaState |
| 行为策略真实分支迭代（loopDetection / grounding / parallel…） | ✅ 已实现 | `evolve` + `policy-check` |
| 真实推理基础设施（本地 llama.cpp + preflight 门禁） | ✅ 已实现 | `tools/local-llm-server.py` `src/models/preflight.ts` |
| 对比式改进 Propose–Probe–Compose | ✅ 已实现模块 | `src/rsi/contrast.ts` + `tests/contrast.test.ts` |
| 免费 API 多 provider 接入 | ✅ 已接入配置 | `agentos.config.json` + `examples/free-api-probe.ts` |

---

## 1. HARNESS² — 递归式 Agent Harnessing（arXiv 2610.14224）

- **谁**：Google Cloud AI Research + Northwestern（2025-10，Apache-2.0 开源）。
- **核心**：两级递归——
  - *任务级*：Propose–Probe–Compose 对比式步骤，**无真值 verifier** 也能迭代（配对条件跑改动，只看行为对比）；
  - *Harnessing 级*：Experience Reflector 把"为什么这次改动有效"沉淀进 `EXPERIENCE.md` 经验库，指导未来 harnessing。
- **对 bro2 的帮助（高）**：
  1. `src/rsi/contrast.ts` 已落地 Propose–Probe–Compose 的纯函数版——基线 vs 探测两轮的行为对比，不需要真值标签，且天然防 reward hacking（只接受修复了具体失败模式的改动）。
  2. **下一步**：把 `EXPERIENCE.md` 经验库接进 bro2 的 `Ledger`——当前 `evolve` 的"先验更新"只更新算子权重，可扩展为"可复用的 harness 编辑组件 + 适用条件"的经验沉淀，实现 HARNESS² 的 harnessing 级递归。
  3. HARNESS² 用 Claude Opus 作 editor、GLM-5/Gemini 作 executor：**印证 bro2 "冻结模型、只演进 harness" 的路线是学界主流方向**。

---

## 2. Evo² — Weight–Harness 共进化（arXiv 2610.13025）

- **谁**：Google DeepMind（Chejian Xu 等）。
- **核心**：双角色 Proposer/Reflector（同一策略既提 harness 编辑、又诊断效果）；EvoTIDE 训练管线（SFT + 交错 GRPO）。
  - 关键数据点：**仅 harness 改进就把 GPT-5-mini 从 24.4% 提到 48.3%（SWE-bench Verified）**；演化出的 harness 可跨任务迁移。
- **对 bro2 的帮助（极高，且是"路线辩护"）**：
  1. Evo² 证明**哪怕完全不更新权重，仅 harness 演进就能带来数量级增益**——这正是 bro2 明确"不做权重更新"立场的硬证据。bro2 可理直气壮地宣称：harness 工程质量是 Agent 能力的第一杠杆。
  2. "演化的 harness 跨模型/跨任务迁移" → bro2 的 Preset + BehaviorPolicy 已是"可迁移 harness 片段"，可作为 OO-Harness（见下）的基类。
  3. bro2 的边界是**冻结权重 + 不训练**（无 EvoTIDE 的 GRPO 训练）。这是刻意的治理选择（可审计、可复现、不漂移），与 Evo² 的"共进化"互补而非冲突。

---

## 3. RRSI — 正则化递归自我改进（arXiv 2609.24972）

- **谁**：Google（Yanfei Chen, Chen-Yu Lee, Tomas Pfister 等，2026-09）。
- **核心**：给 RSI 加正则，防止**过拟合训练任务**——分布内暴涨、分布外归零。
  - 机制：Proposer 用**时间退火预算**（限制每次捆绑的编辑数）+ 鼓励探索未试轨迹；Selector 配 Critic（筛掉基准特定提议）+ Pruner（删太小/太贵/无用的改动）。
  - 结果：分布内 +14.1，OOD +4.7，且比无正则演化少 30% 策略 token。
- **对 bro2 的帮助（高，正好补当前短板）**：
  1. bro2 的 `evolve` 在确定性 19/19 上**有过拟合留出集的风险**（易记忆任务集）。RRSI 的退火预算 + Critic/Pruner 可直接映射为 bro2 的 `editBudget` 自适应 + 一个"删除基准特定 skill overlay"的 Pruner。
  2. **下一步**：在 `evolve` 增加 OOD 校验通道——除 train/holdout 外，加一个"未见任务集"用于检测迁移性，对应 RRSI 的 OOD 增益度量。这正是 bro2 `leadership.verdict=not-proven` 中"缺公开基准"缺口的供给侧解法。

---

## 4. OO-Harness — 面向对象 Harness（arXiv 2610.28380）

- **谁**：Google Cloud AI Research（Gaotang Li, UIUC 等）。
- **核心**：不维护**单一全局 harness**，而是演化出一棵**可继承的专用 harness 类层次**；测试时由 router 按任务选子类。
  - 结果（同款 Gemini 3.5 Flash 执行器）：AutomationBench 61.6%→77.4%，Workspace-Bench 25.5%→39.5%。
  - 关键发现：**继承本身有价值**——子类化比把同样代码铺平成扁平类高 4.96 分。
- **对 bro2 的帮助（高，架构级）**：
  1. bro2 当前是"1 个全局 harness + 4 个 Preset"。OO-Harness 建议进化为**harness 类族 + router**：
     - `base` harness = 当前默认 BehaviorPolicy + budget；
     - 各 Preset 作为 `base` 的子类，只 override 自己任务簇需要的维度；
     - 新增 `HarnessRouter`：训练期积累"哪类任务用哪个子类"的路由经验，测试期按任务选择。
  2. 这与 bro2 的"写保护治理"天然契合：基类是受保护不变式，子类只 override 能力面的白名单维度（正好对应 `ALLOWED_EXACT_PATHS` / `ALLOWED_PREFIXES`）。

---

## 5. 综合路线图（按性价比排序）

| 优先级 | 动作 | 论文依据 | 落点 |
|---|---|---|---|
| P0 | 用免费 API 跑真实强模型 `eval:live`（OpenRouter/NIM 等） | 所有 | `FREE-LLM-APIS.md` + `free:probe` |
| P1 | `evolve --live`：把 `contrast.ts` 接入开放世界 live RSI（无真值） | HARNESS² | `src/rsi/contrast.ts` → `loop.ts` |
| P2 | 经验库 `EXPERIENCE.md` 沉淀"可复用 harness 编辑 + 适用条件" | HARNESS² | 扩展 `Ledger` |
| P3 | RRSI 正则：退火预算 + Critic/Pruner + OOD 校验通道 | RRSI | `evolve` + `guardrails.ts` |
| P4 | OO-Harness：harness 类族 + `HarnessRouter` | OO-Harness | `Preset` → 可继承层次 |
| P5 | 公开基准对齐（BFCL/τ-bench/GAIA/SWE-bench）→ L4 partial | 全部 | `data/benchmark/external-results.json` |

> 诚实边界：P0–P4 均可在**冻结模型、不更新权重**下推进（bro2 的治理红线）；
> 唯独 P5 需要外部基准数据或第三方复现，无法由 bro2 单方面凭空生成——
> 但 P0 的免费 API + P3 的 OOD 通道已把"拿不到真实分数"的问题从"不可能"变成了"一行命令 + 一份基准 JSON"。
