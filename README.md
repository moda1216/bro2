# bro2 · 通用 Agent 运行时

> **Model + Harness = Agent**
> 这不是一个聊天机器人，也不是一个固定功能的助手，而是一个**可组装、可替换、可观测的 Agent 运行时内核**。把模型、工具、工作区、权限、会话记忆和任务循环串起来；在上面挂不同的 Preset / Skill / Connector，就能得到不同形态的 Agent。
>
> 在此基础上，bro2 内置**两层可验证自我改进**：能力面 RSI 用 train/holdout 双门禁迭代**真实代码行为**（策略分派层）；meta RSI 用**冻结 fitness** 改进「如何找改进」，尺子本身在写保护面内。
> 同时提供**可证伪的能力基准**（7 变体 ablation + 5 级证据阶梯）。当前结论如实写为：`内部域证据充分，行业领先 not-proven`。

设计对齐 **DeepSeek Harness**（内核骨架：`Model + Harness = Agent`、一切皆插件、Trajectory 只增日志、生命周期拦截点、三级沙箱、模型无关）与 **WorkBuddy**（七层能力模型、层间依赖、行为可控/过程可溯/数据可管）。完整设计见 [DESIGN.md](./DESIGN.md)。

**技术栈**：TypeScript / Node.js 22，`node --experimental-strip-types` 原生运行，**零第三方依赖**。

**文档导航**：[docs/INDEX.md](./docs/INDEX.md) 是完整索引。核心四篇 —— [BENCHMARK.md](./BENCHMARK.md)（能力水平怎么判定）· [META-RSI.md](./META-RSI.md)（改进改进机制自身）· [ITERATIONS.md](./ITERATIONS.md)（本轮迭代日志）· [RSI.md](./RSI.md)（前沿调研与定位）。API 见 [docs/API.md](./docs/API.md)，真机接管见 [docs/TAKEOVER.md](./docs/TAKEOVER.md)。免费强模型接入见 [docs/FREE-LLM-APIS.md](./docs/FREE-LLM-APIS.md)，RSI 演进路线图（对齐 HARNESS²/Evo²/RRSI/OO-Harness）见 [docs/RSI-NEXT.md](./docs/RSI-NEXT.md)。

---

## 快速开始

环境要求：Node.js ≥ 22.6（本项目在 22.13 验证）。无需 `npm install`。

```bash
cd agent-os

# 1) 交互 CLI（离线 Mock 模型即可跑通完整闭环）
node --experimental-strip-types --no-warnings bin/agentos.ts

# 2) Headless 单次任务（CI 友好）
node --experimental-strip-types --no-warnings bin/agentos.ts run \
  --task "计算 sum([12,18,25,31,14]) 并写入 notes.md" --preset standard --auto-approve

# 3) Web UI + REST/SSE API
node --experimental-strip-types --no-warnings bin/agentos.ts web --port 3080
# 打开 http://127.0.0.1:3080

# 4) 完整离线演示（规划→技能→计算→记忆→并行子Agent→写报告→审批→终答）
node --experimental-strip-types --no-warnings examples/demo.ts

# 5) 能力矩阵自检 / 测试
node --experimental-strip-types --no-warnings examples/verify.ts
node --experimental-strip-types --no-warnings --test tests/*.test.ts

# 6) 能力评测（可判分任务集 + 回归门禁）/ 模型接入诊断
node --experimental-strip-types --no-warnings bin/agentos.ts eval --mode deterministic
node --experimental-strip-types --no-warnings bin/agentos.ts doctor
node --experimental-strip-types --no-warnings bin/agentos.ts preflight   # 接入门禁：ready=PASS 才继续
node --experimental-strip-types --no-warnings bin/agentos.ts eval --mode live

# 7) 离线 Ollama 协议实证（无需 GPU / 模型文件）
node --experimental-strip-types --no-warnings examples/ollama-check.ts

# 8) 能力面 RSI：系统自己迭代代码行为（--reset 从保守基线复现完整过程）
node --experimental-strip-types --no-warnings bin/agentos.ts evolve --reset
node --experimental-strip-types --no-warnings bin/agentos.ts evolve --reset --dry-run
node --experimental-strip-types --no-warnings examples/evolve-check.ts

# 9) 策略分派层实证 / meta RSI（改进改进机制自身）
node --experimental-strip-types --no-warnings examples/policy-check.ts
node --experimental-strip-types --no-warnings bin/agentos.ts meta
node --experimental-strip-types --no-warnings examples/meta-check.ts

# 10) 能力基准：ablation + 证据阶梯 + 领先度声明
node --experimental-strip-types --no-warnings bin/agentos.ts benchmark
node --experimental-strip-types --no-warnings examples/benchmark-check.ts
```

