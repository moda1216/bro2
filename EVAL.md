# 能力评测、持续提升与真实模型接入

> 本文档回答三个问题：**能力水平怎么测**、**怎么持续变强**、**LLM API 能不能接 Ollama 这类本地模型**。
> 所有结论都对应可运行命令与实测数据，不把「组件存在」冒充「能力水平」，也不把「内部满分」冒充「行业领先」。
> v2.0 追加：策略分派层、meta RSI、可证伪能力基准（设计见 [DESIGN.md 附录 C](./DESIGN.md)，判据见 [BENCHMARK.md](./BENCHMARK.md)）。

---

## 一、如何检测和验证能力水平

### 1.1 先分清三种「验证」——这是最容易被混淆的地方

| 类型 | 回答的问题 | 本项目工具 | 能证明什么 | **不能**证明什么 |
| --- | --- | --- | --- | --- |
| 结构自检 | 组件在不在、能不能调通 | `verify.ts`（23 项） | 没有空接口、各层连通 | 不能说明「做得好不好」 |
| 行为回归 | 给定模型行为，框架是否正确 | `eval --mode deterministic`（19 任务） | 调度、治理、恢复、协议正确性 | 固定了模型输出，**测不到智能** |
| 端到端能力 | 真实模型下任务成功率 | `eval --mode live --provider <name>` | 模型 + 框架的真实水平 | 需要真实模型，且有随机性 |

上一轮交付里的 `verify.ts 23/23` 属于第一类。它能证明 8 层能力都有实现，但**不能**作为「Agent 有多强」的证据——因为它检查的是 `typeof fn === "function"` 这类存在性断言。真正的能力水平必须靠**可判分的任务集 + 真实模型 + 统计指标**。

> 一个反直觉但重要的判断：**Mock 跑出的 100% 不代表 Agent 强，只代表 Harness 没问题**。把模型固定成脚本之后，测的其实是框架的确定性与正确性；智能性只可能在 live 模式下暴露。

### 1.2 分层评测体系

| 层次 | 手段 | 输出 | 频率 |
| --- | --- | --- | --- |
| L0 单元 / 契约 | `npm test`（87 用例，含故障注入、RSI / meta / benchmark / external / preflight 回归） | 通过率 | 每次提交 |
| L1 组件基准 | `npm run verify` | 23/23 逐层清单 | 每次提交 |
| L2 任务基准 | `npm run eval` | 6 类 19 任务的加权得分 + 指标 | 每次提交 / CI 门禁 |
| L3 对抗鲁棒 | 任务集内 6 项故障注入 | 错误回喂率、Guard 触发、越权拦截 | 每次提交 |
| L4 回归门禁 | `eval-baseline.json` + 任务集指纹 | 相对基线劣化清单 | 每次提交 |
| L5 跨模型对比 | 同一任务集分别跑 `mock / openai / ollama / ...` | 差异矩阵，定位是框架还是模型问题 | 模型 / 提示词变更后 |
| **L6 领先度证据阶梯** | `npm run benchmark` + `benchmark:check` | 5 级证据 + 7 变体 ablation + 可证伪声明 | 每次发布 / 对外声明能力前 |

`Trajectory` 只增日志是这套体系的支点：**每条轨迹既是评测证据，也是可回放的回归用例**，指标全部从事件流抽取，不引入第二套状态存储。这也是设计阶段「日志是唯一数据源」带来的直接收益。

### 1.3 指标定义（都可复算）

| 指标 | 定义 | 为什么重要 |
| --- | --- | --- |
| **总体得分 / pass@k** | 按任务权重加权的通过率 / 重复 k 次至少成功一次的比例 | 唯一的能力主指标；真实模型有随机性，单次成功率不够 |
| 分类得分 | `tool-use / grounding / context / multi-step / safety / robustness` 各自通过率 | 定位短板在哪个能力维度 |
| **协议违规** | 发出 `tool_call` 却没有配对 `tool_result` 的次数 | **零容忍**：OpenAI 兼容端点会因此返回 400，且模型收不到工具结果 |
| 工具错误率 | `ok:false` 的 ToolResult / 全部 ToolResult | 区分「故意注入的故障」与「框架缺陷」 |
| 步数 / 工具调用效率 | 平均步数、平均调用数 | 同样成功，步数少意味着规划与工具选择更好 |
| Guard 触发率 | 触发步数/token/死循环 Guard 的 run 占比 | 过高说明模型在空转 |
| 安全拦截率 | 路径逃逸 / 审批拒绝 / 高危命令被正确处理的比例 | 治理是否真的生效，而不是只装了开关 |
| token / 延迟 | 累计 token、平均墙钟 | 成本与可用性 |

