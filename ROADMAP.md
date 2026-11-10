# bro2 · 演进路线图（ROADMAP · P0–P5）

> 把"如何持续让 bro2 进化、并真正验证其业界水平"拆成 6 个受管理的工作流。
> 每个工作流含：**目标 / 输入 / 产出物（deliverable）/ 验收标准 / 依赖 / 状态 / 论文依据**。
> 论文依据均为真实存在的前沿工作（详见 [docs/RSI-NEXT.md](./docs/RSI-NEXT.md)）。
> 配套：产出物登记见 [DELIVERABLES.md](./DELIVERABLES.md)，发布记录见 [CHANGELOG.md](./CHANGELOG.md)。

**核心约束（治理红线，所有 P 不可违反）**：冻结权重、不训练、不更新模型参数；RSI 只演进 **harness（Agent OS）** 本身。所有能力增益必须在**冻结模型**下成立，且经 [DELIVERABLES.md §5](./DELIVERABLES.md) 验收门禁校验。

**诚实边界**：`leadership.verdict = not-proven` 直到 P5 完成且第三方复现通过。P0–P4 全部可在冻结模型下推进；唯独 **P5 需要外部基准数据 / 第三方复现**，bro2 单方面无法凭空生成——但 P0 的免费 API + P3 的 OOD 通道已把"拿不到真实分数"从"不可能"变成"一行命令 + 一份基准 JSON"。

---

## 0. 两大设计目标与路线图的对齐（v2.1.0 重排）

> 用户定义的两大目标：
> 1. **harness 能够持续自动完成自我改进；越使用改进速度越快。**
> 2. **能够用本地部署小模型配合远程免费、免 Key 的大模型，胜任大多数任务——对大模型智能程度容错性高、使用成本低。**

### 0.1 现状诊断：两个目标卡在同一个缺失件上

v2.0.6 之前，P0 / P0.5 / P1 已把「能不能跑真模型」「能不能省远程调用」「能不能无真值判定改进」逐个打通，
但对着两大目标复核，暴露出一个**共同的结构性缺口**：

| 目标 | 已有机制 | 缺口 |
| --- | --- | --- |
| 1 · 越用越快 | `Ledger.stats()` 按**算子**聚合成功率 → 更新搜索先验；`MetaState` 7 个有限枚举 + 6 个固定元候选 | 都是「搜索参数」，不是「搜索经验」。每轮从默认态重新搜索（memoryless），**没有度量、更没有优化「达到改进花了多少次探测」** |
| 2 · 越用越省/越稳 | `cheapToLocalPolicy` 静态启发式；`KeylessAggregator` 进程内健康态；`InferenceStats` 仪表盘 | 路由不学习实际成败、端点质量重启清零、成本只被观测**从不回控路由**，因此不会随使用递减 |

一句话：**现有 RSI 是「每轮重新搜索」，现有路由是「静态规则 + 进程内状态」；两者都缺一个跨会话、只增、可检索的经验层。**

### 0.2 共享中枢：复利层（v2.1.0 交付）

两个目标指向同一个中枢，因此把路线图从「P0→P5 的论文映射」升级为**两条目标主线 + 一个共享底座**：

```
目标 1 · 复利主线
  P1 行为判定 →【P2 经验库】→【冻结速度尺子】→ P3 OOD 防过拟合 → P4 Harness 类族/Router
                    ▲                    ▲
                    │  共享 ExperienceBank（事件式只增账本 / 指纹 / 检索 / OOD 失效）
目标 2 · 容错成本主线 ───┴────────────────────┘
  P0.5 双层叠加 →【学习型路由 + 跨会话端点经验】→ P0.5-b 语义缓存 → P0.5-c 成本入 RSI
```

- **经验层**（`src/rsi/experience.ts`）：按失败模式 / 请求结构 / 上游三类指纹，把实证结果写成只增事件，
  读取时折叠成可复用快照；`invalidate()` 让 OOD 退化的经验失效而非删除。
