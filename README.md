# bro2

> **Model + Harness = Agent** · 一个可组装、可替换、可观测的 Agent 运行时内核

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.6-339933.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-orange.svg)](./package.json)
[![Version](https://img.shields.io/badge/version-2.0.6-blueviolet.svg)](./CHANGELOG.md)

bro2 不是聊天机器人，也不是固定功能的助手。它把**模型、工具、工作区、权限、会话记忆与任务循环**装配成一个可运行的 Agent 内核：模型可换、工具可插、行为可审、每一步都可回溯。在上面挂不同的 Preset / Skill / Connector，就得到不同形态的 Agent。

- **零第三方依赖**：TypeScript / Node.js ≥ 22.6，`git clone` 后即可运行，无需 `npm install`、无需构建步骤。
- **模型无关**：一套 OpenAI 兼容适配器覆盖云端 API、Ollama / vLLM / LM Studio 本地部署与免 Key 公共网关；内置聚合器与本地协同层，把不稳定的远程端点收敛成唯一接口。
- **可验证**：内置可判分评测、接入门禁、能力基准与两级有界自我改进，任何改动都要过写保护的 train/holdout 双门禁才会晋升。

设计对齐 **DeepSeek Harness**（`Model + Harness = Agent`、一切皆插件、Trajectory 只增日志、模型无关）与 **WorkBuddy**（分层能力模型、行为可控 / 过程可溯 / 数据可管）。

---

## 目录

[产品特性](#产品特性) · [应用场景](#应用场景) · [快速开始](#快速开始) · [使用方法](#使用方法) · [架构概览](#架构概览) · [更新日志](#更新日志) · [能力现状与边界](#能力现状与边界) · [文档](#文档) · [开源协议](#开源协议)

---

## 产品特性

| 特性 | 说明 |
| --- | --- |
| **可组装的 Agent 内核** | 状态机 Loop、7 个生命周期 Hook、统一事件协议、会话恢复/分叉、DI 容器；Trajectory 只增日志是唯一数据源，回放/统计/审计全部由它派生。 |
| **模型无关 + 智能路由** | 云端 API / 本地 Ollama / 免 Key 网关共用一套适配器；`KeylessAggregator` 聚合多个免 Key 上游并做健康检查与限流故障转移；`HybridProvider` 把便宜/重复调用拦在本地与缓存；`LearnedRoutePolicy` 从跨会话经验学习「哪类请求本地就够」，越用越省。 |
| **工具与插件体系** | 26 个内置工具（文件 / Shell / 安全计算 / HTTP / 规划 / 记忆 / 协作…）、显式 JSON Schema 校验、子进程隔离与超时；MCP 连接器与运行时热插拔插件。 |
| **三层记忆 + 渐进披露** | 短期（Trajectory）/ 长期（跨会话）/ 工作记忆（scratchpad）；Skills 只把摘要注入系统提示，命中后再加载全文，节省上下文预算。 |
| **声明式 Agent 形态** | 4 种内置 Preset（`standard` / `minimal` / `researcher` / `creator`）+ 自定义 Manifest，配合 Skill 与 Connector 组合成垂直 Agent。 |
| **多 Agent 协作** | 子 Agent 派生、并行执行与结果汇总，隔离上下文与预算，深度限制防递归膨胀。 |
| **治理与可观测** | 三级沙箱、HITL 审批、Guards（步数 / token / 时长 / 死循环）、密钥脱敏与审计；轨迹视图、实时指标、结构化日志。 |
| **三套入口** | 流式 CLI、Web UI（轨迹视图 + 审批弹窗）、REST + SSE API，覆盖交互、演示与集成。 |
| **有界可验证自我改进** | 能力面 RSI 用 train/holdout 双门禁迭代真实代码行为；meta RSI 用冻结 fitness 改进「如何找改进」。验证器写保护、单调晋升、只增账本、防 reward hacking。 |
| **复利式自我改进** | `ExperienceBank` 按失败模式沉淀已验证的有效解，Propose 阶段直接命中，收敛所需探测次数随使用递减；`VelocityLedger` 用冻结尺子度量改进速度，样本不足不宣称加速。经验只裁剪探测集、绝不绕过行为判定。 |
| **可证伪的能力基准** | 5 级证据阶梯、7 变体 ablation、冻结评分面、外部证据校验；领先度结论如实标注而非自评。 |

---

## 应用场景

| 场景 | bro2 提供什么 |
| --- | --- |
| **本地 / 私有化 Agent** | 接 Ollama 或本地推理服务，数据不出内网；路径白名单沙箱、高危命令拦截与人工审批兜底敏感操作。密钥只走环境变量并脱敏。 |
| **多模型接入与成本控制** | 一个配置里并列多个云端 / 免 Key / 本地 provider；聚合器处理限流故障转移，协同层用缓存与本地承接减少远程调用，`InferenceStats` 量化远程开销。 |
| **Agent 框架教学与研究** | 8 层内核逐层可读、零依赖、设计与实现逐条对应；适合用来理解「Harness 如何决定模型表现」，以及做分层 ablation 实验。 |
| **自我改进 / RSI 实验台** | 写保护评测面、影子评测 + holdout 治理守卫、冻结 fitness、只增账本、对比式改进判定，为 harness-only 改进研究提供可复现、可证伪的闭环。 |
| **CI 能力回归** | 可判分任务集 + `preflight` 接入门禁 + `eval` / `eval:live`，在模型或端点升级前后做量化对比；发布门禁 `project:status` 可直接进流水线。 |
| **二次开发底座** | Preset / Skill / Connector / MCP / 插件均为可替换扩展点，可在此之上构建垂直领域 Agent，而不必重写 Agent Loop。 |

---

## 快速开始

**环境**：Node.js ≥ 22.6（在 22.13 验证）。零第三方依赖，无需安装。

```bash
git clone https://github.com/moda1216/bro2.git
cd bro2

# 交互 CLI —— 离线 Mock 模型即可跑通完整闭环
npm run cli

# 完整离线演示 —— 规划 → 技能 → 计算 → 记忆 → 并行子 Agent → 报告 → 审批 → 终答
npm run demo

# Web UI + REST/SSE API —— 浏览器打开 http://127.0.0.1:3080
npm run web
```

单次任务（headless，适合脚本与 CI）：

```bash
npm run cli -- run --task "计算 sum([12,18,25,31,14]) 并写入 notes.md" --preset standard --auto-approve
```

> 所有命令都基于 `node --experimental-strip-types` 原生执行 TypeScript，等价的直接调用形式为
> `node --experimental-strip-types --no-warnings bin/agentos.ts <子命令>`。

---

## 使用方法

### 命令行

| 命令 | 用途 |
| --- | --- |
| `npm run cli` | 交互式 CLI（`/help` `/tools` `/presets` `/model` `/trace` `/approvals` …） |
| `npm run demo` | 6 步全链路离线演示 |
| `npm run web` | Web UI + REST/SSE 服务（默认 `127.0.0.1:3080`） |
| `npm run doctor` | 模型端点诊断：可达性 / 认证 / SSE / 是否原生支持 `tool_calls` |
| `npm run preflight` | 接入门禁，`ready=PASS` 才放行，否则 `EXIT=1` 拒绝开跑 |
| `npm run eval` | 确定性能力评测与回归门禁 |
| `npm run eval:live` | 真实模型评测（先过 `preflight`），报告写 `data/eval-live-report.json` |
| `npm run evolve` | 能力面 RSI 自我改进 |
| `npm run evolve:tick -- --rounds 8` | 推进 8 轮真实迭代，把「越用越快」写进跨会话只增账本 |
| `npm run watermark` | 查看迭代水位（趋势 / 探测成本 / 经验复用），打开 `data/rsi/watermark.html` 看曲线 |
| `npm run ship` | **改进即同步**：提交全部改动 + 推送 GitHub 远程 + 同步自检（复用仓库外 PAT 凭证） |
| `npm run ship -- --rounds 8 "<msg>"` | 先推进 8 轮真实迭代，再提交并推送 |
| `npm run push:check` | 只读检查本地是否已全部同步到远程，漏推即报错 |
| `npm run meta` | meta RSI：改进改进机制自身 |
| `npm run benchmark` | 能力基准：ablation + 证据阶梯 + 领先度声明 |
| `npm run project:status` | 聚合全部发布阻断门禁，CI 友好 |
| `npm test` | 全量单元测试（131 项） |

子命令：`run` · `web` · `eval` · `doctor` · `preflight` · `evolve` · `meta` · `benchmark`；全局 `--json` 输出机器可读结果。

### 接入真实模型

所有 OpenAI Chat Completions 端点共用一个适配器，云端 API / vLLM / LM Studio / Ollama 只是 `baseUrl` 与认证策略不同，内核不感知差异。配置集中在 `agentos.config.json`，`${ENV_VAR}` 占位符由环境变量解析；本地端点自动免认证，密钥只从环境变量读取并做日志脱敏。

**云端 / 任意 OpenAI 兼容端点**

```bash
export OPENAI_BASE_URL="https://api.deepseek.com/v1"
export OPENAI_API_KEY="<你的 API Key>"
export OPENAI_MODEL="deepseek-chat"
export AGENTOS_MODEL="openai"
```

**本地 Ollama（免 API Key）**

```bash
export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"   # 注意 /v1 前缀
export OLLAMA_MODEL="qwen3:8b"                        # 需选带 tool-use 训练的模型
export AGENTOS_MODEL="ollama"
```

**免 Key / 免费强模型（无需本地 GPU）**

```bash
npm run free:probe                                    # 探测可用免费端点
export OPENROUTER_API_KEY="<你的 API Key>"
export OPENROUTER_MODEL="nvidia/nemotron-3-ultra-550b-a55b:free"
AGENTOS_LIVE_PROVIDER=openrouter npm run eval:live    # 一行命令出真实分数
```

内置 provider：`openai` · `ollama` · `openrouter` · `nvidia-nim` · `siliconflow` · `deepseek` · `groq` · `pollinations` · `kilo` · `keyless`（免 Key 聚合器）· `hybrid`（本地 + 远程协同）· `mock`（离线）。

> **选型提示**：小参数量或未做工具微调的模型常会忽略 `tools`，把工具调用写进正文，导致任务静默失败。`doctor` 的能力探针会把这类情况判为 `text-json` / `unsupported` 并给出换模型建议。日常使用端点故障会降级到离线 Mock 保证可用；评测与 CI 使用 `strict`，端点失败明确报错。

详细接入指南见 [EVAL.md §3](./EVAL.md) · [docs/FREE-LLM-APIS.md](./docs/FREE-LLM-APIS.md) · [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md)。

### REST + SSE API（节选）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/status` | 工具 / Preset / 技能 / 插件 / 模型 / 指标 |
| `GET, POST` | `/api/sessions` | 会话列表 / 新建会话 |
| `POST` | `/api/fork` | 会话分叉 |
| `GET` | `/api/trace` · `/api/metrics` | Trajectory 事件 / 实时指标 |
| `GET, POST` | `/api/approvals` | 待审批 / 提交决定 |
| `POST` | `/api/chat` | SSE 流式对话（`chunk` / `event` / `done` / `error`） |
| `POST` | `/api/plugins` · `/api/connectors/http` · `/api/model` | 热安装插件 / 挂载 MCP / 切换模型 |

完整 API 见 [docs/API.md](./docs/API.md)。

---

## 架构概览

| 层 | 职责 |
| --- | --- |
| **L0 内核** | Agent Loop · 统一事件 · 7 个 Hook · Trajectory 只增日志 · Session 恢复/分叉 · DI 容器 |
| **L1 模型** | LLM Adapter · 多 provider 路由与熔断 · 上下文预算与压缩 |
| **L2 工具** | 注册表 + JSON Schema · 执行运行时 · 26 个内置工具 · MCP · 插件热插拔 |
| **L3 记忆** | 短期 / 长期 / 工作记忆 + 检索注入 |
| **L4 认知** | 规划 TODO · Skills 渐进披露 · Preset/Expert Manifest |
| **L5 协作** | 子 Agent 派生 / 并行 / 汇总 · 自动化编排 |
| **L6 治理** | 三级沙箱 · HITL 审批 · Guards · 密钥脱敏与审计 |
| **L7 交互** | 流式 CLI · Web UI · REST + SSE · 实时指标 |
| **横切** | 策略分派层 · RSI + meta RSI · 能力基准测量 |

一个 Step = 一次模型请求 + 它发起的若干工具调用：

```
PRE_STEP Hooks → ContextBuilder → 预算压缩 → LLM(stream, tool_calls)
→ Trajectory.append → Guards → Permission → HITL 审批 → ToolRuntime
→ ToolResult 回喂 → 下一步 / 终答 → POST_RUN Hooks
```

每一步都从 Trajectory 重建模型可见消息——日志是唯一数据源，会话恢复、分叉、回放、统计、审计全部由它派生。完整设计见 [DESIGN.md](./DESIGN.md)。

---

## 更新日志

| 版本 | 日期 | 要点 |
| --- | --- | --- |
| **2.2.2** | 2026-11-08 | 修复 CI 验收门禁失败：移除测试对本机凭证的路径依赖，新增 CI 可移植性门禁 |
| **2.2.1** | 2026-11-08 | 改进即推送：唯一推送通道 + 一键 `ship` 闭环 + 防漏推门禁，复用持久化 PAT 凭证 |
| **2.2.0** | 2026-11-08 | 进化启动器 + 迭代水位看板：真实评测驱动、跨会话只增账本、水位变化可视化 |
| **2.1.0** | 2026-11-08 | 复利中枢：跨会话经验库、冻结速度尺子、学习型路由（越用越快 / 越用越省） |
| **2.0.6** | 2026-11-08 | 打通 OpenRouter 免费 550B 强模型的真实评测通路，取得首份真实模型分数 |
| **2.0.5** | 2026-11-08 | 免 Key 网状 + 本地协同双层叠加；对比式改进 live 闭环（防 reward hacking） |
| **2.0.4** | 2026-11-08 | 无 Key 端点统一聚合器 `KeylessAggregator`（健康评分 / 限流故障转移） |

完整发布记录（含 2.0.0–2.0.3）见 [CHANGELOG.md](./CHANGELOG.md)，演进计划见 [ROADMAP.md](./ROADMAP.md)，产出物登记见 [DELIVERABLES.md](./DELIVERABLES.md)。

---

## 能力现状与边界

bro2 对自身能力保持可证伪的诚实标注：

- 已在 OpenRouter 免费 550B 模型上跑通 `eval:live`（总体 41.7%、协议违规 0）。这是**单模型 / 单任务集 / k=1** 的实测，不是领先证据。
- 内部 ablation 与证据阶梯是**内部对照**，不是公开基准。当前 `leadership.verdict = not-proven`、证据阶梯 L4 = `not-achieved`。
- 自我改进是**有界的 harness-only 改进**：不改模型权重、不自动重写核心源码、不用模型自评作为晋升信号。
- 沙箱是**应用层路径白名单**（含逃逸与符号链接校验、高危命令拦截），**不是** OS 级隔离。
- 离线确定性演示用于验证 Harness 正确性，不等于真实模型智能水平。

判定逻辑与边界详见 [BENCHMARK.md](./BENCHMARK.md) · [RSI.md](./RSI.md) · [META-RSI.md](./META-RSI.md)。

---

## 文档

[docs/INDEX.md](./docs/INDEX.md) 是完整索引。按用途：

- **设计与架构** — [DESIGN.md](./DESIGN.md) · [docs/API.md](./docs/API.md)
- **评测与基准** — [EVAL.md](./EVAL.md) · [BENCHMARK.md](./BENCHMARK.md)
- **自我改进** — [RSI.md](./RSI.md) · [META-RSI.md](./META-RSI.md) · [docs/RSI-NEXT.md](./docs/RSI-NEXT.md) · [ITERATIONS.md](./ITERATIONS.md)
- **接入与运维** — [docs/FREE-LLM-APIS.md](./docs/FREE-LLM-APIS.md) · [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md) · [docs/TAKEOVER.md](./docs/TAKEOVER.md)
- **工程管理** — [CHANGELOG.md](./CHANGELOG.md) · [ROADMAP.md](./ROADMAP.md) · [DELIVERABLES.md](./DELIVERABLES.md)

---

## 开源协议

本项目采用 [MIT License](./LICENSE) · Copyright (c) 2026 moda1216。允许商用、修改、分发、再授权，唯一要求是保留版权与许可声明；软件按「原样」提供，不附带任何担保。

第三方模型服务（OpenAI 兼容端点 / 免费 LLM API）各有独立的服务条款与额度政策，接入时请遵守对应服务方条款；bro2 本身不含任何模型权重或凭据。

欢迎通过 Issue / Pull Request 参与。提交前请运行 `npm run project:status`，确保全部发布门禁仍为绿色；CI 会对每次 push / PR 复跑同一套离线验收门禁。项目维护者可用 `npm run ship` 一次性完成「提交 + 推送 + 同步自检」，避免本地已提交但远程未同步。
