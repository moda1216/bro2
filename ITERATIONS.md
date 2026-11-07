# bro2 · 迭代日志（本轮）

> 记录「基于已有 RSI 框架不断迭代代码」的**每一轮**：发现了什么、改了什么、用什么证据判定、结果如何。
> 目的是让每次改动可复核、可回滚，而不是留一句"已优化"。
> 相关设计：[DESIGN.md 附录 C](./DESIGN.md) · [META-RSI.md](./META-RSI.md) · [BENCHMARK.md](./BENCHMARK.md) · [docs/TAKEOVER.md](./docs/TAKEOVER.md)

---

## 轮 0 · 现状审计（不改代码）

对上一版 bro2 做能力盘点，确认三个真实缺口：

| 缺口 | 证据 |
| --- | --- |
| RSI 只能改 5 个数字参数 + 1 段技能文本，**碰不到代码行为** | `EvolvableState` 只有 `budget.*` 与 `skillOverlays.*`；`ALLOWED_EXACT_PATHS` 白名单 |
| meta 层只是算子权重公式漂移，未经过影子评测晋升 | `updateStrategyWeights` 硬编码 `+0.2/-0.1/-0.15`，`LedgerEntry.decision="meta"` 不参与判定 |
| 「领先」没有测量机器 | 只有 `verify.ts` 结构自检与自建 eval，无 ablation、无证据分级、无外部基准接口 |

同时确认**写保护不会阻碍开发期改代码**：`computeIntegrity` 在每次 `runEvolve` 启动时取 baseline，之后同轮内对比 —— 它防的是**运行期候选篡改验证器**，不是禁止开发者迭代框架。这条区分是后续所有改动的前提。

---

## 轮 1 · 策略分派层：让 RSI 能改「代码行为」

**改动**（新增 `src/runtime/policy.ts` + 5 处内核分支）：

| 策略 | 保守值 | 增强值 | 真实代码分支 |
| --- | --- | --- | --- |
| `loopDetection` | exact | advisory | `guards.ts`：连续相同调用先软警告 + 注入纠错提示，累计才硬终止 |
| `malformedArgs` | fail | repair | `tools/repair.ts` + `tools/runtime.ts`：工具名/参数名唯一近似修复、JSON 字符串解析，每步写 `tool.repair` 事件，**不补缺失必填** |
| `grounding` | off | require-evidence | `kernel/loop.ts`：工具全失败且无成功证据时，终答被打回一次并注入提示 |
| `compaction` | truncate | salience | `context/budget.ts`：压缩摘要优先完整保留成功工具结果 |
| `parallel` | fifo | risk-first | `tools/runtime.ts`：同一步按风险等级排序调度 |

配套：`EventType` 新增 3 类可观测事件；`RuntimeConfig.policy` + `parsePolicy` 严格白名单；`createAgentOS` 把它注入 Guards / ToolRuntime / BudgetManager / AgentLoop；`runtime_status` 与 `/api/status` 暴露当前策略。

**证据**：`npm run policy:check` → **19/19**，逐条断言 5 个分支真的产生不同事件；同时验证安全不变量（t15 空参数、t16 无关工具名、t18 死循环硬终止）在保守值下完全不变。

**回归**（轮 1 当时的快照）：`npm test` 44/44、`npm run eval` 19/19 门禁 PASS —— 保守默认值等价于引入前的行为。新增 meta / benchmark / external / preflight 测试后最终以 87/87 收口，见文末复现命令。

---

## 轮 2 · RSI 扩展到策略面：系统自己迭代代码

**改动**：`EvolvableState.policy` 纳入可改进面；新增 5 个策略切换算子；`guardrails` 加策略枚举白名单；`shadow` 把 policy 写进影子 config；`miner` 加 `policy` 失败类别并把证据窗口扩到 12。

**关键设计：把安全不变量写进 holdout**，让系统自己学会取舍而非由人硬编码"哪些能改"：