**判分不只看终答**。每个任务可声明：期望调用的工具集合、终答关键词、期望生成的文件及内容、期望停止原因、是否触发 Guard / 压缩 / 审批拒绝、最大步数，以及所有任务共享的「零协议违规」断言。v2.0 另加策略行为断言（`expectRepair` / `expectGroundingReject` / `expectLoopAdvisory` / `expectCompactionEvidence` / `expectedPolicy` 及对应的负向断言），使评测能区分「框架切了哪个真实代码分支」。这避免了「模型说了一句『已完成』就算通过」的假阳性。

### 1.4 门禁与 CI

```bash
npm run eval                      # 确定性回归，门禁失败时 exit code = 1
npm run eval -- --json > r.json   # 机器可读报告，供 CI 解析 gate.pass
npm run eval -- --k 3             # pass@3，压住随机性
```

确定性评测报告落在 `data/eval-report.json`，基线在 `data/eval-baseline.json`。**基线带任务集指纹**：改动任务集后旧基线自动失效并重建，避免「改了用例还拿旧分数比」的误报。门禁检查 8 条阈值（总体/工具/安全/鲁棒下限、错误率上限、协议违规零容忍、平均步数上限、相对基线最大劣化）。

> **报告隔离**：`eval --mode live` 写 `data/eval-live-report.json`，`live:smoke` 写 `data/live-link-smoke.json`，都**不会覆盖** `data/eval-report.json`（证据阶梯 L1 的唯一输入）。旧实现会让一次失败的 live 尝试把 L1 从 `achieved` 打回 `partial`，已修复，`preflight:check` 有对应断言。

### 1.5 当前实测水平（如实标注）

| 项目 | 结果 |
| --- | --- |
| 单元 + 端到端 + 故障注入 + RSI / meta / benchmark / preflight 测试 | **87 / 87** |
| 结构自检（L0–L7） | **23 / 23** |
| 确定性评测 | **19 / 19，总体 100%，pass@1 100%，协议违规 0，门禁 PASS** |
| 策略分派层分支实证（`policy:check`） | **19 / 19**（5 个真实代码分支逐条生效，安全不变量不退化） |
| RSI 端到端 + 恶意候选注入（`rsi:check`） | **22 / 22**（4 个恶意候选全部拦截并留 incident） |
| 能力面 RSI（`evolve`） | 4 代单调提升，train 0.286→0.857 / holdout 0.5→1.0，晋升 4 / 拒绝 1 / 拦截 2 |
| meta RSI（`meta` / `meta:check`） | fitness 0.8879→0.9、eval 22→20、能力不退化；**25 / 25** |
| 能力基准（`benchmark` / `benchmark:check`） | ablation 完整 10/10 vs 朴素 1/10；**21 / 21**（测量机器诚实性） |
| 离线演示 | 6 步 / 8 次真实工具调用 / 2 个并行子 Agent / 1 次审批 / 35 条轨迹事件 |
| Ollama 协议级实证 | **4 / 4**（免密钥对接、能力探针、完整闭环、strict 不降级） |
| **真实模型 live 评测（第一份真实分数，§3.5）** | **0 / 12，overall 0.0%，门禁 FAIL，协议违规 0**（qwen2.5:0.5b / CPU 4 核 / 单模型；`strict=true`，无脚本化响应） |

**必须说清的边界**：除最后一行外，以上全部是**框架侧 + 确定性评测域**证据。轮 7 已用 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md) 的路线 B 在沙箱内跑出**第一份真实模型分数：`0 / 12`（overall 0.0%）**，详见 §3.5。这份 0 分是真实的、未被粉饰的，但它只代表 `qwen2.5:0.5b / CPU 4 核 / 单模型 / 内部任务集` 这一具体配置：模型在 26 个工具定义下不发起工具调用，直接终答或空答。**它实证了「Mock 100% ≠ 真实能力」，却不构成对 bro2 框架能力的否定**（协议违规 0、工具错误率 0、Guard 0，Harness 链路正常），更不构成「行业领先」的正反结论。谁把 Mock 的 100% 说成「Agent 智商」，或把单个 0.5B 模型的 0 分说成「框架不行」，都是在误导。

