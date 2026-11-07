# bro2（Agent OS）设计方案

> 版本：v1.0 · 设计阶段产物（先设计、后动工）
> 目标：实现一个**通用 Agent 运行时**（Agent Harness / Agent OS），对齐 WorkBuddy 与 DeepSeek Harness 的能力模型，满足 "Agent OS" 的基本能力要求。

---

## 1. 定位：我们到底在造什么

一句话公式（来自 DeepSeek Harness）：

> **Model + Harness = Agent**

模型负责"想"，Harness 负责"其余全部"——工具、工作区、权限、会话记忆、任务循环、可观测性、人机交互。本项目的产物**不是一个聊天机器人，也不是一个固定功能的助手，而是一个可组装、可替换、可观测的运行时内核**。在这个内核上挂不同的 Preset / Skill / Connector，就能得到不同形态的 Agent（编码助手、研究助手、办公助手、定时任务执行器）。

两个参照物各自贡献了什么：

| 参照物 | 贡献的设计要点 | 本文档对应章节 |
| --- | --- | --- |
| DeepSeek Harness | `Model + Harness = Agent`、"一切皆插件"、可逆副作用/热插拔、**Trajectory 只增日志**、生命周期拦截点、三级沙箱、Guards、模型无关、四种预设模式、PTC、MCP 与 hooks 桥接、CLI/Web/SDK/ACP 五种用法 | §2、§4、§6、§8、§9、§10 |
| WorkBuddy | **七层能力模型**（L0 身份记忆 → L1 技能 → L2 工具执行 → L3 连接器/MCP → L4 资料库 → L5 自动化编排 → L6 专家 → L7 多端同步）、层间依赖、行为可控/过程可溯/数据可管、高危操作拦截 | §3、§5、§8、§10 |

**关键判断**：七层模型不是并列的功能菜单，而是**层层向上依赖**的。L1 技能会调用 L2 工具和 L3 连接器；L5 自动化执行的是提示词，其质量取决于 L0 记忆与 L1 技能。因此内核必须**先有统一的事件流与工具契约**，再往上叠能力，否则各层会各自长大却串不起来。

---

## 2. 六条设计原则

| # | 原则 | 落地方式 |
| --- | --- | --- |
| P1 | **内核极小，一切可替换** | 模型适配器、工具注册表、会话存储、循环本身都通过接口注入；内核只定义契约，不绑定实现 |
| P2 | **统一事件流，只增不改** | 所有进入/离开模型的信息都写成 append-only 的 `Event`，落到 Trajectory（JSONL）；恢复、分叉、回放、审计全部基于它 |
| P3 | **声明式组装** | 一个 Agent = 一个 `Preset`（Manifest）：系统提示、可见工具、技能、模型、权限策略、子智能体、预算上限，纯配置、可版本化 |
| P4 | **分层依赖，逐级构建** | 严格按 §3 的 L0→L7 顺序实现与验收，禁止跳层堆功能 |
| P5 | **安全默认最小权限** | 三级沙箱（只读 / 工作区可写 / 完全访问）+ 工具风险等级 + 高危操作人工审批 + 密钥不进日志 + Guards |
| P6 | **模型无关 + 离线可跑** | 走 OpenAI 兼容协议（任意 provider / 网关）；同时内置脚本化 Mock 模型，无 API Key 也能完整演示 Agent 闭环 |

---

## 3. Agent OS 能力矩阵（验收清单）

这是"满足 Agent OS 基本能力要求"的**逐条验收标准**，每一条都必须有可运行代码，而不是接口占位。