- **冻结速度尺子**（`src/rsi/velocity.ts`）：把 `attempts / firstTryHitRate / improvementPerAttempt`
  变成一等公民；样本不足一律 `insufficient-data`，绝不宣称加速；协议违规轮不计入趋势。
- **复利闭环**（`src/rsi/compound.ts`）：经验**只裁剪 Propose 的探测集**，判定仍走全量行为对比；
  经验不灵必回退；始终保留 1 个探索位（RRSI 正则思想）。
- **学习型路由**（`src/models/route-experience.ts`）：实现 `RoutePolicy` 注入 `HybridProvider`、零侵入；
  远程失败→本地兜底同时记 `remote: failure` 与 `local: success`，把容错转化为成本优势。

详见 [docs/COMPOUND-LOOP.md](./docs/COMPOUND-LOOP.md)。

### 0.3 目标 → 工作流映射（状态）

| 目标 | 工作流 | 状态 |
| --- | --- | --- |
| 1 | P1 行为对比判定 | 🟢 v2.0.5 已交付 |
| 1 | **P2 经验库 + 复利速度度量** | 🟢 **v2.1.0 核心闭环交付**（18 单测 + 第 11 道门禁） |
| 1 | P3 RRSI / OOD 正则 | 🔲 待建（已具备 `invalidate` 接口与探索位） |
| 1 | P4 OO-Harness 类族 / Router | 🔲 待建（跨失败模式泛化的落点） |
| 2 | P0.5 双层叠加 | 🟢 v2.0.5 已交付 |
| 2 | **P0.5-a 学习型路由 + P0.5-c 成本经验闭环** | 🟢 **v2.1.0 最小闭环交付** |
| 2 | P0.5-b 语义 / 近似缓存 | 🔲 待建 |
| 2 | P0.5-c 完整「成本作为 RSI 晋升目标」 | 🟢 **v2.16.0 判定机器交付**（judgePromotion 新增可选 `cost` 目标 + 第 23 道门禁 6/6）；live 接线待 hybrid 评测接入 |
| — | P0 真实强模型 / P5 公开基准 | 🟢 P0 首份分数（v2.0.6）/ 🔲 P5 |

### 0.4 进化启动器与迭代水位（v2.2.0 交付）

复利中枢此前只有「临时目录演示」：跑完即删、真实账本 0 条，于是「越用越快」既看不到、
也无法跨会话复核——**有尺子、没刻度**。v2.2.0 把它接成一条可持续推进的回路：

- **启动器** `npm run evolve:tick -- --rounds N`：每轮在真实任务上跑 `runEval`，只增账本跨会话
  累积；被经验裁剪的候选**不触发评测**，`attempts` 等于真实计算成本而非纸面裁剪。
- **水位** `npm run watermark` / `data/rsi/watermark.html`：对账本做逐轮前缀投影，
  四条曲线展示探测数、累计 IPA、跳过探测数与趋势变化，全部由同一把冻结尺子判定。
- **门禁** `npm run watermark:check`（第 12 道）：校验尺子唯一、账本只读、视图与账本一致。

首次真实启动 8 轮：探测数 3→2、每轮真实评测 4→3 次、累计跳过探测 7 次，
冻结尺子在**第 6 轮**首次判定 `trend=accelerating`（IPA 0.333→0.471）。
这仍是**同类失败模式内的搜索成本**证据，不是能力分数；P3 OOD 泛化与 P4 异步按需探测
未实现，`leadership.verdict` 保持 `not-proven`、L4 保持 `not-achieved`。

### 0.5 发布闭环：每次改进都推送远程（v2.2.1 交付）

水位看板解决「看得到进化」，但发布动作仍靠人工 `git push`，出现过本地已提交、远程未同步的断点。
v2.2.1 把「每次改进都推送」固化为机制，而不是依赖执行者记忆：

- **唯一通道** `scripts/push-remote.sh`：复用仓库外 600 权限 fine-grained PAT，
  一次性 askpass 传凭证、屏蔽系统 App helper；凭证不回显、不入库、不进 `.git/config`。
- **一键闭环** `npm run ship`：还原运行时噪声 → 干净身份提交 → 唯一通道推送 → 同步自检。
  `npm run ship -- --rounds 8 "<msg>"` 可先推进真实迭代再发布；迭代本身仍离线可复现。