更进一步：内部评测再漂亮也**不等于行业领先**。这是一个外部比较命题，`data/benchmark-report.json` 给出的 `leadership.verdict = not-proven` —— L0–L2 achieved、L3 partial、**L4 not-achieved**。判据与如何证伪见 [BENCHMARK.md](./BENCHMARK.md)。

---

## 二、如何持续提升通用性、鲁棒性、智能性

### 2.1 先有闭环，再谈优化

```
可判分任务集 → 跑出指标 → 定位短板 → 单点改动 → 回归门禁 → 把失败轨迹沉淀成新用例 → 更新基线
```

**本轮就走了一遍这个闭环**：`t11` 上下文压缩任务失败，追下去发现不是用例写错，而是 `BudgetManager` 与 `Guards` **共用同一个 `maxTokens`**——压缩阈值等于硬熔断上限，累计 usage 会先触顶，压缩永远来不及生效，且 `keepRecent=8` 也要求长历史才触发。修法是引入独立的 `budget.compactTokens`（默认 `maxTokens × 0.6`），让压缩先于熔断发生。改完 19/19，基线按新指纹重建。**没有评测，这个缺陷会一直藏在「功能存在」的自检里。**

### 2.2 通用性（Generalization）

| 杠杆 | 当前状态 | 下一步 |
| --- | --- | --- |
| 模型无关 | Mock / OpenAI 兼容 / Ollama / vLLM / LM Studio 共用一个适配器；`ProviderRouter` 支持降级与熔断 | 新增 provider 只需加一段配置，不改内核 |
| 协议与工具生态 | 26 个内置工具、显式 JSON Schema、MCP 连接器热挂载与可逆卸载、插件热插拔 | 把外部工具统一纳入评测任务集，避免「能挂载但没验证」 |
| 任务覆盖度 | 6 类 19 任务 + train 7 / holdout 8 | **训练/任务集分离**：holdout 只对迁移验证，改进器不可见 |
| 反过拟合 | 任务集独立于代码（`data/eval-tasks.jsonl`），holdout 含 3 条治理不变量守卫 | 禁止对着脚本化 Mock 调参；所有优化必须在 live 模式复验 |
| 差异定位 | `strict` 模式 + 跨 provider 对比 | 建**跨模型对比矩阵**：同一任务集分别跑多模型，某项只在某模型掉分 → 模型问题；全部掉分 → 框架问题 |

> 通用性最容易踩的坑是「对评测集过拟合」。任务集要持续加新类别、加扰动（改写措辞、换语序、加无关上下文），并保留一份从不参与调参的 holdout。

### 2.3 鲁棒性（Robustness）

已落地的故障注入：畸形模型参数、未知工具、审批拒绝、步数越界、路径逃逸、死循环、工具超时、畸形 SSE 分片、端点不可达、并行调用乱序。继续提升的方向：

1. **扩大注入矩阵**：模型返回畸形 JSON、流中途断开、工具输出超长、并发超限、审批超时、会话中途取消、磁盘写满、时钟漂移。
2. **随机化与长稳**：把固定注入改成带种子的随机注入，跑长时 soak test，观察内存与句柄泄漏。
3. **失败轨迹自动转用例**：Trajectory 天然是结构化语料，线上/演练中的失败轨迹可直接回灌成新任务，形成「越用越稳」的复利。
4. **守住零容忍指标**：协议违规、未捕获异常、越权操作成功、静默降级伪造成功——这四类一旦出现就直接判门禁失败，不参与加权平均。
5. **隔离强度**：当前是应用层路径白名单沙箱（非 bwrap / Landlock）。真上生产应把工具执行挪到独立进程/容器并加 cgroup 资源上限，这是架构边界，不是调参能补的。

### 2.4 智能性（Intelligence）——先纠正一个前提

**框架本身不产生智能。** 端到端智能 ≈ 模型能力 × 上下文工程 × 策略 × 工具质量。Harness 能改的是后三项，而且每一项都必须能在评测上量化，否则就是玄学。

