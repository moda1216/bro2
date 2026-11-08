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
- **状态**：🟡 **部分完成**——无 Key 通路已打通（`pollinations` 实测 25% / 0 协议违规；`kilo` 实测支持原生 tool_calls），但「带强 Key 的 120B+ 模型横向对比」仍待用户供 Key。
- **论文依据**：所有（这是验证"业界水平"的前提动作）。

```bash
npm run free:probe                                  # 确认 5 家可达（含无 Key 的 kilo / pollinations）
# 无 Key 即跑：
AGENTOS_LIVE_PROVIDER=kilo npm run eval:live
# 带强 Key 后：
AGENTOS_LIVE_PROVIDER=openrouter OPENROUTER_API_KEY=sk-... npm run eval:live
```

---

## P0.5 · 混合推理：本地 + 远程协同，降低远程调用（本轮新增）

> 用户原问："本地部署的模型和远程模型 API 可以怎么配合，减少远程模型的调用次数？"
> 这不只是省钱——它是 **远程强模型 API 反向优化 bro2** 的核心机制。

- **目标**：把"本地小模型（llama.cpp，零成本零限流）"与"远程强模型（免 Key 端点/付费 API）"组合，
  在**不牺牲任务能力**的前提下，显著减少打到远程的调用次数，同时提升在远程限流下的韧性。
- **已交付（v2.0.3，已含单测 + 真实演示）**：
  - `src/models/cache.ts` · `CachedProvider`：透明响应缓存，相同 `(model+messages+tools+temperature)` 命中即零调用。
  - `src/models/hybrid.ts` · `HybridProvider`：① 缓存优先 ② 启发式路由（`cheap-to-local`：无工具/工具结果整理走本地，需推理走远程）③ 限流降级（远程 `429/5xx` 自动转本地而非失败）。
  - `agentos.config.json` 的 `hybrid` provider（`remote=kilo`, `local=local-qwen`），及 `kilo`/`opencode-zen`/`llm7` 三个无 Key 端点。
  - `eval:live` 报告新增 `inference` 指标：`remoteCalls / localCalls / cacheHits / remoteAvoided / remoteCallRatio`。
  - `npm run hybrid:demo` 实测：`remoteCalls=1 / localCalls=2 / cacheHits=4 / remoteAvoided=4`，**远程占比 100%→14.3%**。
- **已交付（v2.0.4 · 无 Key 端点统一聚合器，对应本轮"所有远程无 Key 端点应统一智能管理"）**：
  - `src/models/keyless.ts` · `KeylessAggregator`：把 `kilo` / `pollinations` / `opencode-zen` / `keylessai`(统一网关) / `llm7` 等免 Key 上游**聚合成唯一 OpenAI 兼容接口**，对标 KeylessAI / Zerogateway 的统一路由器设计。
  - 四类智能管理机制：① 健康评分路由（smart-fallback，综合优先级/失败/限流/延迟/成功率打分）② 限流感知故障转移（429/FreeUsageLimit/5xx 自动切上游）③ 能力感知（不支持工具的上游在带 tools 请求中跳过）④ 应急兜底（全部失败降级到 `emergencyProvider` 本地小模型）。
  - `agentos.config.json` 新增 `keyless` 聚合器（`autoDiscoverKeyless:true` 自动纳入所有免 Key 已注册 provider）+ 上游 `keylessai`、`zerogateway`(路由思路)、`dsv41-flash`/`kimi-k3`/`glm-53`(DeepSeek-Harness 插件免 Key 模型，填 `OUR_FREE_MODEL_BASE_URL` 即接入)；`tests/keyless.test.ts`（10 项）、`npm run keyless:demo`（离线故障转移演示）。
  - 调用侧只需 `AGENTOS_LIVE_PROVIDER=keyless`，单点限流/宕机被智能故障转移吸收，bro2 不再感知背后是哪家端点。
  - **与 P0 的关系**：聚合器把"无 Key 端点很多但各自不稳定"收敛为一个高可用的单一强模型来源，直接强化 P0 的"一行命令跑真实模型"——且免去为单家端点限流而手忙脚乱。
  - **与 P0.5 的关系**：`hybrid.remote` 可指向 `keyless`（整个免 Key 网状作为远程侧），两层正交叠加：聚合器解决"远程侧可用性"，hybrid 解决"远程侧开销"。