- **防漏推门禁** `npm run push:check`：纯只读核对本地 HEAD 与远程 main、最新 tag 是否已推送，
  不一致即 `EXIT=1`；同时作为 `project:status` 信息展示项，本地领先远程会当场暴露。
- **红线测试** `tests/remote-sync.test.ts`：守住「凭证绝不入库 / 推送只走唯一通道 / 防漏推纯只读」。

这属于**发布流程保障**，不改变能力判定；`leadership.verdict` 与证据阶梯口径不变。

### 0.6 诚实边界

- 复利在**同一失败模式类内**成立；跨失败模式的泛化属于 P3 OOD 通道 / P4 HarnessRouter，尚未实现。
- `VelocityLedger` 判定的是**搜索成本下降**，不是能力分数提升；`leadership.verdict` 仍为 `not-proven`、L4 仍 `not-achieved`。
- 学习型路由的「越用越省」在离线确定性轨迹上实证；真实模型下的成本收益需 `eval:live --provider hybrid` 复测。
- 所有经验只影响先验与探测顺序，**绝不绕过行为判定**；自报分数始终不参与接受。
- v2.9.0 的 `npm run fault:check` 是**回归门禁**（离线复算故障恢复的 on/off 对照），
  不构成新的能力证据；不改变无故障场景 0pp 结论，也不推动 `verdict`。
  它补上的是「唯一正证据此前只能靠真实端点人工跑分、无法进 CI」这一基础设施缺口。
- v2.11.0 的 `npm run promotion:check` 是**阶段 C 前置闸门 + 确定性回归门禁**：
  把计划书里的三段晋升铁律（`dev 提升 AND holdout 不退化 AND OOD 不退化`）
  做成离线可复算、退化即阻断、改坏必红的判定机器。它证明「晋升判定可复算」，
  不证明任何编辑真实有效，三段是确定性构造的留出集；真实 dev/holdout/OOD
  分层仍待 W1-06 重定口径。不是能力证据，不推动 `verdict`。
- v2.13.0 修的是**接入门禁的组合路径盲点**（把流式/非流式拆开测，而 live 走的是流式带 tools），
  属于**测量机器修复**，不是能力证据：1.5B 链路已修通（preflight PASS、原生 `tool_calls` 正常），
  但本机纯 CPU 多步评测仍无法完成，`provider_error` 报告按红线删除、不进证据集。
  **历史结论修正**：v2.10.0 把 0.5B 归因为「能力下限」不再成立——链路修通前的
  0 工具调用不构成能力证据，需重测。不推动 `verdict`。
- **v2.14.0** 补上两块**输入侧地基**，都不产生能力分数：
  - **W1-06 重定口径**：不扩到 60 个同质任务（0pp 负结果已否定），改为把现有
    37 个真实任务按 `sha1(id)` 确定性切成 `dev 12 / holdout 15 / ood 10` 三堆、
    冻结指纹、互不相交、OOD 完全只读。`npm run segments:check`（第 21 道门禁）
    离线验证真实分段可复核、改坏必红，并用三段真实指纹构造 `PromotionSpec`
    喂 `judgePromotion`，证明判定机器拿到了真实任务集输入。
    **v2.15.0 已把 `judgePromotion` 接入 `runEvolve` 主循环**：晋升闸门改为三段铁律、
    新增真实 OOD 段、OOD 退化自动阻断并写 journal，判定机器终于吃到真实三段。
    阶段 C 的**机器闭环已完整**（从「判定机器」到「活循环消费」都就位）。
  - **弱模型单步重测**：`npm run weak:probe` 用最短单步任务重测 1.5B，红线写死
    「只有 `completed` + 协议零违规才算有效测量」。链路修通后实测发起 2 次原生
    `calc` 调用（协议 0 违规），坐实撤销 v2.10.0「0 工具调用 = 能力下限」；
    但本机纯 CPU 单步约 250~270s，三次尝试分别被墙钟（600s）与死循环守卫
    （连续 3 次相同工具调用）拦下、无 `completed` 轨迹，能力仍是**未测出**，
    写成运行时/行为约束而非「模型太弱」。见 `docs/BENCH-v2.md` §5.11。