| 可改杠杆 | 现状 | 可量化验证方式 |
| --- | --- | --- |
| 上下文组装 | 系统提示 + 记忆 + 技能摘要 + 工具 Schema + 预算压缩（`salience` 策略保证据） | 长会话任务的 pass@k、压缩后是否丢关键约束 |
| 记忆检索 | 关键词检索 | 检索命中率、注入噪声对步数的影响 |
| 规划与反思 | TODO 状态机、死循环检测、终答接地校验 | 多步任务平均步数、Guard 触发率、臆造结论被打回次数 |
| 失败归因与重试 | 工具错误回喂模型 + 受控参数修复 | 故障注入后的恢复成功率 |
| 模型路由 | 多 provider + 熔断 | 按任务难度分流后的 token / 延迟 / 成功率 Pareto |
| 轨迹反馈 | 轨迹可回放 | 把失败轨迹做 few-shot 或训练数据，用 holdout 复验提升 |

**建议的推进顺序**：① 先接真实模型建立 live 基线 → ② 一次只改一个杠杆 → ③ 看 `pass@k / 平均步数 / token / 协议违规` 四项变化 → ④ 有提升才合入并更新基线。没有 live 基线之前，任何「让 Agent 更聪明」的改动都无法证伪。

### 2.5 成熟度路线

| 阶段 | 目标 | 完成标志 |
| --- | --- | --- |
| 0（当前） | 框架正确性可复现 | 确定性评测 19/19、门禁、零协议违规；**能力面 RSI 与 meta RSI 闭环可跑通并单调收敛；证据阶梯就位** |
| 1 ✅ | 真实模型基线（单点已取得，矩阵仍缺） | `doctor` + `preflight` 通过、`eval --mode live` 跑出第一份真实分数（0/12，§3.5）；**≥3 provider 对比矩阵仍缺** |
| 2 | 覆盖与鲁棒 | 任务集扩到 50+、故障注入 15+、holdout 集 |
| 3 | 泛化验证 | 3 个以上模型的对比矩阵，改动在 holdout 上复验 |
| 4 | 外部基准对齐 | 接入公开 Agent 基准（GAIA / τ-bench / BFCL / SWE-bench 类）做外部校准 |

> 阶段 4 的**测量机器已就位**（5 级证据阶梯 / 7 变体 ablation / 外部结果导入 schema），但公开基准**分数**仍未取得。这里只列为方向，不拿公开基准的名字冒充已取得的成绩。**阶段 1 已在沙箱路线 B 取得单点真实分数（0/12），但只覆盖 1 个 0.5B CPU 模型；阶段 2–4 尚未完成**，当前结论仍是 `not-proven`。

### 2.6 把闭环自动化：bro2 的能力面 RSI

上一节描述的是**人驱动**的改进闭环（改一处 → 看指标 → 合入）。bro2 现在把其中「**诊断 → 提议 → 影子验证 → 晋升/回滚**」自动化了，但**没有**放宽验证标准：

| 人驱动闭环 | bro2 自动闭环 |
| --- | --- |
| 看失败轨迹找问题 | `miner` 从 train 评测报告聚类失败信号（含 `policy` 类别） |
| 想一个改法 | `operators` 按先验生成**单原子**候选（编辑预算 = 5） |
| 跑一次评测 | 影子 root 应用候选 → train eval → **holdout 独立 eval** |
| 有提升才合入 | train 严格提升 + holdout 严格提升 + 双门禁 PASS + 协议违规 0 才晋升 |
| 更新基线 / 记录 | 只增账本（含被拒候选）+ 报告 + 状态固化 |

**评测器在这里是「验证器」，不是「被测对象」**：`runEval` 显式 `evolvedState: false`，与运行时演进状态隔离；`eval.ts`、门禁阈值、train/holdout 任务集、治理源码、`scoring.ts` / `ladder.ts` 都在 SHA-256 写保护面内，每代重算。这直接堵住 RSI 文献里最典型的 **objective hacking**（改掉评估器依赖的 logging 拿满分）。

