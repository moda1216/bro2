# bro2 · 演进路线图（ROADMAP · P0–P5）

> 把"如何持续让 bro2 进化、并真正验证其业界水平"拆成 6 个受管理的工作流。
> 每个工作流含：**目标 / 输入 / 产出物（deliverable）/ 验收标准 / 依赖 / 状态 / 论文依据**。
> 论文依据均为真实存在的前沿工作（详见 [docs/RSI-NEXT.md](./docs/RSI-NEXT.md)）。
> 配套：产出物登记见 [DELIVERABLES.md](./DELIVERABLES.md)，发布记录见 [CHANGELOG.md](./CHANGELOG.md)。

**核心约束（治理红线，所有 P 不可违反）**：冻结权重、不训练、不更新模型参数；RSI 只演进 **harness（Agent OS）** 本身。所有能力增益必须在**冻结模型**下成立，且经 [DELIVERABLES.md §5](./DELIVERABLES.md) 验收门禁校验。

**诚实边界**：`leadership.verdict = not-proven` 直到 P5 完成且第三方复现通过。P0–P4 全部可在冻结模型下推进；唯独 **P5 需要外部基准数据 / 第三方复现**，bro2 单方面无法凭空生成——但 P0 的免费 API + P3 的 OOD 通道已把"拿不到真实分数"从"不可能"变成"一行命令 + 一份基准 JSON"。

---

## P0 · 用免费 API 跑真实强模型评测

- **目标**：拿到 bro2 在**真实强模型**（非 0.5B 小模型）上的第一份有效分数，证明"本地算力不足 ≠ 无法验证业界水平"。
- **输入**：`agentos.config.json`（已接 5 家免费 provider）、`npm run free:probe`（5 家可达）、用户提供一个免费 Key（多数免信用卡，如 OpenRouter）。
- **产出物**：
  - 真实评测报告 `data/eval-live-report.json`（provider/model 实测，与确定性报告隔离）。
  - ≥1 个真实 provider 的对比快照。
- **验收标准**：
  - `AGENTOS_LIVE_PROVIDER=<某免费API> npm run eval:live` 跑通，preflight 门禁 6/6 通过。
  - 报告字段完整、`protocolViolations` 记录真实、不出现 `verdict=proven`。
- **依赖**：用户提供一个免费 API Key（沙箱已验证网络可达，只差 Key）。
- **状态**：🔲 待用户供 Key 后执行（代码/配置/探针已就绪）。
- **论文依据**：所有（这是验证"业界水平"的前提动作）。

```bash
npm run free:probe                                  # 确认 5 家可达
# 填入 KEY 后：
AGENTOS_LIVE_PROVIDER=openrouter OPENROUTER_API_KEY=sk-... npm run eval:live
```

---

## P1 · 对比式改进接入 live RSI（开放世界、无真值）

- **目标**：把 `src/rsi/contrast.ts`（HARNESS² 的 Propose–Probe–Compose）接入 `evolve --live`，实现**无真值 verifier** 也能在开放世界持续自改进。
- **输入**：`src/rsi/contrast.ts`（已实现纯函数版，9 单测通过）、`src/rsi/loop.ts`（有界 RSI 主循环）、`bin/agentos.ts evolve` 子命令。
- **产出物**：
  - `evolve --live` 模式：基线轮 vs 探测轮的行为对比判定改动是否真修好某失败模式。
  - 新增 `tests/contrast-live.test.ts` 实证在真实模型反馈下不靠真值标签收敛。
- **验收标准**：
  - `contrast` 接受"修复了具体失败模式"的改动、拒绝"仅提升分数但无解"的改动（防 reward hacking）。
  - 接入后 `npm run rsi:check` 仍 22/22，新增 live 分支单测全绿。
- **依赖**：P0（真实模型反馈作为探针信号源，可选；也可先用 Mock 闭环验证）。
- **状态**：🟡 模块已实现，待接入主循环。
- **论文依据**：**HARNESS²**（arXiv 2610.14224，Google+Northwestern）。

---

## P2 · 经验库 EXPERIENCE.md 沉淀（harnessing 级递归）

- **目标**：把"为什么这次改动有效"沉淀为**可复用的 harness 编辑组件 + 适用条件**，指导下一次 harnessing（HARNESS² 的第二级递归）。
- **输入**：`src/rsi/ledger.ts`（只增账本，记录每次候选与结果）、`src/rsi/meta.ts`（元层先验）。
- **产出物**：
  - `data/rsi/experience.jsonl`：结构化经验（编辑片段、触发条件、效果、失效情形）。
  - `src/rsi/experience.ts`：经验检索与复用（在 Propose 阶段按任务匹配历史有效编辑）。
- **验收标准**：
  - 经验库在 evolve 多轮后累积且只增；新任务能检索到相关历史编辑并提升首轮成功率。
  - 不引入"记忆特定任务集"的过拟合（与 P3 的 OOD 通道协同）。
- **依赖**：P1（对比式改进产生的"有效/无效"判定是经验来源）。
- **状态**：🔲 待建。
- **论文依据**：**HARNESS²**（Experience Reflector → `EXPERIENCE.md`）。

---

## P3 · RRSI 正则：退火预算 + Critic/Pruner + OOD 校验通道