- **v2.15.0** 完成阶段 C 的**最后一公里接入**（不产生能力分数）：
  `runEvolve` 晋升闸门从内联 2 段判据换成 `judgePromotion` 三段铁律，新增真实
  OOD 段（`data/evolve/ood.jsonl`，只读退化探针），OOD 退化自动阻断并写 `journal`
  可复核；6 处 `ledger.append` 收口到 `appendLed`、删 `efficiencyTiebreak`、预算
  反而 freed 5 行。`leadership.verdict` 仍 `not-proven`——机器闭环了，但缺口从
  「缺接入」变成「缺一次真实能力增益的测量」（演进 fixture 是确定性脚本回放、弱模型
  跑不完多步）。见 `docs/BENCH-v2.md` §5.12。
- **v2.16.0** 把 **P0.5-c 成本晋升目标**的判定机器落地（不产生能力分数）：`judgePromotion` 的
  `PromotionSpec` 新增可选 `cost` 字段，判定机器加第 7 条铁律「能力不降前提下远程调用不得上升」
  （成本退化即阻断、不参与 `promoted`）；`examples/p0.5c-check.ts` 第 23 道门禁 6/6 断言。
  诚实边界：`cost` 只是判定机器，真实 `remoteAvoided` 信号需 **hybrid 评测**接入（确定性评测域
  的 mock 无远程/本地之分），live 接线待打通。见 `docs/BENCH-v2.md` §5.13。
- **v2.17.0** 把「只增账本」不变量升级为 **git 历史级可验证**的发布阻断门禁（不产生能力分数）：
  `examples/ledger-append-only-check.ts` 第 24 道门禁对 `journal.jsonl`/`lessons.jsonl` 两本真正只增账本
  逐对相邻 commit 校验条目序列前缀不变量（条目级 canonical 比对，删除/重排/语义篡改必抓、纯格式化放行）；
  `ci.yml` 改 `fetch-depth: 0` 让其在 CI 生效。`backlog.jsonl` 因历史上有一次良性语义改写（W1-03 依赖
  W1-04→W1-02）  不纳入。见 `docs/BENCH-v2.md` §5.14。
- **v2.20.0** 把「自指评分」升级为**外部真值 oracle 评测**，并收敛 RSI 子系统：
  `EvalTask.oracle` + 注册表（内置 `answer-matches-reference` / `answer-equals-reference` /
  `file-contains-reference`），grading 只读 agent 实际产出与 agent 不可见 `reference` 比对、绝不读
  harness 内部行为指标，并经 `runOne→grade()` 汇入 `summary.overall`，使未来 RSI 晋升相对独立真值。
  同时把重叠的三件套 `contrast.ts`+`live-contrast.ts`+`compound.ts` 合并为单一 `contrast.ts`
  （导出集合不变、53 项单测全绿），腾出 2 源文件槽位。仍是诚实基元、不产生能力分数，
  `leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`；要落能力增益结论，还需把 oracle 接入
  真实（非脚本化）任务集并对 train/holdout/OOD 三段用独立真值对照。见 `docs/BENCH-v2.md` §5.15。
- **v2.21.0** 把 v2.20.0 的 oracle 原语**用起来**——建成 `data/truth-tasks.jsonl`（10 项任务，覆盖三类 oracle
  与全部 `EvalCategory`，truth-01/06 叠合 `expectedTools`+文件真值命中），接通 `runEval→grade→oracle→summary`
  全链路，新增 `eval:truth`/`eval:truth:live`（独立基线 `data/truth-baseline.json` 不污染主回归基线）。
  确定性 `eval:truth` **10/10、总体 100%**；live 经 kilo 免 Key 端点实测 **7/10、overall 0.7**，oracle 正确
  标记 truth-09 未外部拒绝危险请求。诚实标注：该端点工具调用能力不稳（`preflight` 判 `toolCalling=unknown`），
  live 分数受端点可用性限制、**非干净基准**，证明的是「外部真值评测机制可用」。仍不产生能力分数，
  `verdict` 仍 `not-proven`、L4 仍 `not-achieved`。见 `docs/BENCH-v2.md` §5.16。