| 层 | 能力 | 具体要求 | 实现模块 |
| --- | --- | --- | --- |
| **L0 内核** | Agent Loop | `observe → think → act → observe` 状态机；最大步数、终止条件、中断/恢复 | `kernel/loop.py` |
| | 统一消息协议 | `Message` / `Event` 结构，覆盖文本、思考、工具调用、工具结果、上下文注入、错误 | `kernel/events.py` |
| | 事件总线与生命周期 | 7 个拦截点：`PRE_RUN / PRE_STEP / POST_STEP / PRE_TOOL / POST_TOOL / ON_ERROR / POST_RUN`；Hook 可批准、改写、记录、阻断 | `kernel/hooks.py` |
| | Trajectory | 只增不改 JSONL；记录系统提示、推理、工具调用与结果、子 agent 调度、上下文注入、耗时与 token；支持回放 / 恢复 / 分叉 / 检索 | `kernel/trajectory.py` |
| | 会话 | Session 创建、持久化、恢复、分叉（fork）、自动标题 | `kernel/session.py` |
| **L1 模型** | LLM Adapter | 抽象基类 + OpenAI 兼容实现 + Mock 实现；流式输出、tool calling、token 统计、超时重试 | `models/*` |
| | 多模型路由 | 按 Preset 或按任务切换 provider，失败降级 | `models/router.py` |
| | 上下文与预算 | 系统提示组装、工具 schema 注入、历史裁剪、超预算自动摘要压缩 | `context/*` |
| **L2 工具** | 工具注册表 | 装饰器注册、从类型注解自动生成 JSON Schema、参数校验、风险标注 | `tools/registry.py` |
| | 工具运行时 | 同步/异步执行、超时、异常捕获、结果归一化、并行调用 | `tools/runtime.py` |
| | 内置工具集 | 文件读写/编辑、目录与内容搜索、Shell、HTTP 请求、计算、TODO、记忆读写、提问用户 | `tools/builtins/*` |
| | 连接器 / MCP | 外部工具源统一挂载到同一管线；提供 MCP 风格桥接与插件注册接口 | `tools/mcp.py`, `tools/plugin.py` |
| **L3 记忆** | 三层记忆 | 短期（会话内）、长期（跨会话持久化）、工作记忆（scratchpad） | `memory/store.py` |
| | 检索 | 关键词 + 简易向量/相关度检索，注入上下文 | `memory/retrieval.py` |
| **L4 认知** | 规划与任务 | 任务分解、TODO 状态机、进度追踪、计划先审后执行 | `cognition/plan.py` |
| | 技能 Skills | `SKILL.md` 技能包，渐进披露（先注入摘要，命中后加载全文） | `cognition/skills.py` |
| | 专家 / Preset | 声明式 Manifest，四种预设模式（见 §10） | `cognition/preset.py` |
| **L5 协作** | 子智能体 | 派生子 Agent、隔离上下文与预算、并行执行、结果汇总 | `delegation/subagent.py` |
| | 自动化编排 | 定时/事件触发、后台任务、进度查询 | `delegation/automation.py` |
| **L6 治理** | 权限与沙箱 | 三级沙箱、路径白名单、工具风险等级、白/黑名单 | `governance/permissions.py` |
| | 人工介入 HITL | 高危操作审批队列、向用户提问、审批可记忆 | `governance/approval.py` |
| | Guards | 步数/token/时长上限、重复调用与死循环检测、超时中断 | `governance/guards.py` |
| | 审计与密钥 | 密钥走独立通道、日志只留引用、脱敏 | `governance/audit.py` |
| **L7 交互** | CLI | 流式对话、工具调用实时回显、`/commands`、`@files` | `interfaces/cli.py` |
| | Web UI | 单页界面：对话流、工具调用卡片、Trajectory 轨迹视图、会话切换、审批弹窗 | `interfaces/web/` |
| | API / SDK | REST + SSE 流式接口，可直接被第三方调用 | `interfaces/api.py` |
| | 可观测性 | 轨迹视图、token/耗时统计、状态面板 | `observability/tracing.py` |

---

## 4. 总体架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L7  交互层   CLI  │  Web UI  │  REST+SSE API  │  Python SDK              │
├──────────────────────────────────────────────────────────────────────────┤
│ L6  治理层   Permissions(三级沙箱) │ Approval/HITL │ Guards │ Audit       │
├──────────────────────────────────────────────────────────────────────────┤
│ L5  协作层   Sub-Agent 派生/并行/汇总      │  Automation 定时编排         │
├──────────────────────────────────────────────────────────────────────────┤
│ L4  认知层   Planning/TODO  │  Skills(渐进加载)  │  Preset/Expert Manifest │
├──────────────────────────────────────────────────────────────────────────┤
│ L3  记忆层   短期/长期/工作记忆  │  检索  │  Session 持久化/恢复/分叉    │
├──────────────────────────────────────────────────────────────────────────┤
│ L2  工具层   Registry(Schema) │ Runtime │ Builtins │ MCP/Plugin 桥接      │
├──────────────────────────────────────────────────────────────────────────┤
│ L1  模型层   LLM Provider(Mock / OpenAI-compatible) │ Router │ Context/Budget│
├──────────────────────────────────────────────────────────────────────────┤
│ L0  内核层   ★ Agent Loop ★  Event Bus  │  Hooks  │  Trajectory  │  Message│
└──────────────────────────────────────────────────────────────────────────┘
       所有层共享：Event 协议 · 依赖注入容器 · 配置 · 只增日志
```

**依赖方向**：上层依赖下层，L0 不依赖任何上层。L0 的 Event Bus 是全局脊柱——L6 的审批、L7 的 UI、L5 的子 agent 调度，都是订阅事件流的"插件"，而不是硬编码在循环里的分支。

---

## 5. 核心数据流：Agent Loop 状态机

```
User Task
   │
   ▼
[Session.bootstrap] ── 加载 Preset / 长期记忆 / 技能摘要 / 历史
   │
   ▼
┌─────────────────────────── STEP (循环) ───────────────────────────┐
│  PRE_RUN / PRE_STEP Hooks（可阻断、可改写）                        │
│        │                                                          │
│        ▼                                                          │
│  ContextBuilder：system + preset + memory + skills + tool schemas  │
│        │  ── 超预算 → 摘要压缩 + 裁剪                              │
│        ▼                                                          │
│  LLM.complete(messages, tools, stream)  →  Trajectory.append      │
│        │                                                          │
│        ├── 无 tool_call ──► 最终回答 ──► POST_RUN Hooks ──► 持久化 ──► END
│        │                                                          │
│        └── 有 tool_call(s)                                        │
│              ▼                                                    │
│        Guards 检查（步数 / token / 时长 / 重复调用检测）           │
│              ▼                                                    │
│        PermissionPolicy.check(tool, args) → allow / deny / ask    │
│              ├── deny → 写入拒绝事件，回喂模型                     │
│              └── ask  → HITL 审批队列（CLI 确认 / Web 弹窗）       │
│              ▼                                                    │
│        PRE_TOOL Hooks → ToolRuntime.execute（超时/异常归一）        │
│              ▼                                                    │
│        POST_TOOL Hooks → ToolResult → Trajectory.append            │
│              ▼                                                    │
│        POST_STEP Hooks → 回到 STEP 起点                            │
└───────────────────────────────────────────────────────────────────┘
```

**Step / Turn 定义**（对齐 Harness）：一次模型请求 + 它发起的若干工具调用 = 一个 Step；从用户任务到完成 = 一个 Turn。每个 Step 边界、工具执行前后、模型请求前都是 Hook 拦截点。

**中断与恢复**：任意 Step 都可因审批、错误、用户中断而暂停；因为 Trajectory 只增不改，恢复 = 重放日志 + 从断点继续；分叉 = 复制日志前缀后写入新分支。

---

## 6. 关键抽象与接口契约

```python
# ---- 消息与事件 ----
Message(role, content, tool_calls=None, tool_call_id=None, name=None, meta={})
Event(seq, ts, turn, step, type, payload)   # type: message|thinking|tool_call|
                                            # tool_result|inject|approval|error|hook