也可使用 `npm run cli | web | demo | verify | eval | eval:live | doctor | preflight | preflight:check | live:smoke | ollama:check | evolve | evolve:dry | rsi:check | policy:check | meta | meta:dry | meta:check | benchmark | benchmark:check | external:check | test`。
**能力评测体系见 [EVAL.md](./EVAL.md)；领先度判定见 [BENCHMARK.md](./BENCHMARK.md)；meta RSI 见 [META-RSI.md](./META-RSI.md)；迭代日志见 [ITERATIONS.md](./ITERATIONS.md)。**

### 接入真实模型（含 Ollama 本地部署）

所有 OpenAI Chat Completions 端点共用一个适配器，云端 API / vLLM / LM Studio / **Ollama** 只是 `baseUrl` 与认证策略不同，内核不感知差异。

**云端 / 任意 OpenAI 兼容端点：**

```bash
export OPENAI_BASE_URL="https://api.deepseek.com/v1"
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="deepseek-chat"
export AGENTOS_MODEL="openai"
```

**Ollama 本地模型（免 API Key）：**

```bash
ollama serve
ollama pull qwen3:8b                                    # 必须选带 tool-use 训练的模型
export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"      # 注意 /v1 前缀
export OLLAMA_MODEL="qwen3:8b"
export AGENTOS_MODEL="ollama"

npm run doctor          # 先诊断：端点 / 网络与认证 / SSE / 是否原生支持 tool_calls
npm run preflight       # 过门禁：ready=PASS 才继续，否则 EXIT=1 拒绝开跑
npm run live:smoke      # 沙箱内可跑：live 全链路自检（仿真端点，非模型能力分数）
npm run eval:live       # 再评测：strict 模式，报告写 data/eval-live-report.json
```

配置在 `agentos.config.json`，`${ENV_VAR}` 占位符由环境变量解析；密钥只从环境变量读取并做日志脱敏。本地端点（`localhost` / `127.0.0.1` / `::1`）自动免认证。

> **最常见的坑**：小参数量或未做工具微调的模型会忽略 `tools`，把工具调用写进正文甚至直接聊天。此时 Agent Loop 因「零 tool_calls」直接给出终答，**任务静默失败且不报错**。`doctor` 的能力探针会把这种情况判为 `text-json` / `unsupported` 并给出换模型建议。上下文窗口需通过 Modelfile 的 `num_ctx` 设置（OpenAI 兼容 API 无此字段）。
>
> 日常使用端点挂了会降级到离线 Mock 保证可用；评测 / CI 使用 `strict`，端点失败就明确报错。`preflight` 还会区分「网络不可达」与「401/403 认证被拒」，避免把 Key 错误误导成服务没起。本沙箱无 GPU 且装不上 Ollama 二进制（GitHub Release 出口受限），但已按 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md) 部署本地真实推理服务（llama.cpp + Ollama 官方权重），可直接 `npm run eval:live` 取得真实分数；`npm run ollama:check` 做协议级实证、`npm run live:smoke` 做仿真链路自检（**不是能力分数**）。若本地算力仍受限，可零本地部署地用**免费 LLM API**（OpenRouter / NVIDIA NIM / SiliconFlow / DeepSeek / Groq，均为 OpenAI 兼容）跑真实强模型——`npm run free:probe` 探测可达性，`AGENTOS_LIVE_PROVIDER=openrouter npm run eval:live` 一条命令出分数，见 [docs/FREE-LLM-APIS.md](./docs/FREE-LLM-APIS.md)。完整说明见 [EVAL.md §3](./EVAL.md) 与 [docs/TAKEOVER.md](./docs/TAKEOVER.md)。

---

## 架构：8 层 + 横切自我改进