- **目标**：防止 RSI **过拟合留出集**（分布内暴涨、分布外归零）；为"缺公开基准"缺口提供供给侧解法。
- **输入**：`src/rsi/loop.ts`（editBudget）、`src/rsi/guardrails.ts`（治理不变量）、`src/rsi/operators.ts`（编辑算子）。
- **产出物**：
  - `editBudget` 自适应（时间退火，限制每次捆绑编辑数、鼓励探索未试轨迹）。
  - `Critic`（筛掉基准特定提议）+ `Pruner`（删太小/太贵/无用的改动）。
  - **OOD 校验通道**：除 train/holdout 外新增"未见任务集"，度量迁移性（对应 `leadership.verdict` 中缺失的泛化证据）。
- **验收标准**：
  - 在 train/holdout 提升的同时，OOD 任务集不退化（分布内 +、OOD +）。
  - `guardrails` 写保护不变量不被预算机制绕过。
- **依赖**：P1（对比式判定是 Critic 的输入）。
- **状态**：🔲 待建。
- **论文依据**：**RRSI**（arXiv 2609.24972，Google；分布内 +14.1、OOD +4.7，少 30% 策略 token）。

---

## P4 · OO-Harness：harness 类族 + HarnessRouter

- **目标**：从"1 个全局 harness + 4 个 Preset"进化为**可继承的 harness 类层次**，测试期由 router 按任务选子类。
- **输入**：`presets/*.json`（可迁移 harness 片段）、`src/runtime/policy.ts`（行为策略分派）、`src/cognition/preset.ts`。
- **产出物**：
  - `src/cognition/harness-family.ts`：`base` harness（受保护不变式）+ 各任务簇子类（只 override 白名单维度，对应 `ALLOWED_EXACT_PATHS` / `ALLOWED_PREFIXES`）。
  - `HarnessRouter`：训练期积累"哪类任务用哪个子类"的路由经验，测试期按任务选择。
- **验收标准**：
  - 子类化相比扁平 harness 在跨任务基准上有可测增益（OO-Harness：AutomationBench 61.6→77.4、Workspace-Bench 25.5→39.5）。
  - 基类治理不变量在子类 override 后仍受 `guardrails` 保护。
- **依赖**：P2/P3（经验库与 OOD 通道为 router 提供路由经验）。
- **状态**：🔲 待建（Preset 已是基类候选）。
- **论文依据**：**OO-Harness**（arXiv 2610.28380，Google Cloud AI Research；继承本身 +4.96 分）。

---

## P5 · 公开基准对齐 → L4 partial（证明领先的前置条件）

- **目标**：把 BFCL / τ-bench / GAIA / SWE-bench 的**真实数值**导入 `data/benchmark/external-results.json`，使证据阶梯 L4 从 `not-achieved` 升为 `partial`。
- **输入**：`src/benchmark/external.ts`（白名单校验器：真实日期、可复现命令、禁止自报 verdict）、`src/benchmark/ladder.ts`（阶梯计数）。
- **产出物**：
  - `data/benchmark/external-results.json`：经 `external:check`（38/38）校验的真实基准记录。
  - `benchmark-report.json` 的 L4 段从 `not-achieved` 更新为 `partial`，`verdict` 仍为 `not-proven`（需第三方复现才升 `proven`）。
- **验收标准**：
  - 每条记录经 `npm run external:check` 校验通过（字段白名单、score∈[0,1]、date≤today、可执行 repro cmd、无自报 verdict）。
  - 第三方用其真模型跑同一条 `npm run eval:live` 可复现量级。
- **依赖**：P0（真实模型分数）+ P3（OOD 通道，提供泛化证据）。
- **状态**：🔲 待建（校验器与阶梯计数已就绪，缺外部真实数据）。
- **论文依据**：全部（这是"业界水平"的可证伪落点）。

---

## 优先级与依赖总览

```
P0 ──▶ P1 ──▶ P2 ──┐
        │           ├──▶ P4 ──▶ P5
        └──▶ P3 ────┘
依赖：P0(真实分数) → P1(live RSI) → P2(经验) / P3(OOD)
     P2+P3 → P4(类族) → P5(L4 升 partial)
```

| 优先级 | 工作流 | 论文 | 状态 | 是否需外部数据 |
| --- | --- | --- | --- | --- |
| **P0** | 免费 API 真实评测 | 全部 | 🔲 待供 Key | 需 1 个免费 Key |
| **P1** | live RSI（对比式） | HARNESS² | 🟡 模块就绪 | 否 |
| **P2** | 经验库 EXPERIENCE.md | HARNESS² | 🔲 待建 | 否 |
| **P3** | RRSI 正则 + OOD 通道 | RRSI | 🔲 待建 | 否 |
| **P4** | OO-Harness 类族 + Router | OO-Harness | 🔲 待建 | 否 |
| **P5** | 公开基准对齐 L4 | 全部 | 🔲 待建 | 需外部基准数据 |

> 一句话：**P0 把"能不能跑真模型"变成一行命令；P1–P4 在冻结模型下持续进化 harness；P5 用真实基准数据把 not-proven 往前推一步。**
> 当前 v2.0.0 已完成"证明 bro2 能持续进化且诚实"的基础，P0–P5 是通向"可证伪的业界领先"的工程路径。