- train 7 个任务（2 个稳定对照 + 5 个策略行为任务）；
- holdout 8 个任务 = 5 个**同类不同表面**的迁移验证 + 3 个**治理不变量守卫**（空参数不得凭空补值、死循环必须硬终止、无关工具名不得模糊匹配）。

**实证**（`npm run evolve -- --reset`，报告 `data/evolve-report.json`）：

| 代 | train | holdout | 事件 |
| --- | --- | --- | --- |
| 1 | 0.286 → 0.429 | 0.5 → 0.625 | 晋升 `malformedArgs: fail→repair` |
| 2 | 0.429 → 0.571 | 0.625 → 0.75 | 晋升 `grounding: off→require-evidence` |
| 3 | 0.571 → 0.714 | 0.75 → 0.875 | 晋升 `compaction: truncate→salience` |
| 4 | 0.714 → 0.857 | 0.875 → 1.0 | **拒绝** `loopDetection: advisory`（train 有效但破坏 holdout 死循环守卫）；同代晋升 `parallel: fifo→risk-first` |
| 5–6 | 0.857 | 1.0 | 被拒候选进入拒绝缓冲，防振荡，收敛 |

- 保护面 19 文件（当时）SHA-256 未变更；协议违规 0；晋升 4 / 拒绝 1 / 拦截 2。
- 算子先验漂移：4 个成功算子 1→1.2，advisory 1→0.7。
- **改进真实落地**：`data/evolve/state.json` 写入 4 个增强策略，`createAgentOS` 默认加载；评测器用 `evolvedState:false` 隔离，主评测 19/19 不回归。

> 第 4 代是本轮最有价值的一幕：系统在 train 上找到一个"有效"的改进，但因为破坏了治理不变量被 holdout 拒绝。没有 holdout 守卫，这个改动会被当成成功晋升。

---

## 轮 3 · meta RSI：改进「如何找改进」

**改动**：新增 `src/rsi/meta.ts` + `src/benchmark/scoring.ts`（冻结 fitness）；`miner` / `operators` / `loop` 参数化 7 个元维度；`evolvePaths` 支持 `scratchDir` 隔离账本；`runEvolve` 默认加载已晋升的 `meta-state.json`。

**实证**（`npm run meta`，报告 `data/meta-report.json`）：

| 轮 | 结果 |
| --- | --- |
| 1 | `plateauPatience 2→1`：冻结 fitness **0.8879 → 0.9**，eval **22 → 20**，holdout **1 → 1**；其余 5 候选被拒 |
| 2 | 5 候选 fitness 均未严格提升，收敛 |

能力不退化、写保护面未变更、晋升 1 / 拒绝 10。`meta-state.json` 写入 `plateauPatience=1` 并作用于下一次 evolve —— `Imp_t → Imp_{t+1}` 真实发生。`npm run meta:check` **25/25**（含 `lenient` 等危险值拦截）。

详见 [META-RSI.md](./META-RSI.md)。

---

## 轮 4 · 把「领先」变成可证伪的测量机器

**改动**：新增 `src/benchmark/{ladder,ablation,index}.ts`；`EvalOptions` 加 `configOverride` / `useEvolvedState`；评测新增策略行为断言；CLI 加 `benchmark` 子命令。

**实证**（`npm run benchmark`，报告 `data/benchmark-report.json`）：

- ablation 7 变体 / 10 个纯行为任务：完整 bro2 **10/10**，保守基线 7/10，朴素单轮 1/10；三个策略各贡献 +0.100；`no-parallel` 本域 0 贡献，如实标注。
- 证据阶梯自动判定：L0–L2 achieved、L3 partial、**L4 not-achieved**；`leadership.verdict = not-proven`。
- `npm run benchmark:check` **21/21**，重点验证"测量机器诚实"（L4 不给自己发满级、声明带可证伪条件）。

详见 [BENCHMARK.md](./BENCHMARK.md)。

---

## 轮 5 · 外部证据入口的可信化（接「下一步」）