| 层 | 职责 | 关键模块 |
| --- | --- | --- |
| **L0 内核** | ★ Agent Loop · 统一事件协议 · 7 个 Hook 点 · Trajectory 只增日志 · Session 恢复/分叉 · DI 容器 | `kernel/*` |
| **L1 模型** | LLM Adapter（Mock / OpenAI 兼容）· 多 provider 路由与熔断 · 上下文预算与摘要压缩 | `models/*`, `context/*` |
| **L2 工具** | 注册表 + 显式 JSON Schema · 执行运行时（超时/并行/结果归一）· 26 个内置工具 · MCP 连接器 · 插件热插拔 | `tools/*` |
| **L3 记忆** | 短期（Trajectory）/ 长期（跨会话）/ 工作记忆（scratchpad）· 检索注入 | `memory/*` |
| **L4 认知** | 规划 TODO · Skills 渐进披露 · Preset/Expert 声明式 Manifest | `cognition/*` |
| **L5 协作** | 子 Agent 派生/并行/汇总 · 定时自动化编排 | `delegation/*` |
| **L6 治理** | 三级沙箱 · HITL 审批 · Guards · 密钥脱敏与审计 | `governance/*` |
| **L7 交互** | 流式 CLI · Web UI（轨迹视图/审批弹窗）· REST+SSE API · 实时指标 | `interfaces/*`, `observability/*` |
| **横切：策略分派层** | 5 个可切换的**真实代码分支**（死循环判定 / 参数修复 / 终答接地 / 压缩 / 并行调度），RSI 改的是算法而非只调数字 | `runtime/policy.ts` + 各层分支 |
| **横切 RSI + meta RSI** | 失败挖掘 · 单原子算子 · 写保护评测面 · 影子评测 + holdout 治理守卫 · 单调晋升 · 只增账本 · **冻结 fitness 改进改进机制自身** | `rsi/*` |
| **横切：基准测量** | 5 级证据阶梯 · 7 变体 ablation · 冻结评分面 · 可证伪的领先度声明 | `benchmark/*` |

**核心数据流**（一个 Step = 一次模型请求 + 它发起的若干工具调用）：

```
PRE_STEP Hooks → ContextBuilder(系统提示/记忆/技能/工具 Schema) → 预算压缩
→ LLM(stream, tool_calls) → Trajectory.append → Guards(步数/token/时长/死循环)
→ Permission(allow/deny/ask) → HITL 审批 → PRE_TOOL Hooks → ToolRuntime
→ POST_TOOL Hooks → ToolResult 回喂 → 下一步 / 终答 → POST_RUN Hooks
```

每一步都从 Trajectory 重建模型可见消息——**日志是唯一数据源**，会话恢复、分叉、回放、统计、审计全部由它派生。

---

## 自我改进：能力面 RSI + meta RSI

定位是 **L3 完整 + 受限 L4（有界 RSI）**，明确不做 L5、不做权重更新、不做无监督闭环。三条硬约束：

1. **验证器写保护**：`eval.ts`、`scoring.ts`、`ladder.ts`、门禁阈值、train/holdout 任务集、治理源码做 SHA-256 完整性校验，每代重算；候选 patch 只能落在能力面白名单（对应 DGM 的 objective hacking 与 STOP 关闭 sandbox flag）。
2. **单调晋升**：候选在影子 root 应用 → train 评测 → holdout 独立评测（改进器不可见，**含治理不变量守卫**）→ 必须 train 严格提升、holdout 严格提升、双门禁 PASS、协议违规 0 才晋升；否则回滚并记入只增账本。
3. **递归有界**：改进机制自身由冻结 fitness 的实证成败更新（`Imp_t → Imp_{t+1}`），受代数 / 平台期 / eval 预算 / 漂移 tripwire / 拒绝缓冲约束。

### 能力面 RSI：迭代的是真实代码行为

`src/runtime/policy.ts` 把 5 个算法变体做成可切换策略（死循环判定 / 参数修复 / 终答接地 / 压缩 / 并行调度），
每个值对应各层的**实际代码分支**，`npm run policy:check` 19/19 逐条验证。RSI 的 patch 因此从「调数字」升级为「切算法」。

```
npm run evolve        # 正式跑：4 代单调提升，改进固化到 data/evolve/state.json
npm run rsi:check     # 22/22 断言，含 4 个恶意候选注入
npm run policy:check  # 19/19 断言，5 个策略分支真的生效且安全不变量不退化
data/evolve/ledger.jsonl   只增账本（保留全部候选，含被拒，DGM 式 archive）
data/evolve-report.json    演进报告（曲线 / 门禁 / 先验漂移 / 完整性）
```