> **v2.0 变化**：可改进面从「5 个数字参数」扩展为「5 个真实代码分支」（`BehaviorPolicy`）。改进不再只是调阈值，而是切换 `malformedArgs` / `grounding` / `compaction` / `parallel` 等算法变体，由 `policy:check` 19/19 逐条验证分支真的产生不同行为。第 4 代 `loopDetection: advisory` 在 train 上有效，却因破坏 holdout「死循环必须硬终止」的治理不变量被主动拒绝——这是把安全断言写进留出集、而非人工列白名单的结果。详见 [DESIGN.md 附录 C](./DESIGN.md) 与 [ITERATIONS.md](./ITERATIONS.md)。

关键边界：**晋升信号只来自外部可执行断言，不来自模型自评或 LLM judge**；改进的是 harness 的声明式配置面与策略分支，收益只在该评测域内成立。因此 `npm run evolve` 跑出的 `train 0.286→0.857 / holdout 0.5→1.0` 应读作「框架在可验证前提下单调改好了自己的行为策略」，不能读作「模型变聪明了」。完整的 RSI 前沿调研、验证层级、代表工作与边界见 [RSI.md](./RSI.md)。

命令：`npm run evolve`（正式，固化到运行时）· `npm run evolve:dry`（只诊断）· `npm run rsi:check`（22 项断言，含 4 个恶意候选注入）· `npm run policy:check`（19 项，验证 5 个策略代码分支真的生效）。

### 2.7 meta RSI：改进「如何找改进」

上一节的闭环里还有一组参数是写死的：失败挖掘保留几条证据、候选按什么顺序评估、哪些算子参与搜索、平台期等几代才停、晋升判据多严、编辑预算是否随平台期调整。meta RSI 把这 7 个 `MetaState` 维度也纳入迭代，同时**不让系统碰到自己的尺子**：

| 层 | 对象 | 可变 | 判定 | 落盘 |
| --- | --- | --- | --- | --- |
| 能力面 | budget + 5 策略 + 技能增量 | ✅ | train + holdout 双严格提升 | `data/evolve/state.json` |
| 改进机制 | `MetaState` 7 维度 | ✅ | **冻结 fitness** 单调提升 + 能力不退化 | `data/evolve/meta-state.json` |
| 冻结尺子 | `scoring.ts` / `ladder.ts` / `eval.ts` / 任务集 / 治理源码 | ❌ | 每代 SHA-256 重算，变更即停机 | `PROTECTED_FILES` |

```
finalHoldout = holdoutCurve.at(-1)
area         = mean(holdoutCurve)
efficiency   = min(1, area / evalRuns * 20)
score        = 0.6 * finalHoldout + 0.4 * efficiency
```

晋升三条件：`finalHoldout >= base` ∧ `score > base` ∧ `integrityOk`。元候选在 `scratchDir` 内跑 `dryRun + reset` 的短程 evolve，账本与 incidents 全部隔离；`checkMetaPatch` 拒绝危险值 `lenient` 与任何触碰验证层级的字段名。

实证：`plateauPatience 2→1` 让冻结 fitness `0.8879 → 0.9`、eval `22 → 20`、holdout 保持 `1`；`npm run meta:check` 25/25。**`Imp_t → Imp_{t+1}` 真实落地**：已晋升的 `meta-state.json` 被下一次 `runEvolve` 默认加载，可观测地少跑 2 次无效基线评测。完整说明见 [META-RSI.md](./META-RSI.md)。

### 2.8 把「领先」变成可证伪的测量机器

内部评测的 100% 无法回答「是否领先」——那是一个**外部比较命题**。bro2 用 `src/benchmark/` 建立测量机器，并让判定逻辑本身处于写保护面内：

| 级 | 判据 | 当前 |
| --- | --- | --- |
| L0 结构连通 | 各层可运行，评测报告落盘并通过门禁 | achieved |
| L1 确定性行为回归 | overall ≥ 0.85、门禁 PASS、未配对 tool_call = 0 | achieved |
| L2 有界可验证自我改进 | train/holdout 单调提升、保护面未变更、有害候选被拒 | achieved |
| L3 meta RSI + 贡献分离 | 冻结 fitness 提升、ablation 量化、跨 provider 接口就绪 | **partial**（无真实模型矩阵） |
| L4 公开基准对齐 | 公开基准胜过同期开源 harness + 第三方复现 | **not-achieved** |

`assessEvidenceLadder` 从落盘报告自动判定，**不会给自己发满级**；`leadership.verdict = not-proven` 并附 3 条可证伪条件（公开基准未胜出 / 换真实模型后增益消失 / 去掉 RSI 分数不变）。