LLMResponse(content, tool_calls=[], reasoning=None, usage=Usage(in,out,total))

# ---- 工具 ----
ToolDef(name, description, parameters: JSONSchema, handler,
        risk: Literal["safe","write","danger"], timeout_s=30)
@tool(name=..., risk=...)   # 从类型注解自动生成 JSON Schema

# ---- 模型 ----
class LLMProvider(Protocol):
    def complete(self, messages, tools=None, stream=False) -> LLMResponse: ...
    def stream(self, messages, tools=None) -> Iterator[Chunk]: ...

# ---- 治理 ----
class PermissionPolicy(Protocol):
    def check(self, tool: ToolDef, args: dict) -> "allow|deny|ask": ...

# ---- Hook ----
HookPoint = PRE_RUN | PRE_STEP | POST_STEP | PRE_TOOL | POST_TOOL | ON_ERROR | POST_RUN
HookResult(action="continue|block|modify", payload=None, reason=None)

# ---- 声明式组装 ----
AgentPreset(name, system_prompt, model, tools=["*"], skills=[], subagents=[],
            permission_level="workspace-write",
            budget=Budget(max_steps=30, max_tokens=60000, max_seconds=600))
```

**依赖注入容器**：内核持有一个 `Runtime`（注册表 + 配置 + 事件总线 + provider + 存储）。任何组件都通过 `Runtime` 拿到依赖，替换实现 = 换一次注册，不改内核代码——这就是 P1「一切可替换」的最小实现（不引入完整插件框架，但保留可逆注册 / 卸载语义）。

---

## 7. 目录结构

```
/workspace/agent-os/
├── DESIGN.md                  # 本设计文档
├── README.md                  # 快速开始 / 能力说明
├── requirements.txt
├── agentos/
│   ├── __init__.py            # 导出高层 API: Agent, Runtime, Preset
│   ├── kernel/
│   │   ├── events.py          # Message / Event / EventBus / 枚举
│   │   ├── loop.py            # ★ AgentLoop 状态机
│   │   ├── hooks.py           # HookPoint / HookManager
│   │   ├── trajectory.py      # append-only JSONL / 回放 / 分叉
│   │   ├── session.py         # Session 生命周期
│   │   └── runtime.py         # 依赖注入容器（组件注册表）
│   ├── models/
│   │   ├── base.py            # LLMProvider 抽象 + Usage
│   │   ├── openai_compat.py   # OpenAI 兼容（含流式与 tool calling）
│   │   ├── mock.py            # 脚本化 Mock 模型（离线可跑）
│   │   └── router.py          # 多 provider 路由 / 降级
│   ├── context/
│   │   ├── builder.py         # 系统提示与上下文组装
│   │   └── budget.py          # token 估算 / 裁剪 / 摘要压缩
│   ├── tools/
│   │   ├── registry.py        # @tool 装饰器 + Schema 生成
│   │   ├── runtime.py         # 执行、超时、并行、结果归一
│   │   ├── builtins/          # file / shell / search / http / calc / todo / memory / ask
│   │   ├── mcp.py             # MCP 风格连接器桥接
│   │   └── plugin.py          # 可逆注册 / 热插拔
│   ├── memory/
│   │   ├── store.py           # 三层记忆 + 持久化
│   │   └── retrieval.py       # 检索与注入
│   ├── cognition/
│   │   ├── plan.py            # TODO / 计划状态机
│   │   ├── skills.py          # SKILL.md 渐进加载
│   │   └── preset.py          # 四种预设 + Manifest 解析
│   ├── delegation/
│   │   ├── subagent.py        # 派生 / 并行 / 汇总
│   │   └── automation.py      # 定时与后台任务
│   ├── governance/
│   │   ├── permissions.py     # 三级沙箱 + 风险策略
│   │   ├── approval.py        # HITL 审批队列
│   │   ├── guards.py          # 步数/token/时长/循环检测
│   │   └── audit.py           # 密钥脱敏
│   ├── observability/
│   │   └── tracing.py         # 轨迹统计 / 视图数据
│   └── interfaces/
│       ├── cli.py             # 流式 CLI + /commands
│       ├── api.py             # FastAPI REST + SSE
│       └── web/index.html     # 单页 UI（轨迹视图 / 审批）
├── skills/                    # 示例技能包（SKILL.md）
├── presets/                   # standard / minimal / creator / researcher
├── tests/                     # 单元 + 端到端闭环测试
└── examples/                  # 离线演示脚本
```

---

## 8. 治理与安全模型

| 维度 | 设计 |
| --- | --- |
| 三级沙箱 | `read-only`：只读工具；`workspace-write`：写操作限制在工作区路径内；`danger-full-access`：放开（需显式声明） |
| 工具风险 | 每个工具标注 `safe / write / danger`；`danger` 与越界写操作默认触发审批 |
| 审批 | 审批请求也是 Event，进入队列；CLI 交互确认、Web 弹窗；支持"本次会话始终允许" |
| Guards | `max_steps` 步数、`max_tokens` 预算、`max_seconds` 墙钟、连续相同工具调用检测（死循环）、工具超时中断 |
| 密钥 | 凭据通过环境变量 / 独立配置通道注入，日志只写引用名，输出脱敏 |
| 可溯 | Trajectory 只增不改，任何决策（含拒绝与审批）都有事件记录 |

---

## 9. 可观测性：Trajectory 日志格式

一行一个 JSON 事件，字节级 append-only：

```json
{"seq":12,"ts":"2026-11-07T07:20:01.123","turn":1,"step":3,
 "type":"tool_result","payload":{"call_id":"c3","name":"shell",
 "ok":true,"elapsed_ms":41},"usage":{"in":4820,"out":310}}