**发现**：上一轮把「导入 `data/benchmark/external-results.json` 让 L4 升级」列为下一步，核查实现却发现 `EXTERNAL_RESULT_SCHEMA` 只是说明性常量、**从未参与判定**；`ladder.ts` 只数 `results.length`，还把 bro2 自己生成的 `benchmark-report.json` 里的 `external` 字段算作外部证据。写一行 `{"results":[{}]}` 即可把 L4 从 `not-achieved` 提到 `partial`。这是项目全程防范的 self-confirming loop，却恰好失守在唯一能提升「领先」等级的入口上。

**改动**：

| 文件 | 内容 |
| --- | --- |
| `src/benchmark/external.ts`（新增，纳入写保护面） | `validateExternalResult` / `loadExternalResults`：字段严格白名单、必填 6 项、类型与范围、`score ∈ [0,1]`、真实日历日期且不晚于今天、可执行复现命令、禁止 `verdict / proven / ...` 等结论字段、置信区间合法性 |
| `src/benchmark/ladder.ts` | 只认专门导入文件且只统计通过校验的记录；移除内部报告计入；新增 `externalValidation` 摘要（含被拒索引与原因）；`verdict` 收窄为恒 `not-proven`；`EXTERNAL_RESULT_SCHEMA` 与校验器同源 |
| `src/benchmark/index.ts` | 报告新增「【外部证据校验】」段；中间态不再写 `external` 占位 |
| `src/rsi/guardrails.ts` | `PROTECTED_FILES` 19 → 20（校验器与尺子同等保护） |
| `tests/external.test.ts` / `examples/external-check.ts`（新增） | 19 项单测 + 38 项防伪造实证 |
| `docs/TAKEOVER.md`（新增） | 真机接管手册：live 基线 → 跨 provider 矩阵 → 公开基准 → 外部结果导入 |

**实证**：`npm test` 61 → **80/80**；`npm run external:check` **38/38**；`npm run benchmark` / `benchmark:check` 仍 21/21；L4 保持 `not-achieved`、`verdict = not-proven`。实证全程只在临时目录写文件，真实 `data/benchmark/external-results.json` 未被创建。

**关键拒绝**：`{"results":[{}]}`、自带 `verdict`、未来日期、占位复现命令、`benchmark-report.json` 手塞 `external` —— 五类伪造均不能升级 L4；合法记录最多把 L4 提到 `partial`，`verdict` 仍恒为 `not-proven`。

**仍未解决**：真实模型分数、公开基准对照、第三方复现依然缺位 —— 校验器只保证「证据格式可信」，不产生结论。

---

## 轮 6 · 拿第一份真实分数，打通接入基础设施（接「下一步」）

**目标与诚实结论**：用户要求「拿第一份真实分数，打通基础设施」。先做真实环境探测：无 API Key、无本地 Ollama / GPU；`api.deepseek.com` 与 `dashscope.aliyuncs.com` 返回标准 401（**网络可达、只缺认证**），`api.openai.com` 出口超时。因此**沙箱物理上拿不到真实模型能力分数**，编造一份就是本项目全程防范的 self-confirming loop。本轮改为把「除模型权重外的每一环」做成机器可判定的基础设施。

**发现的真实缺陷**：

| 缺陷 | 证据 |
| --- | --- |
| `eval:live` 无条件覆盖 `data/eval-report.json` | `bin/agentos.ts` 对所有 mode 写同一路径；`TAKEOVER.md §1.4` 还明确让用户这么做 → 一次失败的 live 尝试把 L1 从 `achieved` 打回 `partial` |
| `doctor` 永远 `EXIT=0`，不能当门禁 | 端点全不可达时实测 `EXIT=0` |
| 401/403 与网络不可达混为一谈 | `probe()` 只记 `reachable=false`，真机上把「Key 错」误导成「服务没起」 |
| `eval:live` 硬编码 `--provider ollama` | `package.json` 写死，用云端端点得改命令；`AGENTOS_MODEL` 被显式 flag 覆盖 |

**改动**：