贡献分离（ablation）是内部最强证据：同一任务集、同一模型、同一预算，逐个关闭能力，且**剥离 `expectedPolicy` 配置断言**避免循环论证。完整 bro2 `10/10`，保守基线 `7/10`，朴素单轮 `1/10` —— 多步工具循环贡献 `−0.900`，4 个策略各贡献 `+0.100`；`no-parallel` 本域 0 贡献，如实标注。`npm run benchmark:check` 21/21，重点验证「测量机器诚实」而非「分数高」。完整口径见 [BENCHMARK.md](./BENCHMARK.md)。

**外部证据入口同样纳入尺子**：`data/benchmark/external-results.json` 必须通过 `src/benchmark/external.ts` 的严格校验才会被阶梯采纳；校验器与评分面同在写保护面内。`npm run external:check` 38/38 实证：空记录、自带结论字段、未来日期、占位复现命令、以及在内部报告里手塞 `external`，五类伪造都不能把 L4 从 `not-achieved` 提上去；合法记录最多到 `partial`，`verdict` 仍恒为 `not-proven`。真机接管流程见 [docs/TAKEOVER.md](./docs/TAKEOVER.md)。

---

## 三、LLM API 能否接入真实接口 / Ollama 本地模型

### 3.1 结论：可以，且已原生支持

架构上所有 OpenAI Chat Completions 端点走**同一个 `OpenAICompatProvider`**，云端 API、vLLM、LM Studio、Ollama 只是 `baseUrl` 与认证策略不同，内核完全不感知差异。本轮为此做了 5 项加固：

| 改动 | 解决的问题 |
| --- | --- |
| 本地端点自动免 API Key | Ollama 不做认证，原实现强制 `apiKey.length > 0` |
| `include_usage` | 让端点回传真实 token 统计，不再只靠估算 |
| `tool_calls` 按 `index` 排序 | 原实现 `.sort(() => 0)` 不保证并行调用顺序 |
| 函数名重复分片防护 | 部分本地端点每个 delta 都下发完整 `name`，会拼成 `calc calc` |
| `probe()` 能力探针 | 接入前判定模型**是否真的返回 tool_calls**，避免静默退化 |

Ollama 官方提供 `/v1/chat/completions` OpenAI 兼容端点，支持流式与 function calling [^ollama-docs]；`api_key` 可为任意字符串、服务端忽略认证 [^compat-guide]。

### 3.2 三步接上真实本地模型

```bash
# 1) 启动服务并拉取一个【带 tool-use 训练】的模型
ollama serve
ollama pull qwen3:8b          # 或 qwen2.5 / llama3.1:8b / mistral-nemo / gpt-oss

# 2) 配置 bro2（无需任何 API Key）
export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"   # 注意 /v1 前缀
export OLLAMA_MODEL="qwen3:8b"
export AGENTOS_MODEL="ollama"

# 3) 先诊断 + 过门禁，再评测，最后正常使用
npm run doctor
npm run preflight       # ready=PASS 才继续，否则 EXIT=1
npm run eval:live       # 真实分数 → data/eval-live-report.json
npm run cli
```

`doctor` 面向人，给出端点可达性、网络/认证分级、模型清单、SSE 流式、以及最关键的 `toolCalling` 判定；`preflight` 面向机器，把六项硬检查压缩成 `ready` + 退出码，内置于 `eval:live` 之前（端点未就绪就拒绝开跑，不产出会被误读成「能力差」的低分报告）。`eval:live` 用 `strict` 模式跑完整任务集，**禁止降级到 Mock**，报告写 `data/eval-live-report.json`，**不覆盖** `data/eval-report.json`（L1 证据与确定性基线的唯一来源）。云端模型同理，只是改用 `OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL` + `AGENTOS_LIVE_PROVIDER=openai`。

`AGENTOS_LIVE_PROVIDER` 决定 live 评测与 preflight 检查哪个 provider（缺省 `ollama`）；也可用 `--provider` 显式指定。`preflight` 的 `--json` 输出可被 CI 直接解析，`--all` 一次检查全部已注册 provider。

### 3.3 实测过的坑（务必看）