- **已交付（v2.0.5 · 双层叠加 `hybrid.remote → keyless`，对应本轮"免 Key 网状 + 本地协同双层叠加"）**：
  - `hybrid.remote` 从 `kilo` 改为 `keyless` 聚合器：外层 Hybrid 管「远程开销」（便宜/重复调用拦在本地+缓存），内层 KeylessAggregator 管「远程可用性」（单点限流/宕机吸收为故障转移），两层正交叠加，调用侧仍只见一个 `hybrid` 接口。
  - `src/index.ts` 修复组合根装配顺序（keyless/cached 先于 hybrid），使嵌套依赖不再依赖配置书写顺序；`src/models/resolve.ts` 抽出可复用的递归端点穿透（`resolveLeaves / leafEndpoints / probeTargets`），`preflight` / `eval:live` 门禁共用；`doctor` 递归展示 `hybrid→keyless→上游`；`inferenceStats` 新增 `remoteDetail`（网状明细）。
  - `tests/nested-hybrid-keyless.test.ts`（8 项）+ `npm run hybrid:keyless:demo`（离线：4 任务仅 1 次穿透远程网状，`remoteCallRatio=0.25`，含 1 次限流故障转移）。
- **下一步（待建）**：
  - **P0.5-a 本地小模型当分类器**：用本地模型对每轮请求做"该走本地还是远程"的分类，替代启发式，提升路由精度。
  - **P0.5-b 语义/近似缓存**：对 Near-duplicate 提示做 embedding 相似度匹配，扩展命中面（当前是精确匹配）。
  - **P0.5-c 闭环到 RSI**：把 `remoteAvoided↑ 且分数不降` 作为对比式改进（P1）的一条真实目标，让混合推理持续自我优化。
- **验收标准**：`npm run hybrid:demo` / `hybrid:keyless:demo` 与 `tests/{cache,hybrid,nested-hybrid-keyless}.test.ts` 全绿；`eval:live --provider hybrid` 报告含非空 `inference` 字段。
- **依赖**：P0（真实远程端点作为 `remote` 一侧）。
- **状态**：🟢 **双层叠加已交付（v2.0.5）**；P0.5-a/b/c 待建。
- **论文依据**：**HARNESS²**（Propose–Probe–Compose 的"用更便宜的执行验证改动"思想）、**Evo²**（仅改 harness 即可放大模型有效能力）。

---

## P1 · 对比式改进接入 live RSI（开放世界、无真值）

- **目标**：把 `src/rsi/contrast.ts`（HARNESS² 的 Propose–Probe–Compose）接入 `evolve --live`，实现**无真值 verifier** 也能在开放世界持续自改进。
- **输入**：`src/rsi/contrast.ts`（已实现纯函数版，9 单测通过）、`src/rsi/loop.ts`（有界 RSI 主循环）、`bin/agentos.ts evolve` 子命令。
- **产出物**：
  - `evolve --live` 模式：基线轮 vs 探测轮的行为对比判定改动是否真修好某失败模式。
  - 新增 `tests/contrast-live.test.ts` 实证在真实模型反馈下不靠真值标签收敛。