| 文件 | 内容 |
| --- | --- |
| `src/models/openai-compat.ts` | `ModelProbeResult` 增加 `networkReachable` / `authRejected` / `httpStatus`；`probe()` 区分网络故障与认证拒绝；新增 `endpoint` / `targetModel` getter；`doctor` 输出 network / auth 两行 |
| `src/models/preflight.ts`（新增） | 六项硬检查（配置 / 网络 / 认证 / 模型 / SSE / 原生 tool_calls）→ `ready` + `blockers` + `nextSteps`；`formatPreflight`；未配置时不发网络请求 |
| `bin/agentos.ts` | 新增 `preflight` 子命令（`--provider` / `--all` / `--json`，未就绪 `EXIT=1`）；`eval:live` 内置门禁；live 报告改写 `data/eval-live-report.json`；provider 由 `AGENTOS_LIVE_PROVIDER` 指定 |
| `package.json` | `eval:live` 去掉硬编码；新增 `preflight` / `preflight:check` / `live:smoke` |
| `examples/live-smoke.ts`（新增） | 进程外真实 HTTP/SSE 端点 → `preflight` → `runEval(mode=live)` 单任务闭环 + 19 任务集；产物显著标注 `isModelCapabilityScore: false` |
| `tests/preflight.test.ts` / `examples/preflight-check.ts`（新增） | 7 项单测 + 37 项防误判实证 |
| `docs/TAKEOVER.md` | 重写 §0/§1/§6：沙箱实测诊断表、两级诊断、链路自检、真机步骤、报告隔离表 |

**实证**：`npm test` 80 → **87/87**；`preflight:check` **37/37**（含 401 与网络故障指引分离、证据面隔离）；`live:smoke` **17/17**：28 个真实 HTTP 请求、27 个 SSE 流、13 次工具结果回喂、协议违规 0、单任务闭环判分通过；`preflight` 沙箱实测 `EXIT=1`，指向就绪端点 `EXIT=0`。确定性报告保持 `mode=deterministic / overall=1`，`external-results.json` 未被创建，L4 仍 `not-achieved`、`verdict = not-proven`。

**关键拒绝**：没有往 `data/benchmark/external-results.json` 写任何示例值，没有把 `live:smoke` 的分数冒充真实能力，没有让门禁失败时产出会被误读的低分报告。

**仍未解决（轮 6 当时的快照）**：真实模型能力分数、公开基准对照、第三方复现依然缺位 —— 这些必须由人在真机上跑出来，基础设施只保证「一有端点就能得到可信分数」。轮 7 已取得单点真实分数，见下。

---

## 轮 7 · 部署本地真实推理服务，拿到第一份真实模型分数（接「继续做下一步」）

**目标与诚实结论**：用户允许部署本地模型服务，要求做「差的那一步」。环境探测发现 GitHub Release 出口被墙（连 15KB 校验文件都 `http=000` 超时），8 个代理最快 ~250KB/s、1.5GB 官方包需 ~1.7 小时，清华 / 中科大 / 阿里 / 腾讯镜像均无 Ollama → **官方 Ollama 二进制装不了**。但 `registry.ollama.ai`（Ollama 官方模型仓库）2.28MB/s 可用、pypi 镜像可用。改用**等效方案**：从 Ollama 官方 registry 取真实 GGUF 权重，用 `llama.cpp` 起提供同一 OpenAI Compat 契约的本地推理服务 —— **bro2 内核零改动**，`doctor` / `preflight` / `eval:live` 原样接入。

**环境事实（实测，非推测）**

| 项 | 值 |
| --- | --- |
| `cpu.max` / `nproc` | `400000 100000` = **4 核配额** / 32（宿主机视图，误导） |
| `memory.max` | **8GB**（`free` 显示 123Gi 是宿主机） |
| Ollama 官方权重 | qwen2.5:0.5b GGUF，397807936 bytes，魔数 `GGUF` |
| 推理后端 | `llama-cpp-python` 0.3.36 预编译 CPU wheel（经 gh-proxy 取回） |

**改动**