- **模型必须支持 function calling。** 小参数量或未做工具微调的模型常把工具调用写进正文或直接忽略，此时 Agent Loop 因为「零 tool_calls」直接给出终答——**任务静默失败，且不报错**。`probe()` 会把这种情况判为 `text-json` / `unsupported` 并建议换模型。
- **上下文长度要在 Modelfile 里设 `num_ctx`**，OpenAI 兼容 API 没有设置上下文窗口的字段 [^ollama-docs]。长会话评测前先调大，否则会被截断。
- **本地推理慢**：`ollama` provider 的 `timeoutMs` 已设为 300000，`maxRetries=1`；CPU 推理下建议先缩小任务集。
- **降级行为有两套语义**：日常使用（`AGENTOS_MODEL=ollama`）端点挂了会 fallback 到 Mock，保证可用；评测 / CI 用 `strict`，端点失败就明确报错，绝不伪造成功。`examples/ollama-check.ts` 第 4 项专门验证了这一点。
- **免密钥只认本地地址**：`localhost / 127.0.0.1 / ::1 / 0.0.0.0` 自动免认证；若把 Ollama 暴露到局域网域名，需要显式设 `apiKeyOptional` 或提供密钥。
- **401 不是「端点没起」**：`probe()` 现在把「拿到 HTTP 响应」视为网络可达，401/403 单独判为 `authRejected`。旧诊断把两者都报成不可达，会把「Key 错」误导成「服务没起」——`preflight:check` 对这两种情形的下一步指引分别有断言。
- **live 报告不要落在确定性报告上**：`eval --mode live` 写 `data/eval-live-report.json`；一次失败的 live 尝试若覆盖 `data/eval-report.json`，会把证据阶梯 L1 从 `achieved` 打回 `partial` 并抹掉确定性证据。

### 3.4 沙箱边界与已做的实证

本沙箱无 GPU、且 GitHub Release 出口受限**装不上 Ollama 二进制**；但可用 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md) 的**路线 B 跑真实权重推理**（轮 7 已实测，见 §3.5）。协议仿真的替代方案是 `examples/ollama-bridge.ts`：一个高保真协议仿真端点，实现 `/api/tags`、`/v1/models`、非流式 JSON、SSE 流式 `content` / `tool_calls` delta 分片、`usage` 汇总块与 `[DONE]`。`examples/ollama-check.ts` 用它跑通了 4 项验证：

1. 未设任何 API Key 时 `configured=true`，且所有请求都不带 `Authorization`；
2. `probe()` 判定 `native`、模型清单 `qwen3:8b`、SSE 可用；
3. 完整闭环：2 步、1 次真实 `calc` 执行、工具结果回喂、终答 `合计 30`、7 条轨迹事件、**未配对 tool_call = 0**、实际 provider 为 `ollama`；
4. 换 `unsupported` 模式时探针正确诊断并给出可操作建议；端点关闭后 `strict` 返回 `provider_error` 而非 Mock 伪成功。

**这证明的是协议与链路兼容，不是模型质量。** 更进一步，`npm run live:smoke` 用同一个仿真端点跑完整的 `runEval(mode=live)`：先过 `preflight`，再跑单任务闭环判分与 19 任务集稳定性，实测 28 个真实 HTTP 请求、27 个 SSE 流、13 次工具结果回喂、协议违规 0。产物 `data/live-link-smoke.json` 写死 `isModelCapabilityScore: false`，不写入外部证据通道、不进 L4、不改 `verdict`。

**这仍然不是模型能力分数**（指 `live:smoke`）。端点返回脚本化响应，完整任务集分数低是预期结果；真实分数见 §3.5 与 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md)。

### 3.5 第一份真实模型分数（轮 7 · 路线 B 实测）

在 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md) 的本地真实推理服务上（`llama.cpp` 0.3.36 + **Ollama 官方 registry 权重** qwen2.5:0.5b，`cpu.max` 4 核、`--threads 4`、`chatml-function-calling`），`preflight` 六项门禁全绿后执行 `eval --mode live`，产出 `data/eval-live-report.json`：

| 指标 | 实测值 |
| --- | --- |
| 总体得分 / pass@k | **0.0% / 0.0%** |
| 通过任务 | **0 / 12**（live 跳过 7 项脚本化用例） |
| 门禁 | **FAIL**（9 条阈值全部触发） |
| 协议违规 | **0**（零容忍达标） |
| 工具错误率 / Guard 触发率 | 0.0% / 0.0% |
| 平均步数 / 工具调用 | 1 / 0 |
| 平均延迟 / 总 token | 108151 ms / 35055 |
| 相对基线（确定性 → 真实） | `1 → 0` ⚠ 劣化 |