| 代 | train | holdout | 事件 |
| --- | --- | --- | --- |
| 1 | 0.286 → 0.429 | 0.5 → 0.625 | 晋升 `malformedArgs: fail→repair` |
| 2 | 0.429 → 0.571 | 0.625 → 0.75 | 晋升 `grounding: off→require-evidence` |
| 3 | 0.571 → 0.714 | 0.75 → 0.875 | 晋升 `compaction: truncate→salience` |
| 4 | 0.714 → 0.857 | 0.875 → 1.0 | **拒绝** `loopDetection: advisory`（破坏 holdout 死循环守卫）；晋升 `parallel: fifo→risk-first` |

第 4 代是关键：系统在 train 上找到「有效」改进，却因破坏治理不变量被 holdout 拒绝。**通过门禁的 4 个策略自动落地到运行时**（`createAgentOS` 读取 `state.json`），评测器用 `evolvedState:false` 隔离该通道。

### meta RSI：改进「如何找改进」

`MetaState` 的 7 个维度（证据窗口 / 排序 / 算子集 / 平台期 / 破平局判据 / 预算自适应）由**冻结 fitness**（`src/benchmark/scoring.ts`）影子评测晋升，硬前提是能力不退化。

```
npm run meta          # 冻结 fitness 0.8879 → 0.9，eval 22 → 20，holdout 1 → 1
npm run meta:check    # 25/25 断言，含 lenient 等危险元候选拦截
data/evolve/meta-state.json   已晋升元状态，作用于下一次 evolve
data/meta-report.json         meta 报告 + 元层只增账本
```

详见 [META-RSI.md](./META-RSI.md) 与本轮完整 [ITERATIONS.md](./ITERATIONS.md)；前沿调研、验证层级、失败模式与边界见 [RSI.md](./RSI.md)。

---

## 能力矩阵（节选，完整版见 DESIGN.md §3）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Agent Loop 状态机 + 中断恢复 | ✅ | `AbortSignal` 贯穿模型/工具/子 Agent；断点从日志恢复 |
| 统一事件 + 7 个生命周期 Hook | ✅ | Hook 可批准 / 改写 / 记录 / 阻断，注册可逆 |
| Trajectory 只增日志 | ✅ | `writeSync` + `fsyncSync`，残缺末行容错，支持回放/分叉/检索 |
| 工具 Schema 与参数校验 | ✅ | 显式 JSON Schema + 严格校验，所有失败都回喂模型 |
| 内置工具集 | ✅ | 文件(6) / Shell / 安全计算 / HTTP / 时间 / 规划(2) / 技能(2) / 记忆(3) / 提问 / 协作(8) |
| MCP / 连接器桥接 | ✅ | JSON-RPC over HTTP 与 stdio，外部工具与内置工具走同一管线 |
| 三层记忆 + 检索 | ✅ | 长期记忆跨会话持久化，工作记忆 scratchpad |
| Skills 渐进披露 | ✅ | 系统提示只注入摘要，命中后 `skill_load` 加载全文 |
| 4 种 Preset + 自定义 Manifest | ✅ | standard / minimal / researcher / creator + `presets/analyst.json` 示例 |
| 子 Agent 并行 + 自动化编排 | ✅ | 隔离上下文与预算，深度限制防递归膨胀 |
| 三级沙箱 + HITL 审批 + Guards | ✅ | 路径白名单、高危命令拦截、审批队列、死循环检测 |
| 可观测性 | ✅ | 轨迹视图 + token/延迟/错误率指标 + 结构化日志 |
| CLI / Web UI / REST+SSE API | ✅ | 三套入口，Web 含工具卡片与审批弹窗 |
| **有界可验证自我改进** | ✅ | 写保护评测面 · 影子评测 + holdout · 单调晋升 · 只增账本 · 先验自更新 |
| **策略分派层（RSI 可改代码行为）** | ✅ | 5 个真实算法分支可切换，19/19 实证；安全不变量写进 holdout |
| **meta RSI（改进改进机制自身）** | ✅ | 冻结 fitness + 能力不退化硬门槛 + 元层写保护 + 只增元账本 |
| **可证伪的能力基准** | ✅ | 5 级证据阶梯 · 7 变体 ablation · 外部基准导入接口 · `not-proven` 诚实声明 |