| 文件 | 内容 |
| --- | --- |
| `tools/local-llm-server.py`（新增） | 标准库 HTTP + SSE 的 OpenAI Compat 端点；`/v1/models`、`/v1/chat/completions`（流式 / 非流式 / tools）、`/health`、`/stats`、`/api/tags`；真实推理统计原子落盘 |
| `docs/LOCAL-LLM.md`（新增） | 部署手册、可复现下载命令、5 个实测坑、端点契约、诚实边界 |

**发现的真实缺陷（都是实测踩出来的）**

| 缺陷 | 影响 / 修复 |
| --- | --- |
| `pip` 编译 `llama-cpp-python` 报 `Killed signal cc1plus` | ninja 按 `nproc=32` 并行，8GB 内存被 OOM → 改用预编译 wheel |
| GitHub Release 连 15KB 校验文件都下不了 | 出口策略 → 权重只从 `registry.ollama.ai` 取；wheel 走代理 |
| `Invalid wheel filename` | 保存名不合 PEP 427 → 重命名为原始 wheel 名 |
| **单次 9-token 请求 24s、每个评测任务 ~100s** | `--threads 8` 超订阅 4 核配额，`nr_throttled=8015` → **`--threads 4`**，短请求 0.09s、带 tools 6.8s（提速 15–250×） |
| qwen 模板把工具调用输出成 `<tool_call>` 文本 | `tool_calls=null` → `chat_format="chatml-function-calling"` 产出标准 `tool_calls` |

**实证**：`preflight` 六项门禁全绿（配置 / 网络 / 认证 / 模型 / SSE / 原生 tool_calls）；`eval:live` 完整 12 任务跑完并产出 `data/eval-live-report.json` —— `overall 0.0%`（0/12）、门禁 FAIL、协议违规 0、工具错误率 0、平均 1 步 / 0 工具调用；服务端累计 18 次真实 CPU 推理、35446 prompt tokens、`errors=0`。确定性报告保持 `mode=deterministic / overall=1`，`external-results.json` 未创建，L4 仍 `not-achieved`、`verdict = not-proven`。

**关键拒绝**：没有编一份分数冒充真实能力；没有把 `0.0%` 说成「框架不行」或「领先」（协议违规 0 说明 Harness 链路正常，失败源是 0.5B 模型不调用工具）；没有把这份内部任务集分数写进 `external-results.json` 去升级 L4；没有隐藏「服务端不是 Ollama 二进制 / 工具调用有协议适配 / 流式为 buffered-sse」这三条边界。

**仍未解决**：≥3 provider 对比矩阵、公开基准对照、第三方复现依然缺位 —— 单点 0.5B CPU 真实分数不能外推，也不是外部比较证据。

**收尾修复（回归隔离）**：全量回归时发现 `live:smoke` 16/17、`preflight:check` 35/36 两条退化，根因唯一 —— 轮 7 真实 `eval:live` 落盘的 `data/eval-live-report.json` 残留，而两测试原断言「该文件必须不存在」（服务停掉不影响轮 6 的「沙箱无端点」类断言）。修复：① 把真实分数**归档副本** `data/first-real-live-report.json` 永久保留为第一份真实分数的证据；② 把两测试断言从「文件必须不存在」改为「测试前后该文件指纹未变」（`sniffFile` 状态比对），兼容「已有真实报告」与「无报告」两种状态，且仍能在 `runEval`/CLI 偷偷写文件时立刻暴露。修复后 `live:smoke` 17/17、`preflight:check` 37/37（新增「被阻断的 eval:live 退出码非 0」断言），全量回归 14 命令全绿；文档 `36/36 → 37/37` 一并同步。

---

## 过程中修掉的真实缺陷（累计）