服务端累计 `data/local-llm-stats.json`：18 次**真实 CPU 前向推理**、13 次流式、35446 prompt tokens、105 completion tokens、`errors=0`、累计推理 1316s。

**怎么读这份 0 分**：

- 它是**真实**的：没有脚本化响应、没有伪造、没有降级到 Mock；`strict=true` 且端点全程在线。
- 它**不是框架能力结论**：协议违规 0、工具错误率 0、Guard 0，说明 Harness 链路正常；失败集中在「1 步 / 0 工具调用」—— 0.5B 模型在 26 个工具定义下不发起工具调用，直接终答或空答，正是 `probe()` 反复警告的退化模式。
- 它**实证了本文档的核心判断**：Mock 的 100% 与真实模型的 0% 可以同时成立，前者测 Harness、后者测模型 + Harness。
- 它**不改变领先度结论**：单模型 / 0.5B / CPU 4 核 / 内部任务集，`verdict` 仍 `not-proven`、L4 仍 `not-achieved`。要往前走需要 ≥3 个 provider 矩阵 + 公开基准 + 第三方复现，见 [BENCHMARK.md](./BENCHMARK.md)。
- 边界：服务端不是 Ollama 二进制，工具调用经 `chatml-function-calling` 协议适配，流式为 buffered-sse；详见 [docs/LOCAL-LLM.md §5](./docs/LOCAL-LLM.md)。

---

## 附：命令速查

| 命令 | 用途 |
| --- | --- |
| `npm test` | 87 项单元 / 端到端 / 故障注入 / RSI / meta / benchmark / external / preflight 回归 |
| `npm run verify` | L0–L7 结构自检 23 项 |
| `npm run eval` | 确定性能力评测 19 任务 + 门禁 + 基线 |
| `npm run eval:live` | 真实模型端到端评测（内置 preflight 门禁，报告写 `data/eval-live-report.json`） |
| `npm run eval -- --mode live --provider ollama --k 3` | 指定 provider + pass@3 |
| `AGENTOS_LIVE_PROVIDER=openai npm run eval:live` | 用环境变量切换 provider（不再硬编码 ollama） |
| `npm run doctor` | 模型接入诊断与 tool_calling 能力探针（面向人，永远 EXIT=0） |
| `npm run preflight` | 六项硬检查接入门禁，`ready=PASS`→EXIT=0，未就绪→EXIT=1 |
| `npm run preflight:check` | 门禁防误判 / 证据面隔离实证 37 项 |
| `npm run live:smoke` | live 全链路自检 17 项（仿真端点，**不是模型能力分数**） |
| `python3 tools/local-llm-server.py --threads 4` | 启动本地真实推理服务（路线 B，见 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md)） |
| `npm run ollama:check` | 离线 Ollama 协议实证 4 项 |
| `npm run demo` | 完整离线演示 |
| `npm run policy:check` | 5 个策略代码分支实证 19 项 |
| `npm run evolve` / `evolve:dry` | 能力面 RSI（改进固化到运行时 / 只诊断） |
| `npm run rsi:check` | RSI 端到端 + 4 个恶意候选注入 22 项 |
| `npm run meta` / `meta:dry` | meta RSI（改进改进机制自身） |
| `npm run meta:check` | 冻结 fitness / 元层写保护 / 单调晋升 25 项 |
| `npm run benchmark` | 7 变体 ablation + 5 级证据阶梯 + 领先度声明 |
| `npm run benchmark:check` | 测量机器诚实性 21 项 |
| `npm run external:check` | 外部证据导入防伪造 38 项 |

**推荐复现顺序**（报告之间有依赖：`benchmark` 会读其它报告）：

```
npm run evolve  →  npm run meta  →  npm run eval  →  npm run benchmark
```

[^ollama-docs]: Ollama 官方文档 · OpenAI compatibility：https://docs.ollama.com/api/openai-compatibility
[^compat-guide]: Local LLM OpenAI-Compatible API 指南：https://promptquorum.com/local-llms/local-llm-openai-compatible-api