---

## 工业级加固清单（已落实，并有测试）

1. 全链路超时与可传播取消（`AbortSignal` 贯穿模型 / 工具 / 子 Agent）
2. 工具执行子进程隔离 + 资源硬限制（超时 kill、输出截断、路径白名单）
3. Trajectory 原子追加 + `fsync` + 崩溃残缺末行容错，重启从断点恢复
4. 并发上限与背压（工具并行数受 `maxConcurrentTools` 约束）
5. 所有边界过 schema 校验（工具参数、模型响应、连接器返回）
6. 故障降级：多 provider 路由 fallback、连续失败熔断、请求重试、死循环检测
7. 结构化日志 + token / 延迟 / 错误率指标 + 轨迹可回放
8. 密钥独立环境变量通道，日志只留引用并脱敏；无全局可变状态
9. 单测 + 端到端 + 故障注入（畸形模型返回、工具超时、审批拒绝、步数越界、端点不可达、并行调用乱序）
10. 可判分能力评测与回归门禁（19 任务 / 6 类 / 任务集指纹 / 基线劣化检测），详见 [EVAL.md](./EVAL.md)
11. **写保护评测面 + tripwire + de-hardcoding**：评测器与运行时演进状态隔离，候选只能落在能力面白名单，禁止夹带留出集答案，防 reward hacking（详见 [RSI.md](./RSI.md)）

12. **冻结评分面 + 元层写保护**：fitness / 证据阶梯 / ablation 评分在 `PROTECTED_FILES` 内，元候选只能改 7 个有限枚举，禁止触碰验证层级（详见 [META-RSI.md](./META-RSI.md)）

**验证**：`131 / 131` 测试通过；`verify.ts` 23/23 覆盖 L0–L7；`eval` 19/19、总体 100%、未配对 tool_call 0、门禁 PASS；`evolve` 4 代单调提升、train 0.286→0.857 / holdout 0.5→1.0；`policy:check` 19/19；`rsi:check` 22/22（含恶意候选拦截）；`meta` fitness 0.8879→0.9 且能力不退化、`meta:check` 25/25；`benchmark` ablation 完整 10/10 vs 朴素 1/10、`benchmark:check` 21/21；Ollama 协议实证 4/4；`external:check` 38/38（外部证据防伪造）；`preflight:check` 37/37（接入门禁）、`live:smoke` 17/17（live 链路自检）；**轮 7** 本地真实推理服务 `preflight` 六项门禁全绿后 `eval:live` 得到第一份真实分数 `0.0%`（0/12，协议违规 0），见 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md)。

---

## REST + SSE API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 工具 / Preset / 技能 / 插件 / 模型 / 指标（`name: bro2`） |
| GET, POST | `/api/sessions` | 会话列表 / 新建会话 |
| POST | `/api/fork` | 会话分叉 |
| GET | `/api/trace?session=&limit=` | Trajectory 事件与统计 |
| GET | `/api/metrics` | 实时指标与近期时间线 |
| GET, POST | `/api/approvals`, `/api/approvals/:id` | 待审批 / 提交决定 |
| POST | `/api/chat` | **SSE 流式对话**（`chunk` / `event` / `done` / `error`） |
| POST | `/api/plugins` | 运行时热安装插件 |
| POST | `/api/connectors/http` | 挂载 HTTP MCP 连接器 |
| POST | `/api/model` | 切换模型 provider |

---

## CLI 命令

`/help` `/tools` `/presets` `/preset <name>` `/new` `/model <name>` `/sessions` `/fork` `/trace [n]` `/metrics` `/plugins` `/install <name>` `/approvals` `/quit`。任务输入中可用 `@path/file` 引用文件内容。

子命令：`run` · `web` · `eval` · `doctor` · `preflight` · `evolve` · `meta` · `benchmark`。
常用参数：`evolve --reset|--dry-run|--generations N`、`meta --rounds N|--generations N|--dry-run`、`eval --mode deterministic|live --provider <name> --k N`、全局 `--json`。

---

## 关键设计取舍（如实标注）