- **已交付（v2.0.5 · 对比式改进接入 live 闭环）**：
  - `src/rsi/live-contrast.ts`：`toRunSummary / baselineFromRuns`（真实 `EvalRunMetrics` 轨迹 → 行为摘要）、`evaluateLiveCandidates`（Propose–Probe–Compose 判定）、`LiveContrastVerifier`（多轮累积 + 收敛 + 完整性）。**候选自报分数 `scoreGain` 绝不参与判定**——只抬分数没修复失败模式的伪修复被判为 reward hacking 拒绝；全程 `usedGroundTruthVerifier=false`。
  - `tests/contrast-live.test.ts`（9 项：接受真修复 / 拒绝伪修复 / 协议违规直接拒 / 多轮收敛 / 完整性 OK）；`examples/contrast-live.ts` + `npm run contrast:live`（用真实 fault 任务轨迹演示 2 晋升 / 2 拦截），纳入 `project:status` 第 10 道发布门禁。
- **验收标准**：
  - `contrast` 接受"修复了具体失败模式"的改动、拒绝"仅提升分数但无解"的改动（防 reward hacking）。✅ 已实证
  - 接入后 `npm run rsi:check` 仍 22/22，新增 live 分支单测全绿。✅ `npm test` 131/131
- **依赖**：P0（真实模型反馈作为探针信号源，可选；也可先用 Mock 闭环验证）。
- **状态**：🟢 **核心闭环已交付（v2.0.5，确定性轨迹实证）**；`evolve --live` 完整编排（真实强模型反馈下自动 Propose 编辑）仍待 P0 强 Key 后推进。
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
P0.5(混合推理) 横切 P0–P4：用本地小模型承接便宜/重复调用，降低远程开销并提升韧性
P0.5(统一聚合器 v2.0.4)：把多个免 Key 端点聚合成唯一高可用接口，故障转移吸收单点限流/宕机
P0.5(双层叠加 v2.0.5)：hybrid.remote→keyless，聚合器管可用性 / hybrid 管开销，正交叠加
P1(对比式改进 live 闭环 v2.0.5)：contrast 接入真实轨迹，scoreGain 不参与判定（防 reward hacking）
依赖：P0(真实分数) → P1(live RSI) → P2(经验) / P3(OOD)
     P2+P3 → P4(类族) → P5(L4 升 partial)
     P0.5-a/b/c 可独立于 P1–P4 推进（纯 harness 工程优化）；统一聚合器 + 双层叠加 + P1 闭环已交付
```

| 优先级 | 工作流 | 论文 | 状态 | 是否需外部数据 |
| --- | --- | --- | --- | --- |
| **P0** | 免费 API 真实评测（无 Key 通路已通） | 全部 | 🟡 无 Key 已跑通；强 Key 对比待供 | 无 Key 无需；强模型对比需 1 个免费 Key |
| **P0.5** | 混合推理 + 无 Key 端点统一聚合 + 双层叠加 | HARNESS²/Evo²/KeylessAI·Zerogateway | 🟢 全链路已交付（hybrid v2.0.3 + keyless v2.0.4 + 双层叠加 v2.0.5） | 否（本地小模型 + 免 Key 端点即可） |
| **P1** | live RSI（对比式改进 live 闭环） | HARNESS² | 🟢 核心闭环已交付（v2.0.5，防 reward hacking 实证） | 否（确定性轨迹已实证；强模型自动编排待 P0） |
| **P2** | 经验库 EXPERIENCE.md | HARNESS² | 🔲 待建 | 否 |
| **P3** | RRSI 正则 + OOD 通道 | RRSI | 🔲 待建 | 否 |
| **P4** | OO-Harness 类族 + Router | OO-Harness | 🔲 待建 | 否 |
| **P5** | 公开基准对齐 L4 | 全部 | 🔲 待建 | 需外部基准数据 |

> 一句话：**P0 把"能不能跑真模型"变成一行命令；P1–P4 在冻结模型下持续进化 harness；P5 用真实基准数据把 not-proven 往前推一步。**
> 当前 v2.0.0 已完成"证明 bro2 能持续进化且诚实"的基础，P0–P5 是通向"可证伪的业界领先"的工程路径。