- v2.12.0 的端点健康经验接线补的是**目标 2「越用越稳」的结构闭环**：端点体检结果不再
  只落文档，而是折叠成跨会话先验注入 `KeylessAggregator.score()`、成败再回写只增账本，
  解决「健康态进程内、重启清零」。`npm run endpoint:check`（第 20 道门禁）离线验证
  先验不绕过冷却/限流硬过滤、失效 / 样本不足自动归零回退完整探测。运行时 opt-in 默认关闭，
  不写被跟踪账本、不进 CI 断言。这是结构证据，不是能力分数，不推动 `verdict`。
- v2.10.0 的免 Key 端点体检修的是**可用性与配置正确性**（目标 2），不是能力证据：
  15 个端点的匿名归因、新增 `ovhcloud` 后端、复活 `llm7`、按实测健康度重排聚合器优先级。
  端点可达性是运行时快照，**不进 CI 门禁**。
- 弱模型对照的证据缺口仍在：本地 0.5B 已能启动且 preflight 全 PASS，但 L2 准入
  **0/3、0 工具调用**（能力下限太低，基线 0 通过时 harness 差异无从体现）。
  补齐条件是能力介于 0.5B 与 kilo 之间、工具调用稳定、能承受约 126 次请求的模型，
  而不是再找更多「免费但限流」的远程端点。已下载 `qwen2.5:3b`（协议层通过），
  但本机 8GB 内存撑不住其中等多步评测（`provider_error`，资源约束非能力结论）——
  补齐路径是换有足够内存 / GPU 的环境重跑，不是换端点。
  见 `docs/ENDPOINT-HEALTH.md`、`docs/BENCH-v2.md` §5.6。

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
- **已交付（v2.0.6 · OpenRouter 免费 550B 强模型实测，P0 核心目标达成）**：
  - `preflight` 六项门禁全绿（配置 / 端点 / 认证 / 模型可用 / SSE 流式 / 原生 `tool_calls`），`AGENTOS_LIVE_PROVIDER=openrouter` 一行命令跑通 `eval:live`。
  - 真实报告 `data/eval-live-report.json`：总体 **41.7%（5/12）**，`protocolViolations=0`、工具错误率 0；分类 `tool-use 50% / grounding 0% / context 33.3% / multi-step 66.7%`。
  - 模型 `nvidia/nemotron-3-ultra-550b-a55b:free`（免费层 550B，远超 P0 设定的 120B+ 门槛），凭据只走环境变量 `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`，配置与提交记录零凭据。
- **依赖**：~~用户提供免费 API Key~~（v2.0.6 已兑现）；多模型横向对比仍待增加免费 provider 额度。
- **状态**：🟢 **核心目标已交付（v2.0.6）**——已拿到真实强模型第一份有效分数；「≥3 个真实模型对比矩阵」与「付费强 Key 横向对比」仍待建（对齐 P5）。
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
- **已交付（v2.1.0 · P0.5-a / P0.5-c 最小闭环）**：
  - `src/models/route-experience.ts` · `LearnedRoutePolicy`：实现 `RoutePolicy` 注入 `HybridProvider`、零侵入；用跨会话经验替代静态启发式，冷启动回退保护，远程失败→本地兜底的经验反哺成本。
  - 端点质量经验跨会话累积，补充 `KeylessAggregator` 进程内健康态重启清零的短板。
  - `npm run compound:demo` 实证：5 个原本走远程的请求被压到本地，`remoteAvoided=6`。