```

由此派生：轨迹视图（逐步展开模型看到的一切）、token/耗时统计、会话恢复、分叉、跨会话检索、自动标题。这是"过程可溯"的唯一数据源，**不做第二套状态存储**。

---

## 10. 预设模式（一个 Agent = 一份 Manifest）

| Preset | 装载内容 | 用途 |
| --- | --- | --- |
| `standard` | 全量工具 + 技能 + 规划 + 子 agent + workspace-write | 默认通用助手 |
| `minimal` | 仅 Shell + 文件编辑 + 无技能 | 基准测试 / 教学 / 低 token |
| `researcher` | 搜索/HTTP/文件 + 子 agent 并行 + 只读优先 | 资料查证与报告 |
| `creator` | standard + 运行时自省 + 插件热插拔 | 造插件 / 造 Preset |

会话一旦有内容即锁定 Preset（否则历史里的工具调用无法解释）。

---

## 11. 技术选型与里程碑

**选型**：Python 3.11（沙箱原生、AI 生态友好、依赖少）；标准库为主，Web 层用 FastAPI + SSE；前端单文件原生 HTML/JS；存储用文件系统 JSONL；LLM 走 OpenAI 兼容 HTTP 协议（无需 SDK，可指向任意网关）。无 API Key 时用内置 Mock 模型跑完整闭环。

| 里程碑 | 交付内容 | 验收 |
| --- | --- | --- |
| M1 内核闭环 | Event/Loop/Hooks/Trajectory/Session + Mock LLM + 工具注册与执行 | 一条任务能跑完"模型→工具→回喂→回答"，日志可回放 |
| M2 能力层 | 上下文预算、三层记忆、规划、Skills、权限/审批/Guards、内置工具集 | 能力矩阵 L1–L4、L6 逐条可测 |
| M3 协作与扩展 | 子 agent、连接器/MCP 桥接、插件热插拔、自动化编排 | 能派生子 agent 并行完成子任务并汇总 |
| M4 交互与交付 | CLI + Web UI（轨迹视图、审批）+ REST/SSE API + 测试 + 文档 | 离线演示跑通，README 可复现 |

---

## 12. 明确不做的事（范围边界）

- 不实现 OS 级强隔离（bwrap/Landlock/Seatbelt）；用路径白名单做**应用层**沙箱，并在文档中如实标注隔离强度。
- 不实现完整 PTC（模型写程序批量调工具），仅保留接口位置与简化版批量调用能力。
- 不实现多设备云同步、企业权限体系、真实向量数据库；用文件存储 + 简易检索替代，接口保持可替换。
- 不绑定任何特定模型厂商；不内置任何真实 API Key。

> 以上边界保证交付物是**可运行、可验证、可继续扩展**的 Agent OS 内核，而不是一堆空接口。

---

## 附录 A · 实现决议 v1.1（最终生效）

> 本附录记录动工前的选型评审结论。**§7 目录结构与 §11 选型为初版 Python 草案，保留作为选型对比记录；实际实现以本附录为准。能力矩阵（§3）、架构（§4）、主循环（§5）、治理（§8）、Trajectory（§9）、Preset（§10）全部不变。**

### A.1 决策

| 项 | 结论 |
| --- | --- |
| 交付深度 | 完整可运行框架（L0–L7 全覆盖 + CLI + Web UI + 测试） |
| 模型接入 | Mock + OpenAI 兼容双通道，无 Key 也能离线跑完整闭环 |
| **技术栈** | **TypeScript / Node.js 22.13**，`node --experimental-strip-types` 原生运行，**零第三方依赖** |

### A.2 为什么从 Python 改为 TypeScript / Node 22

评审中提出「要工业界水平」这一硬约束后，结论变更。先澄清前提：工业级 Agent OS 的耗时与故障几乎不来自语言运行时（一个 turn 中模型推理 0.5–30s、工具 I/O 几十 ms 至数秒、语言执行开销 < 10ms），真正决定水平的是并发隔离、故障恢复、状态一致性、资源硬限制与边界校验——**这些是架构与工程实践，不是语言**。但若必须二选一：

| 维度 | Python 3.11 | TS / Node 22 | 更接近工业级 |
| --- | --- | --- | --- |
| 类型安全 / 边界校验 | 注解可选，靠 pydantic 补 | 编译期强制 + 运行时 schema | TS |
| 大量 SSE 长连接 / 并行工具 | asyncio 可用，但同步工具必须显式丢线程池，否则阻塞事件循环 | 事件循环原生，空闲长连接内存更省 | TS |
| 长驻进程稳定性 | GIL / 内存碎片 / CPU 密集需多进程 | V8 成熟，无 GIL | TS 略优 |
| CPU / 数据密集工具 | numpy/pandas 走 C 扩展释放 GIL | 单线程会卡，需 worker_threads | Python |
| 插件热插拔 / 可逆副作用 | 需自建注册表 | ESM 动态 import 原生，贴近参照实现 | TS |
| 工业级参考实现背书 | — | DeepSeek Harness 本身即 Node 22 | TS |

Python 的优势（开发效率、类型注解自动生成 JSON Schema、数据生态）在「工业界水平」约束下权重下降；且 Node 22 的 strip-types 让 TS 也能**零第三方依赖**启动，把 Python 唯一占优的「依赖少、攻击面小」补齐了。

**代价（如实标注）**：TS 类型擦除，工具 JSON Schema 无法从类型注解自动生成，必须显式声明；工程上用 `defineTool<T>()` 泛型 + `satisfies` 把 handler 签名与 schema 对齐，由测试保证二者不漂移。strip-types 只擦除类型、不做全量类型检查，故不能使用 `enum` / `namespace` / 参数属性等需转换的语法（用 `as const` + union type 替代）。

### A.3 最终目录结构（以本节为准）

```
/workspace/agent-os/
├── DESIGN.md · README.md · package.json · agentos.config.json
├── bin/agentos.ts                 # CLI / Web 入口
├── src/
│   ├── index.ts                   # 高层 API
│   ├── kernel/    events · loop · hooks · trajectory · session · runtime
│   ├── models/    base · openai-compat · mock · router
│   ├── context/   builder · budget
│   ├── tools/     registry · runtime · mcp · plugin · builtins/*
│   ├── memory/    store · retrieval
│   ├── cognition/ plan · skills · preset
│   ├── delegation/subagent · automation
│   ├── governance/permissions · approval · guards · audit
│   ├── observability/tracing
│   └── interfaces/cli · api · web/index.html
├── skills/*/SKILL.md · presets/*.json · tests/*.test.ts · examples/*.ts
└── data/                          # 运行时：会话、Trajectory、记忆、工作区
```

零依赖映射：HTTP 服务 = `node:http`，SSE = 手写分块流，模型请求 = 内置 `fetch`，测试 = `node:test` + `node:assert`，文件与子进程 = `node:fs` / `node:child_process`，定时器 = `node:timers`。

### A.4 工业级加固清单（无论语言都落实，且有测试）

1. 全链路超时与可传播取消（`AbortSignal` 贯穿模型 / 工具 / 子 agent）
2. 工具执行进程级隔离 + 资源硬限制（超时 kill、输出截断、路径白名单）
3. Trajectory 原子追加 + `fsync` + 崩溃 checkpoint，重启从断点恢复、不丢步
4. 并发上限与背压（信号量 + 队列），防止打爆模型端点与文件系统
5. 所有边界过 schema 校验（工具参数、模型响应、连接器返回）
6. 故障降级：多 provider 路由 fallback、工具重试与熔断、死循环检测
7. 结构化日志 + token / 延迟 / 错误率指标 + 轨迹可回放
8. 密钥走独立环境变量通道，日志只留引用并脱敏；无全局可变状态
9. 单测 + 端到端 + 故障注入（工具超时、畸形模型返回、审批中断后恢复）

### A.5 补充范围边界

- 不做 TS 编译构建链（strip-types 直接运行），类型检查由编辑器 TS 服务提供，非运行时依赖。
- 不做 OS 级强隔离（bwrap / Landlock / Seatbelt），用路径白名单的**应用层**沙箱并如实标注隔离强度。
- 脱离本次交付、真要上生产的运行时，Go / Rust 是更稳的底座；本次为「可读、可改、与设计逐条对应」的内核，不冒充生产底座。

---

## 附录 B · 决议 v1.2：命名 bro2 与有界自我改进（RSI）

> 本附录记录第二阶段迭代。**附录 A 的选型与 L0–L7 架构全部不变**，新增一个横切于各层的能力面与治理面。完整调研见 [RSI.md](./RSI.md)。

### B.1 命名

运行时身份统一为 **`bro2`**：`agentos.config.json` 的 `name`、`package.json` 的 `name`、`src/index.ts` 的 `AGENT_NAME` 常量、`/api/status` 的 `name`、CLI banner、Web UI 标题、系统提示与文档标题。目录沿用 `/workspace/agent-os/` 以保持既有脚本 / 服务 / 相对路径不被破坏，不复制第二份代码。

### B.2 调研结论如何落到架构

2026 年的系统性综述把 RSI 拆成 *bounded self-refinement*（收敛、可评估、工业实践）与 *open-ended RSI*（受验证信号 / 坍塌动力学 / 算力限制）；并指出**每个改进循环都是「某信号可替代人类判断」的主张**，验证信号从形式化验证器到内在自评逐层变弱，自我改进强度沿该层级递减。bro2 因此：

| 文献结论 | 架构决策 |
| --- | --- |
| 验证层级决定改进强度 | 晋升只认外部可执行断言（真实工具返回 / 文件校验 / 停止原因 / 未配对 tool_call 零容忍），**拒绝模型自评与 LLM judge** |
| 评估器是攻击面（DGM objective hacking、STOP 关闭 sandbox flag） | 写保护评测面 + SHA-256 每代重算 + patch 路径白名单 + 隔离配置最后覆盖 |
| 面向固定基准过拟合、记忆答案 | train / holdout 分离，holdout 内容不进入 miner；技能增量 de-hardcoding |
| 编辑振荡、无界变更 | textual learning rate：每代候选上限、单次单原子编辑、rejected-edit buffer |
| archive 优于单链 | 只增账本保留全部候选（含被拒），支持分叉与复核 |
| `Imp_t → Imp_{t+1}` 才是 RSI（D2I L4 / VeriLoop「证据改变未来如何改变自身」） | 改进策略由本代实证成败更新算子先验；但只有白名单权重可变，治理层不可变 |
| 治理组件必须与能力组件区别保护 | 能力面可改、治理/验证器写保护；代数 / 平台期 / eval 次数 / 漂移 tripwire / incident log |

### B.3 模块与数据流

新增 `src/rsi/`：`types`（可改进状态 + 白名单/边界常量）· `ledger`（只增账本 + incident）· `guardrails`（完整性 / tripwire / de-hardcoding）· `miner`（失败信号聚类，只看 train）· `operators`（单原子算子 + 先验更新）· `shadow`（可改进状态持久化 + 影子 agent root）· `loop`（evolve 主循环 + 报告）。

```
完整性 tripwire → train/holdout 基线评测 → 失败挖掘 → 按先验生成单原子候选
→ 写保护校验 → 影子 train → 影子 holdout → 单调晋升 / 回滚 → 只增账本 → 先验更新
```

**关键隔离**：`runEval` 显式 `evolvedState: false`（验证器不受运行时演进状态反作用）；`createAgentOS` 默认读取 `data/evolve/state.json` 把**已通过门禁**的改进落地到运行时 budget。影子副本在临时目录构造完整 agent root，未通过的候选从不接触真实运行时，天然可回滚。

### B.4 验收

`npm test` 44/44；`npm run evolve` 3 代收敛，train `0.5→0.75→1`、holdout `0.333→0.667→1`，阈值 2→4→6 固化；`npm run rsi:check` 22/22（含 4 个恶意候选全部拦截）；`eval` 19/19 门禁 PASS；`verify` 23/23；`ollama:check` 4/4。

> **历史快照说明**：本节是 v1.2（数字阈值调参时代）当时的验收记录，保留作为演进对照。策略面重构后的当前验收以**附录 C** 与 [EVAL.md](./EVAL.md) 为准。

### B.5 边界

定位 **L3 完整 + 受限 L4（有界 RSI）**。不做 L5 通用 RSI、不做权重更新 / 自我重训、不自动修改核心源码、不用 LLM judge 晋升、不做无监督开放闭环。离线确定性演示 ≠ 真实模型智能水平；治理级度量是工程近似而非形式化保证。

---

## 附录 C · 决议 v2.0：策略分派层、meta RSI 与可证伪基准

> 本附录记录第三阶段迭代。**附录 A 的选型、附录 B 的有界 RSI、以及 §3–§10 的 L0–L7 架构全部不变**；新增的是横切于各层的「可改进代码行为」「改进机制自身」「测量机器」。
> 逐轮改动与实证见 [ITERATIONS.md](./ITERATIONS.md)，专题文档见 [META-RSI.md](./META-RSI.md) · [BENCHMARK.md](./BENCHMARK.md) · [EVAL.md](./EVAL.md)。

### C.1 要解决的三个缺口

轮 0 现状审计确认了三个真实缺口，v2.0 逐一给出决议：

| 缺口 | v1.2 现状 | v2.0 决议 |
| --- | --- | --- |
| RSI 只能改数字与技能文本，**碰不到代码行为** | `EvolvableState` 仅 `budget.*` + `skillOverlays.*` | 引入 `BehaviorPolicy` 策略分派层，把 5 个算法变体做成可切换的**真实代码分支** |
| 「改进改进机制」只是硬编码权重漂移，未经影子评测晋升 | `updateStrategyWeights` 写死 `+0.2 / -0.1 / -0.15`，`decision="meta"` 不参与判定 | 引入 meta RSI + **冻结 fitness**，元候选必须经影子 evolve 与能力不退化门槛才能晋升 |
| 「领先」没有测量机器 | 只有结构自检与自建 eval，无 ablation、无证据分级、无外部基准接口 | 引入 5 级证据阶梯 + 7 变体 ablation + 可证伪的 `leadership` 声明 |

前提确认：`computeIntegrity` 在每次 `runEvolve` **启动时**取 baseline、之后同轮内对比 —— 它防的是运行期候选篡改验证器，不是禁止开发者迭代框架。这条区分是后续所有改动的基础。

### C.2 策略分派层（横切 L0 / L1 / L2 / L6）

`src/runtime/policy.ts` 定义 5 个维度，每个值都对应各层的实际代码分支，由 `parsePolicy` 严格白名单解析（非法值回退保守默认）：

| 策略 | 保守默认 | 增强值 | 真实代码分支 | 可观测事件 |
| --- | --- | --- | --- | --- |
| `loopDetection` | `exact` | `advisory` | `governance/guards.ts`：连续相同调用先软警告 + 注入纠错提示，二次重复才硬终止 | `guard.advisory` |
| `malformedArgs` | `fail` | `repair` | `tools/repair.ts` + `tools/runtime.ts`：工具名/参数名唯一近似修复、JSON 字符串解析、剔除无效额外字段，**不补缺失必填** | `tool.repair` |
| `grounding` | `off` | `require-evidence` | `kernel/loop.ts`：工具全失败且无成功证据时，终答被打回一次并注入提示 | `grounding.reject` |
| `compaction` | `truncate` | `salience` | `context/budget.ts`：压缩摘要优先完整保留成功工具结果 | `context.compaction`（`payload.strategy` / `evidenceKept`） |
| `parallel` | `fifo` | `risk-first` | `tools/runtime.ts`：同一步按风险等级排序调度 | — |

**默认保守是硬约束**：`DEFAULT_POLICY` 全部取保守值，因此策略层引入后 `npm test` 与 `npm run eval` 不回归，行为等价于引入前；增强值只能由 RSI 通过双门禁争取。`RuntimeConfig.policy` → `createAgentOS` 注入 Guards / ToolRuntime / BudgetManager / AgentLoop；`runtime_status` 与 `/api/status` 暴露当前策略。

### C.3 RSI 扩展到策略面 + 治理不变量写进 holdout

`ALLOWED_EXACT_PATHS` 增加 `policy.*` 并做枚举白名单校验；新增 5 个策略切换算子；`shadow` 把 policy 写进影子 config；`miner` 增加 `policy` 失败类别；`guardrails` 把 `src/runtime/policy.ts`、`src/tools/repair.ts`、`src/kernel/events.ts`、`src/rsi/meta.ts`、`src/benchmark/{scoring,ladder}.ts` 纳入写保护面。

**关键设计：不硬编码「哪些策略能改」，而是把安全断言写进 holdout**——

| 集 | 组成 | 作用 |
| --- | --- | --- |
| train | 7 任务（2 稳定对照 + 5 策略行为） | 暴露失败信号，供 miner 生成单原子候选 |
| holdout | 8 任务（5 同类不同表面的迁移验证 + 3 治理不变量守卫） | 判泛化；**空参数不得凭空补值 / 死循环必须硬终止 / 无关工具名不得模糊匹配** |

第 4 代实证：`loopDetection: advisory` 在 train 上有效，却因破坏 holdout 死循环守卫被拒绝。这条「系统自己学会取舍」的证据比人工列白名单更强；`e9`（advisory 任务）也因此被排除在能力基准之外——它是治理决策，不是能力目标。

### C.4 meta RSI：三层分离与冻结尺子

| 层 | 对象 | 可变 | 判定 | 落盘 |
| --- | --- | --- | --- | --- |
| 能力面 `EvolvableState` | budget + 5 策略 + 技能增量 | ✅ | train + holdout 双严格提升 + 门禁 | `data/evolve/state.json` |
| 改进机制 `MetaState` | 7 个有限枚举 / 数值维度 | ✅ | **冻结 fitness** 单调提升 + 能力不退化 | `data/evolve/meta-state.json` |
| 冻结尺子 | `scoring.ts` + `ladder.ts` + `eval.ts` + 任务集 + 治理源码 | ❌ | 每代 SHA-256 重算，变更即 `integrity_violation` 停机 | `PROTECTED_FILES` |

`MetaState` 维度：`evidenceLimit` / `policyRule` / `candidateOrder` / `operatorSet` / `plateauPatience` / `promotionStrictness` / `editBudgetAdaptation`。`checkMetaPatch` 拒绝任何字段名命中 `gate|threshold|task|holdout|train|eval|score|integrity|fitness|ledger|verifier|scoring` 的候选；危险值 `lenient` 被明确禁止，`efficiency-tiebreak` 也没有把 holdout 判据放松成 `>=`，只是在严格打平时用步数破局。

冻结 fitness（`src/benchmark/scoring.ts`，写保护）：

```
finalHoldout = holdoutCurve.at(-1)
area         = mean(holdoutCurve)
efficiency   = min(1, area / evalRuns * 20)
score        = 0.6 * finalHoldout + 0.4 * efficiency
```

晋升三条件：`finalHoldout >= base` ∧ `score > base` ∧ `integrityOk`。元候选在 `scratchDir` 内跑 `dryRun + reset` 的短程 evolve，账本与 incidents 全部隔离，不触碰真实状态。**`Imp_t → Imp_{t+1}` 真实落地**：已晋升的 `meta-state.json` 被下一次 `runEvolve` 默认加载，实测让 evolve 少跑 2 次无效基线评测（eval 22 → 20）。

### C.5 基准测量机器：把「领先」变成可证伪命题

`src/benchmark/`：`scoring.ts`（冻结尺子）· `ladder.ts`（证据阶梯，写保护）· `ablation.ts`（贡献分离）· `index.ts`（总入口）。

| 级 | 判据 | 当前 |
| --- | --- | --- |
| L0 结构连通 | 各层可运行，评测报告落盘并通过门禁 | achieved |
| L1 确定性行为回归 | overall ≥ 0.85、门禁 PASS、未配对 tool_call = 0 | achieved |
| L2 有界可验证自我改进 | train/holdout 单调提升、保护面未变更、有害候选被拒 | achieved |
| L3 meta RSI + 贡献分离 | 冻结 fitness 提升、ablation 量化、跨 provider 接口就绪 | **partial**（无真实模型矩阵） |
| L4 公开基准对齐 | 公开基准胜过同期开源 harness + 第三方复现 | **not-achieved** |

`assessEvidenceLadder` 从落盘报告自动判定，**判定逻辑本身在写保护面内**，即使内部证据齐备 L3 也只给 partial，不会给自己发满级；`leadership.verdict = not-proven` 并附 3 条可证伪条件。ablation 用 `stripConfigAssertions` 剥离 `expectedPolicy` 配置断言，只保留行为断言，避免「检查配置值是否被看到」的循环论证；`mergeConfigForEval` 保证变体不能改 storage / permission 的隔离路径。

**轮 5 加固：外部证据入口的可信化**。上一版 `EXTERNAL_RESULT_SCHEMA` 只是说明性常量，判定只数 `results.length`，写一行 `{"results":[{}]}` 就能把 L4 从 `not-achieved` 提到 `partial` —— 唯一能提升「领先」等级的入口反而成了最薄弱的自欺面。v2.1 新增 `src/benchmark/external.ts`（字段白名单 / 类型 / 日期 / 复现命令 / 禁止自带结论字段）并纳入 `PROTECTED_FILES`（20 文件）。阶梯只统计通过校验的记录，且 `benchmark-report.json` 作为内部产物不再计入；`LeadershipClaim.verdict` 收窄为恒 `not-proven`。合法外部结果最多把 L4 提到 `partial`，仍需第三方复核。

### C.6 架构增量与数据流

```
policy.ts（策略分派层）
   ├─ Guards / ToolRuntime / BudgetManager / AgentLoop  ← 5 个真实代码分支
   └─ RSI 可改进面：EvolvableState.policy
        ↑ 单原子候选 + 影子 train/holdout 双门禁（含治理不变量）
   rsi/meta.ts（改进机制） ── 冻结 fitness ──> benchmark/scoring.ts（写保护尺子）
        ↑ 影子短程 evolve（scratchDir 隔离账本）
   benchmark/{ladder,ablation,index,external}.ts（测量机器 + 外部证据校验）
        └─ 证据阶梯 + 贡献分离 + 外部结果校验 + leadership 声明（not-proven）
```

新增模块：`src/runtime/policy.ts` · `src/tools/repair.ts` · `src/rsi/meta.ts` · `src/benchmark/{scoring,ladder,ablation,index,external}.ts`；`EventType` 增加 `tool.repair` / `grounding.reject` / `guard.advisory`；CLI 增加 `meta` / `benchmark` / `preflight` 子命令与 `--rounds` / `--all` / `--skip-preflight`；`EvalOptions` 增加 `configOverride` / `useEvolvedState` 以支撑 ablation。

### C.7 验收

`npm test` 87/87；`verify` 23/23；`eval` 19/19 门禁 PASS；`policy:check` 19/19；`rsi:check` 22/22；`evolve` 4 代单调提升（train 0.286→0.857 / holdout 0.5→1.0，晋升 4 / 拒绝 1 / 拦截 2，保护面 20 文件未变更）；`meta` fitness 0.8879→0.9 且能力不退化、`meta:check` 25/25；`benchmark` ablation 完整 10/10 vs 朴素 1/10、L4 not-achieved、`benchmark:check` 21/21；`external:check` 38/38（伪造外部结果不能升级 L4）；`ollama:check` 4/4；`preflight:check` 37/37（接入门禁防误判、证据面隔离）、`live:smoke` 17/17（live 全链路自检，明确标注非模型能力分数）；`preflight` 沙箱实测端点不可达 `EXIT=1`，指向就绪端点 `EXIT=0`。**轮 7**：本地真实推理服务（llama.cpp + Ollama 官方权重）过门禁后 `eval:live` 实测 `overall 0.0%`（0/12）、协议违规 0、18 次真实 CPU 推理，第一份真实模型分数落盘 `data/eval-live-report.json`。

> **C.7a 接入基础设施（轮 6）**：`probe()` 增加 `networkReachable` / `authRejected` / `httpStatus`，区分网络故障与 401/403 认证失败；新增 `src/models/preflight.ts` 六项硬检查门禁（未就绪 `EXIT=1` 拒绝开跑）；live 报告改写 `data/eval-live-report.json`，不再覆盖 L1 证据来源 `data/eval-report.json`；`live:smoke` 用进程外真实 HTTP/SSE 端点跑通全链路，产物显著标注 `isModelCapabilityScore: false`。详见 [docs/TAKEOVER.md](./docs/TAKEOVER.md)。
>
> **C.7b 本地真实推理与第一份真实分数（轮 7）**：GitHub Release 出口受限装不上 Ollama 二进制，改用 `tools/local-llm-server.py`（`llama.cpp` + **Ollama 官方 registry GGUF 权重**）提供等价 OpenAI Compat 端点 —— 内核零改动。新增 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md) 记录部署、cgroup 4 核配额下的线程超订阅限流（`nproc` 报 32 是宿主机视图，`--threads 8` 使单次推理 24s，`--threads 4` 降到 0.09s）、`chatml-function-calling` 协议适配与 buffered-sse 边界。第一份真实分数 `0.0%`（0/12）如实落盘，未写入 `external-results.json`、未改 `verdict`。
>
> 附录 B 的验收数字是 **v1.2 当时的快照**（3 代收敛、阈值 2→4→6）；策略面重构后以本附录为准。

### C.8 边界（不变且更严）

- **不做 L5**：不改权重、不自动重写核心源码、不做无监督开放闭环、不用模型自评 / LLM judge 晋升。元改动只落在 7 个有限枚举上，候选集是 6 个预设改动，不搜索任意改进机制。
- **冻结尺子是设计选择**：`area = mean(curve)` 对不同长度曲线非严格同尺度，0.6/0.4 权重与常数 20 可人工复核，换任务域应重新校准。
- **「行业领先」是外部比较命题**：内部 Mock 100% 不等于领先，`not-proven` 由证据决定，需公开基准 + ≥3 真实模型对比矩阵 + 第三方复现。
- **沙箱仍是应用层路径白名单**，非 OS 级强隔离；零依赖 + strip-types，无编译期类型检查。真上生产的底座 Go / Rust 更稳（见附录 A.5）。