| 轮次 | 缺陷 | 影响 |
| --- | --- | --- |
| 早期 | 工具参数校验失败未回写 Trajectory | 真实 OpenAI 端点因 `tool_calls` 缺配对结果返回 400 |
| 早期 | 压缩阈值与硬熔断共用 `maxTokens` | 压缩永远来不及生效就被熔断（评测 `t11` 暴露） |
| 早期 | 审批 pending 登记晚于 UI 通知 | 同步 resolve 丢失 |
| 早期 | `tool_calls` 按 `.sort(()=>0)` 无效；本地端点强制 API Key | 真实模型 / Ollama 接入失败 |
| 本轮 | `require("node:fs")` 在 ESM 下不可用（`meta.ts`） | 元状态保存崩溃，改为静态 import |
| 本轮 | `META_FORBIDDEN` 检查晚于 `META_KEYS` | 伪造验证面字段只报"未知维度"，归因不清 |
| 本轮 | evolve 测试污染真实只增账本 | 引入 `scratchDir` 隔离 |
| 本轮 | 旧 holdout 答案样本不足，de-hardcoding 断言失效 | 补足 ≥4 字符答案样本 |
| 轮 6 | `eval:live` 无条件覆盖 `data/eval-report.json` | 失败的 live 尝试会把证据阶梯 L1 打回 `partial` 并抹掉确定性证据；改为写 `data/eval-live-report.json` |
| 轮 6 | 401/403 被笼统报成「端点不可达」 | 把「Key 错」误导成「服务没起」；`probe()` 增加 `networkReachable` / `authRejected` / `httpStatus` 分级 |
| 轮 6 | `preflight:check` 用 `spawnSync` 调本地 HTTP 端点 | 同步阻塞父进程事件循环导致服务器无法响应、子进程超时自死锁；改异步 `spawn` |
| 轮 7 | `nproc` 被当作真实 CPU 核数设 `--threads 8` | 4 核 cgroup 配额下线程超订阅触发限流，单次推理 24s、评测任务 ~100s；对齐 `--threads 4` 后降到 0.09s / 6.8s |
| 轮 7 | `pip` 源码编译按 32 并行 | 8GB 内存 OOM（`Killed signal cc1plus`）；改用预编译 wheel |
| 轮 7 | 把 qwen 模板的文本 `<tool_call>` 直接当 `tool_calls` | `preflight` 会判 `text-json` 而 BLOCKED；用 `chatml-function-calling` 做协议适配 |

---

## 被拒绝的改动（同样重要）

| 改动 | 拒绝原因 |
| --- | --- |
| `loopDetection: advisory` | train 提升但破坏 holdout「死循环必须硬终止」治理不变量 |
| 5 个元候选（收窄证据窗口 / 换排序 / 裁剪算子 / 平台期扩预算 / 破平局判据） | 冻结 fitness 未严格提升 |
| 技能增量（补操作级指导） | 脚本化模型不加载技能，无法被外部断言验证 |
| 危险元候选 `promotionStrictness: lenient` | 元层白名单 critical 拦截 |

---

## 仍未解决 / 下一步

1. **真实模型基线（单点已取得，矩阵仍缺）**：轮 7 已用本地真实推理服务跑出第一份真实分数 `0.0%`（0/12，qwen2.5:0.5b / CPU 4 核 / 单模型），见 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md)。**仍缺 ≥3 provider 对比矩阵**：单点低分既不能归因框架、也不能外推通用能力，更不是从 L3 到 L4 的外部比较证据。
2. **公开基准对齐**：BFCL / τ-bench / GAIA / SWE-bench 类基准尚未接入；`BENCHMARK_FAMILIES` 只是分类映射。外部结果导入的**校验器已就绪**（`external.ts` + `external:check` 38/38），但真实分数仍需真机，流程见 [docs/TAKEOVER.md](./docs/TAKEOVER.md)。
3. **跨 provider 矩阵**：接口与探针就绪，缺 ≥3 个真实模型对比。
4. **fitness 校准**：`area = mean(curve)` 对不同长度曲线非严格同尺度，权重 0.6/0.4 是设计选择；换任务域应重新校准。
5. **元候选集有限**：只有 6 个预设改动，不做开放式机制搜索（有界 RSI 的自觉约束）。

复现全部结论：`npm test && npm run verify && npm run eval && npm run evolve && npm run meta && npm run benchmark && npm run external:check`。