- **下一步（待建）**：
  - **P0.5-b 语义/近似缓存**：对 Near-duplicate 提示做 embedding 相似度匹配，扩展命中面（当前是精确匹配）。
  - **P0.5-c live 接线**：判定机器已在 v2.16.0 落地（`judgePromotion` 的 `cost` 目标 + 第 23 道门禁），待 hybrid 评测把真实 `remoteAvoided` 信号接入 `runEvolve` 的 `PromotionSpec.cost`（确定性评测域的 mock 无远程/本地之分，故 live 接线未做）。
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
- **状态**：🟢 **核心闭环已交付（v2.1.0）**——经验库 + 冻结速度尺子 + 复利闭环 + 第 11 道门禁；跨失败模式泛化（P4 Router）仍待建。
- **已交付（v2.1.0 · P2 落地）**：
  - `src/rsi/experience.ts` · `ExperienceBank`：事件式只增账本、三类指纹、检索复用、OOD 失效。
  - `src/rsi/velocity.ts` · `VelocityLedger`：冻结速度尺子（attempts / IPA / firstTryHitRate），样本不足不宣称加速。
  - `src/rsi/compound.ts` · `compoundProbe`：经验只裁剪 Propose 探测集、判定仍走全量行为对比、不灵必回退、保留探索位。
  - `src/models/route-experience.ts` · `LearnedRoutePolicy`：目标 2 的学习型路由闭环（见 P0.5）。
  - `tests/compound.test.ts`（18 项）+ `npm run compound:demo`（10/10 断言）+ `project:status` 第 11 道门禁 `compound`。
  - 详见 [docs/COMPOUND-LOOP.md](./docs/COMPOUND-LOOP.md)。
- **论文依据**：**HARNESS²**（Experience Reflector → `EXPERIENCE.md`）、**RRSI**（探索正则）。

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
P0(强模型实测 v2.0.6)：OpenRouter 免费 550B 跑通 eval:live，第一份强模型分数 41.7%（5/12，协议违规 0）
P2(复利中枢 v2.1.0)：ExperienceBank + VelocityLedger + compoundProbe + LearnedRoutePolicy
  两条主线共享经验层：目标1 裁剪探测集降收敛成本；目标2 路由/端点经验跨会话降远程开销
依赖：P0(真实分数) → P1(live RSI) → P2(经验) / P3(OOD)
     P2+P3 → P4(类族) → P5(L4 升 partial)
     P0.5-a/b/c 可独立于 P1–P4 推进（纯 harness 工程优化）；统一聚合器 + 双层叠加 + P1 闭环 + P0 强模型实测已交付
```

| 优先级 | 工作流 | 论文 | 状态 | 是否需外部数据 |
| --- | --- | --- | --- | --- |
| **P0** | 免费 API 真实评测（含免费强模型） | 全部 | 🟢 核心目标已交付（v2.0.6，550B 实测 41.7%）；多模型矩阵待建 | 免费层 Key 已够用；横向对比需更多 provider 额度 |
| **P0.5** | 混合推理 + 无 Key 聚合 + 双层叠加 + 学习型路由 | HARNESS²/Evo²/KeylessAI·Zerogateway | 🟢 全链路已交付（v2.0.3–v2.0.5）；P0.5-a/c 最小闭环 v2.1.0；P0.5-b 待建 | 否（本地小模型 + 免 Key 端点即可） |
| **P1** | live RSI（对比式改进 live 闭环） | HARNESS² | 🟢 核心闭环已交付（v2.0.5，防 reward hacking 实证） | 否（确定性轨迹已实证；强模型自动编排待 P0） |
| **P2** | 经验库 + 复利速度度量（复利中枢） | HARNESS² / RRSI | 🟢 核心闭环已交付（v2.1.0） | 否 |
| **P3** | RRSI 正则 + OOD 通道 | RRSI | 🔲 待建 | 否 |
| **P4** | OO-Harness 类族 + Router | OO-Harness | 🔲 待建 | 否 |
| **P5** | 公开基准对齐 L4 | 全部 | 🔲 待建 | 需外部基准数据 |

> 一句话：**P0 把"能不能跑真模型"变成一行命令；P1–P4 在冻结模型下持续进化 harness；P5 用真实基准数据把 not-proven 往前推一步。**
> 当前 v2.0.0 已完成"证明 bro2 能持续进化且诚实"的基础，P0–P5 是通向"可证伪的业界领先"的工程路径。