- **为什么是 TS / Node 22**：以「工业界水平」为硬约束——编译期类型安全、事件循环适合大量 SSE 长连接与并行工具调用、无 GIL、插件热插拔原生，且 DeepSeek Harness 本身即 Node 22。完整选型评审记录见 [DESIGN.md 附录 A](./DESIGN.md)。
- **零依赖运行**：`--experimental-strip-types` 只擦除类型、不做全量类型检查，也没有构建链。因此不能使用 `enum` / 参数属性等需转换的语法；**工具 JSON Schema 必须显式声明**（TypeScript 类型擦除），`defineTool<T>()` 把 schema 与 handler 放在一处，一致性由运行时校验与测试保证，而非编译器。
- **沙箱强度**：这是**应用层路径白名单沙箱**（含 `..` 逃逸与符号链接校验 + 高危命令拦截），**不是** OS 级隔离（bwrap / Landlock / Seatbelt）。文档明确标注，不夸大。
- **RSI 边界**：只做有界的能力面改进（budget 参数 + 5 个受控代码分支 + 技能增量）+ 7 个有限枚举的元参数改进，**不**改模型权重、**不**自动重写核心源码、**不**用 LLM judge/模型自评作为晋升信号、**不**宣称 L5 通用 RSI。离线确定性演示 ≠ 真实模型智能水平。详见 [RSI.md §6](./RSI.md) 与 [META-RSI.md §7](./META-RSI.md)。
- **「领先」边界**：内部 ablation 与证据阶梯是**可证伪的内部对照**，不是外部基准。当前 `leadership.verdict = not-proven`，缺公开基准与真实模型矩阵，判定逻辑见 [BENCHMARK.md](./BENCHMARK.md)。不拿 Mock 的 100% 冒充能力。
- **未实现**：完整 PTC（模型写程序批量调工具）、多设备云同步、企业权限体系、真实向量数据库、OS 级强隔离。接口保持可替换。
- **脱离本次交付**真要上生产的运行时，Go / Rust 是更稳的底座；本项目定位是「可读、可改、与设计逐条对应」的内核，不冒充生产底座。

---

## 目录

```
DESIGN.md                 架构设计 + 选型决议 + 附录 B/C（RSI / 策略层追加设计）
README.md                 本文件
EVAL.md                   能力评测体系 / 持续提升路线 / 真实模型接入指南
RSI.md                    RSI 前沿调研 + bro2 定位 + 边界
META-RSI.md               ★ meta RSI：改进改进机制自身 + 冻结 fitness
BENCHMARK.md              ★ 领先度可证伪评估：证据阶梯 / ablation / 外部基准接口
ITERATIONS.md             ★ 本轮多轮迭代日志（含被拒改动与未解决问题）
docs/INDEX.md  docs/API.md  docs/TAKEOVER.md   ★ 文档索引 / API / 真机接管手册
agentos.config.json       name=bro2 · 模型 / 权限 / 预算 / policy / 服务配置
bin/agentos.ts            CLI / Web / eval / doctor / preflight / evolve / meta / benchmark 入口
src/runtime/policy.ts     ★ 行为策略分派层（5 个真实代码分支的白名单解析）
src/benchmark/            ★ ladder · ablation · scoring · external（外部证据校验，写保护）· index
src/rsi/                  ★ types · ledger · guardrails · miner · operators · shadow · loop · meta
src/kernel/               ★ 内核：loop · events · hooks · trajectory · session · runtime
src/models/  src/context/  base · openai-compat · mock · router / builder · budget
src/tools/                registry · runtime · repair · schema · mcp · plugin · builtins/*
tools/local-llm-server.py  ★ 本地真实推理服务（Python，路线 B；与 src/tools/ 的 TS 工具层不同）
src/memory/  src/cognition/  src/delegation/  src/governance/
src/observability/        tracing · eval（评测框架 = 自我改进的验证器）
src/interfaces/           cli · api · web/index.html
skills/*/SKILL.md  presets/*.json
tests/*.test.ts           单元 + 端到端 + 故障注入 + 模型适配 + RSI / meta / benchmark / external / preflight / 双层叠加 / 对比式改进 live 回归（131 项）
examples/                 demo · verify · policy-check · evolve-check · meta-check · benchmark-check · external-check · ollama-*
data/eval-tasks.jsonl     可判分任务集（19 项 / 6 类）· eval-baseline.json（带指纹）
data/evolve/              train / holdout（写保护）· state · strategy · ledger · incidents
                          meta-state · meta-ledger（元层）
data/*-report.json        eval / eval-live / evolve / meta / benchmark 报告 + live-link-smoke.json（链路自检）
data/local-llm-stats.json 本地真实推理服务累计统计（requests / tokens / 推理秒数，非能力分数）
data/                     运行时产物（会话 / Trajectory / 记忆 / 工作区）
```

---

**验收结果**：`npm test` → 131/131；`npm run eval` → 19/19 门禁 PASS；`npm run evolve` → 4 代单调提升、改进固化到运行时；`policy:check` 19/19；`rsi:check` 22/22（防 reward hacking）；`npm run meta` → fitness 0.8879→0.9 且能力不退化、`meta:check` 25/25；`npm run benchmark` → ablation 完整 10/10 vs 朴素 1/10、证据阶梯 L0–L2 achieved / L4 not-achieved、`benchmark:check` 21/21、`external:check` 38/38；`demo` 6 步全链路、`verify` 23/23 覆盖 L0–L7、`ollama:check` 4/4；`preflight:check` 37/37（接入门禁防误判、证据面隔离）、`live:smoke` 17/17（live 全链路自检，明确非模型能力分数）、`preflight` 沙箱实测端点不可达 `EXIT=1`、指向就绪端点 `EXIT=0`；CLI headless 与 Web API 均已验证。**第一份真实模型分数（轮 7 · [路线 B](./docs/LOCAL-LLM.md)）**：本地真实推理服务（llama.cpp + Ollama 官方 registry 权重 qwen2.5:0.5b / CPU 4 核）过 `preflight` 六项门禁后，`eval:live` 实测 `overall 0.0%`（0/12）、门禁 FAIL、协议违规 0，18 次真实 CPU 推理、`errors=0`，报告 `data/eval-live-report.json`。

> **能力水平怎么读**：以上主要是**框架侧 + 确定性评测域**证据。轮 7 已在沙箱内用本地真实推理服务跑出第一份真实分数 `0.0%`（0/12）—— 这是 `qwen2.5:0.5b / CPU 4 核 / 单模型` 的真实结果，未粉饰；它实证了「Mock 100% 只说明 Harness 正确，不代表模型强」，同时因协议违规 0 / 工具错误率 0 而不构成对框架能力的否定。自我改进的增益只在**该评测域内**成立。项目明确给出 `leadership.verdict = not-proven`：要证明行业领先，还需公开基准对齐、≥3 个真实模型对比矩阵与第三方复现。**但「本地跑不了大模型」已不构成验证障碍**——免费 LLM API（OpenRouter/NIM 等，OpenAI 兼容）让 bro2 在真实强模型上跑 `eval:live` 只需一行命令（v2.0.6 已用 OpenRouter 免费 550B 模型实测：总体 41.7%（5/12 通过）、协议违规 0，见 `data/eval-live-report.json`）；且 harness 工程质量可在冻结模型下由 RSI 持续进化（对比式改进见 [src/rsi/contrast.ts](./src/rsi/contrast.ts)，演进路线见图 [docs/RSI-NEXT.md](./docs/RSI-NEXT.md)）。详见 [BENCHMARK.md](./BENCHMARK.md)、[EVAL.md](./EVAL.md)、[docs/TAKEOVER.md](./docs/TAKEOVER.md)、[docs/FREE-LLM-APIS.md](./docs/FREE-LLM-APIS.md) 与 [RSI.md §6](./RSI.md)。

---

## 开源协议

本项目采用 [MIT License](./LICENSE)。

```
MIT License · Copyright (c) 2026 moda1216
```

- 允许商用、修改、分发、再授权，唯一要求是保留版权声明与许可声明。
- 软件按「原样」提供，不附带任何明示或暗示的担保。
- 第三方模型服务（OpenAI 兼容端点 / 免费 LLM API）各自有独立的服务条款与额度政策，使用 bro2 接入它们时请遵守对应服务方条款；bro2 本身不含任何模型权重或凭据。

欢迎通过 Issue / Pull Request 参与。提交前请运行 `npm run project:status`，确保全部发布门禁仍为绿色；CI 会对每次 push / PR 复跑同一套离线验收门禁。
