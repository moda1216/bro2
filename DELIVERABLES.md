# bro2 · 产出物管理登记册（Deliverable Management Register）

> 本文件是 bro2 工程化产出物管理的**单一事实源**（single source of truth）。
> 任何"交付物"的增删改、状态变更、版本晋升，都必须先在此登记，再由对应验收门禁（`npm run project:status`）校验。
> 配套文件：版本发布见 [CHANGELOG.md](./CHANGELOG.md)，演进路线见 [ROADMAP.md](./ROADMAP.md)，文档导航见 [docs/INDEX.md](./docs/INDEX.md)。

---

## 1. 项目元信息（Project Metadata）

| 字段 | 值 |
| --- | --- |
| 名称 | `bro2`（Agent OS / Harness） |
| 版本 | **v2.0.3**（语义化，见 CHANGELOG） |
| 定位 | `Model + Harness = Agent` —— 你可控的 Agent 操作系统（harness 层） |
| 语言 / 运行时 | TypeScript（Node 22 `--experimental-strip-types`，零构建步骤） |
| 运行时依赖 | **0**（仅用 Node 内置模块） |
| 架构 | 8 层：kernel / models / context / tools / memory / cognition / delegation / governance / observability / interfaces |
| 唯一真相源 | `Trajectory`（每次运行的轨迹日志，不可变追加） |
| 源代码规模 | 57 个 `.ts` 源文件 + 1 个 Web 入口 HTML + 1 个 Python 本地推理服务 |
| 测试规模 | 11 个测试文件；`npm test` **96** 项全绿 |
| 诚实判定 | `leadership.verdict = not-proven`；证据阶梯 L4 = `not-achieved`（不伪造外部基准） |
| 仓库状态 | 已初始化 git，初始提交 `v2.0.0` tag；`.gitignore` 隔离运行时产物 |
| 版本控制 | git（提交粒度 = 逻辑交付单元；发布 = tag + CHANGELOG 条目） |

---

## 2. 验收基线（当前绿色门禁 — Acceptance Baseline）

> 这些是"产出物健康度"的判定依据。`npm run project:status` 会逐一复跑并汇总。

| 验收项 | 命令 | 当前结果 | 性质 |
| --- | --- | --- | --- |
| 单元测试 + e2e + 故障注入 | `npm test` | **96 / 96 PASS** | 交付门禁 |
| 能力矩阵结构自检 | `npm run verify` | 22 项 PASS | 结构门禁 |
| 行为策略代码分支实证 | `npm run policy:check` | 19 项 PASS | 策略门禁 |
| RSI 端到端 + 恶意候选注入 | `npm run rsi:check` | **22 / 22 PASS** | RSI 门禁 |
| 元 RSI 写保护 + 冻结 fitness | `npm run meta:check` | 25 项 PASS | 元层门禁 |
| 基准诚实性测量 | `npm run benchmark:check` | 21 项 PASS | 基准门禁 |
| 外部证据防伪造 | `npm run external:check` | **38 / 38 PASS** | 反自证门禁 |
| live 链路自检（仿真，非能力分） | `npm run live:smoke` | 17 项 PASS | 链路门禁 |
| 接入门禁防误判 / 证据隔离 | `npm run preflight:check` | 37 项 PASS | 接入门禁 |
| 免费 API 可达性探针 | `npm run free:probe` | 6 家可达（含 pollinations 无 Key）、正确报缺 Key | 接入门禁 |
| 确定性主评测 | `npm run eval` | overall **1.0**，19/19，协议违规 0 | 能力证据 L1 |
| 第一份真实分数 | `npm run eval:live`（本地 qwen2.5:0.5b） | overall **0.0%**（0/12），协议违规 0 | 真实证据（诚实） |
| **无 Key 真实分数** | `npm run eval:live`（Pollinations 匿名层 · gpt-oss-20b） | overall **25%（3/12）**，协议违规 **0**，零 Key | 真实证据（无 Key） |

---

## 3. 产出物登记册（Deliverable Register）

状态图例：✅ 已交付 · 🟡 部分交付 / 待接入 · 🔲 待建（见 ROADMAP）

### 3.1 可交付代码（按层）

**kernel（内核 / 运行时）** — ✅
| 产出物 | 路径 | 职责 | 验收指针 |
| --- | --- | --- | --- |
| 事件总线 | `src/kernel/events.ts` | 全局事件分发 | `tests/kernel.test.ts` |
| 钩子 | `src/kernel/hooks.ts` | 生命周期钩子 | `tests/kernel.test.ts` |
| 轨迹唯一真相源 | `src/kernel/trajectory.ts` | 不可变追加日志 | `tests/kernel.test.ts` |
| 会话 | `src/kernel/session.ts` | 会话状态机 | `tests/kernel.test.ts` |
| 运行时 | `src/kernel/runtime.ts` | Agent 执行体 | `tests/kernel.test.ts` |
| 主循环 | `src/kernel/loop.ts` | think→act→observe 循环 | `tests/kernel.test.ts` |

**runtime（行为策略分派）** — ✅
| 产出物 | 路径 | 职责 | 验收指针 |
| --- | --- | --- | --- |
| 行为策略 | `src/runtime/policy.ts` | loopDetection / grounding / parallel 等五维分派 | `npm run policy:check` (19) |

**models（模型接入 / 双通道）** — ✅
| 产出物 | 路径 | 职责 | 验收指针 |
| --- | --- | --- | --- |
| 模型接口 | `src/models/base.ts` | LLMProvider 抽象 | `tests/rsi.test.ts` |
| Mock 提供方 | `src/models/mock.ts` | 启发式 Mock（确定性评测用） | `npm test` |
| OpenAI 兼容适配 | `src/models/openai-compat.ts` | probe() 区分网络/认证/HTTP | `tests/ollama.test.ts` |
| Provider 路由 | `src/models/router.ts` | 多 provider 选择 | `tests/ollama.test.ts` |
| 透明响应缓存 | `src/models/cache.ts` | CachedProvider：相同请求零调用 + 效率统计 | `tests/cache.test.ts` |
| 本地+远程混合 | `src/models/hybrid.ts` | HybridProvider：缓存优先 + 启发式路由 + 限流降级 | `tests/hybrid.test.ts` |
| 接入门禁 | `src/models/preflight.ts` | 6 项就绪检查，未就绪 EXIT=1 | `tests/preflight.test.ts` |

**context / tools / memory / cognition / delegation / governance / observability / benchmark / rsi / interfaces** — ✅（共 43 个源文件）
| 模块组 | 关键产出物 | 验收指针 |
| --- | --- | --- |
| context | `budget.ts` `builder.ts` | `tests/kernel.test.ts` |
| tools | `schema` `registry` `runtime` `repair` `mcp` `plugin` `builtins/*` | `tests/tools.test.ts` |
| memory | `store` `retrieval` | `tests/kernel.test.ts` |
| cognition | `plan` `preset` `skills` | `tests/e2e.test.ts` |
| delegation | `automation` `subagent` | `tests/e2e.test.ts` |
| governance | `permissions` `approval` `guards` `audit` | `tests/governance.test.ts` |
| observability | `tracing` `eval` | `npm run eval` |
| benchmark | `ladder` `ablation` `scoring` `external` `index` | `npm run benchmark:check` (21) |
| **rsi** | `types` `ledger` `guardrails` `miner` `operators` `shadow` `loop` `meta` `contrast` `index` | `npm run rsi:check` (22) / `meta:check` (25) / `contrast.test.ts` (9) |
| interfaces | `cli` `api` `web/index.html` | `npm run verify` |

### 3.2 配置与入口 — ✅
| 产出物 | 路径 | 职责 | 验收指针 |
| --- | --- | --- | --- |
| CLI / Web 入口 | `bin/agentos.ts` | 全部子命令分发 | `npm run verify` |
| 装配根 | `src/index.ts` | createAgentOS（遍历配置装载 provider） | `npm test` |
| 工程配置 | `package.json` | 28 条脚本、engines≥22.6 | `npm test` |
| 运行配置 | `agentos.config.json` | 8 provider（mock/openai/ollama + 5 免费） | `npm run free:probe` |
| 忽略规则 | `.gitignore` | 隔离运行时产物 | git status 干净 |

### 3.3 工具（Tools） — ✅
| 产出物 | 路径 | 职责 | 验收指针 |
| --- | --- | --- | --- |
| 本地真实推理服务 | `tools/local-llm-server.py` | llama.cpp OpenAI 兼容 SSE + 原生 tool_calls | `docs/LOCAL-LLM.md` / `npm run preflight` |

### 3.4 验收 / 演示脚本（examples） — ✅
| 产出物 | 路径 | 职责 | 验收指针 |
| --- | --- | --- | --- |
| 全量验证 | `examples/verify.ts` | L0–L7 能力矩阵 | `npm run verify` |
| 策略实证 | `examples/policy-check.ts` | 5 策略分支 | `npm run policy:check` |
| RSI 实证 | `examples/evolve-check.ts` | 端到端 + 恶意候选 | `npm run rsi:check` |
| 元 RSI 实证 | `examples/meta-check.ts` | 写保护 / 冻结 fitness | `npm run meta:check` |
| 基准诚实性 | `examples/benchmark-check.ts` | 测量机器诚实 | `npm run benchmark:check` |
| 外部防伪造 | `examples/external-check.ts` | 反自证循环 | `npm run external:check` |
| 接入门禁实证 | `examples/preflight-check.ts` | 防误判 / 隔离 | `npm run preflight:check` |
| live 链路自检 | `examples/live-smoke.ts`（仿真） | 链路非能力分 | `npm run live:smoke` |
| Ollama 协议仿真 | `examples/ollama-check.ts` / `ollama-bridge.ts` | 协议级实证 | `npm run ollama:check` |
| 免费 API 探针 | `examples/free-api-probe.ts` | 5 家可达性 | `npm run free:probe` |
| 混合推理演示 | `examples/hybrid-demo.ts` | 真实演示远程调用降低 | `npm run hybrid:demo` |
| 演示 | `examples/demo.ts` / `_smoke.ts` | 离线完整演示 | `npm run demo` |

### 3.5 测试套件 — ✅
| 产出物 | 路径 | 覆盖 | 项 |
| --- | --- | --- | --- |
| 内核 / 轨迹 | `tests/kernel.test.ts` | 事件、钩子、轨迹、会话 | — |
| 治理 | `tests/governance.test.ts` | 权限、审批、守卫、审计 | — |
| 工具 | `tests/tools.test.ts` | schema/registry/runtime/repair | — |
| 端到端 | `tests/e2e.test.ts` | 跨层编排 | — |
| RSI | `tests/rsi.test.ts` | 有界改进、只增账本 | — |
| 对比式改进 | `tests/contrast.test.ts` | HARNESS² Propose–Probe–Compose | 9 |
| 元 RSI | `tests/meta.test.ts` | 元层写保护 | — |
| 基准 | `tests/benchmark.test.ts` | ablation / ladder | — |
| 外部证据 | `tests/external.test.ts` | 防伪造校验器 | — |
| 接入门禁 | `tests/preflight.test.ts` | 门禁逻辑 | — |
| Ollama | `tests/ollama.test.ts` | 协议兼容 | — |
| **合计** | 11 文件 | — | **96** |

### 3.6 文档 — ✅
| 产出物 | 路径 | 受众 / 用途 |
| --- | --- | --- |
| 总入口 | `README.md` | 快速开始、能力矩阵、命令 |
| 架构设计 | `DESIGN.md` | 8 层、契约、治理、附录 A/B/C |
| 评测体系 | `EVAL.md` | 指标口径、门禁、持续提升闭环 |
| RSI 调研 | `RSI.md` | 前沿调研、验证层级、失败模式 |
| 元 RSI | `META-RSI.md` | 改进改进机制自身 |
| 基准与领先度 | `BENCHMARK.md` | 可证伪领先定义、5 级证据阶梯 |
| 迭代日志 | `ITERATIONS.md` | 多轮改动→证据→晋升/拒绝 |
| API | `docs/API.md` | REST+SSE 端点契约 |
| 文档索引 | `docs/INDEX.md` | 导航与阅读路径 |
| 真机接管 | `docs/TAKEOVER.md` | 接真模型→基准→外部导入 |
| 本地推理 | `docs/LOCAL-LLM.md` | llama.cpp 等价端点与坑 |
| 免费 API | `docs/FREE-LLM-APIS.md` | OpenRouter/NIM/... 实测可达性 |
| RSI 演进 | `docs/RSI-NEXT.md` | 对齐 4 篇论文 → P0–P5 |
| **本项目** | `DELIVERABLES.md` `CHANGELOG.md` `ROADMAP.md` | 产出物管理三件套 |

### 3.7 数据证据产物（Data / Evidence Artifacts）— ✅
| 产出物 | 路径 | 性质 | 状态 |
| --- | --- | --- | --- |
| 确定性主评测 | `data/eval-report.json` | L1 能力证据（overall=1.0） | ✅ 已发布 |
| 评测回归基线 | `data/eval-baseline.json` | 对照基线 | ✅ 已发布 |
| 任务集 | `data/eval-tasks.jsonl` | 19 任务定义 | ✅ 已发布 |
| 第一份真实分数 | `data/first-real-live-report.json` | 永久证据（0/12，不可改） | ✅ 已归档 |
| **无 Key 真实分数** | `data/live-pollinations-gptoss20b.json` | 永久证据（25%，3/12，零 Key） | ✅ 已归档 |
| **混合推理真实证据** | `data/live-hybrid-kilo-qwen.json` | hybrid provider 评测（remoteRatio 0.33，协议违规 0） | ✅ 已归档 |
| live 评测输出 | `data/eval-live-report.json` | `eval:live` 写，与确定性隔离 | ✅ 已发布 |
| live 链路自检 | `data/live-link-smoke.json` | 非能力分（明确标注） | ✅ 已发布 |
| RSI 演进报告 | `data/evolve-report.json` | train/holdout 曲线 | ✅ 已发布 |
| RSI 账本/事件 | `data/evolve/ledger.jsonl` `incidents.jsonl` | 只增、安全事件 | ✅ 已发布 |
| RSI 状态/策略 | `data/evolve/state.json` `strategy.json` | 已落地能力/算子先验 | ✅ 已发布 |
| 元 RSI 报告 | `data/meta-report.json` `evolve/meta-state.json` `meta-ledger.jsonl` | 冻结 fitness 曲线 | ✅ 已发布 |
| 基准报告 | `data/benchmark-report.json` | ablation + 阶梯 + 领先度声明 | ✅ 已发布 |
| **外部基准** | `data/benchmark/external-results.json` | L4 证据（BFCL/τ-bench/...） | 🔲 待建（见 ROADMAP P5） |

> 运行时产物（`data/sessions/`、`data/system.jsonl`、`data/workspace/`、`data/memory/long-term.json`）由 `.gitignore` 隔离，不进版本库。

### 3.8 技能与预设 — ✅
| 产出物 | 路径 | 职责 |
| --- | --- | --- |
| 技能包 | `skills/*/SKILL.md` | report-writing / deep-research 等 |
| 预设 | `presets/*.json` | 可迁移 harness 片段（OO-Harness 基类候选） |

---

## 4. 证据链可追溯性（Traceability Matrix）

> 让"能力声明 → 证据文件 → 验收脚本"形成闭环，杜绝自证领先。

| 能力声明 | 证据文件 | 验收脚本 | 结果 |
| --- | --- | --- | --- |
| Harness 行为正确（确定性域） | `data/eval-report.json` | `npm run eval` | overall 1.0，协议违规 0 |
| 真实推理链路可通 | `data/first-real-live-report.json` `live-link-smoke.json` | `eval:live` `live:smoke` | 真实 0/12，协议违规 0 |
| RSI 真实改进且不退化 | `data/evolve-report.json` `ledger.jsonl` | `rsi:check` | 22/22 |
| 元 RSI 不自确认 | `data/meta-report.json` `meta-ledger.jsonl` | `meta:check` | 25/25 |
| 基准诚实（不伪造 L4） | `data/benchmark-report.json` | `benchmark:check` `external:check` | 21/21 · 38/38 |
| 接入不误判 | preflight 逻辑 | `preflight:check` | 37/37 |
| 免费 API 可用 | `agentos.config.json` | `free:probe` | 5 家可达 |

**判定结论**：`leadership.verdict = not-proven`。L0–L2（内部 ablation）已 achieved；L4（公开基准对齐）not-achieved，且 `data/benchmark/external-results.json` 从未被编造。

---

## 5. 验收门禁 / 发布条件（Acceptance Gates）

交付物晋升到"已发布"必须满足：

1. **代码门禁**：`npm test` 全绿（96/96），无新增 `any` / 无绕过类型检查。
2. **能力门禁**：断言绑定**真实代码分支**（如 `policy:check` 实跑策略分派），禁止数值硬编码。
3. **诚实门禁**：`benchmark:check` + `external:check` 通过 —— 不得出现 `verdict=proven`、不得编造 `external-results.json`。
4. **证据隔离**：确定性报告与 live 报告分文件；门禁阻止在"未就绪"时写低分报告（`preflight` EXIT=1）。
5. **版本门禁**：每次发布 = git tag + `CHANGELOG.md` 条目 + 本登记册状态同步。

> CI（`.github/workflows/ci.yml`）在 push 时自动复跑离线门禁（2/3/4 + 部分 1）。

---

## 6. 已知边界与待办（Known Boundaries → ROADMAP）

| 缺口 | 影响 | 解决路径 |
| --- | --- | --- |
| 仅单模型真实分数（qwen2.5:0.5b / gpt-oss-20b 匿名层） | 无法横向对比 | ROADMAP **P0**：免费 API 跑强模型（无 Key 通路 `kilo`/`pollinations` 已打通） |
| 对比式改进未接入 live RSI | 开放世界无真值迭代未闭环 | ROADMAP **P1** |
| 经验库（EXPERIENCE.md）未沉淀 | harnessing 级递归缺失 | ROADMAP **P2** |
| 缺 OOD 校验通道 | evolve 在 19/19 上可能过拟合 | ROADMAP **P3**（RRSI 正则） |
| 单一全局 harness | 未进化为可继承类族 | ROADMAP **P4**（OO-Harness） |
| 缺公开基准 L4 | 无法宣称领先 | ROADMAP **P5** |

> **已交付的能力增强（v2.0.3）**：「本地 + 远程协同降调用」链路已落地——
> `CachedProvider`（透明缓存）+ `HybridProvider`（启发式路由 + 限流降级）+
> `hybrid` provider 配置 + `eval:live` 的 `inference` 效率指标。无 Key 端点已扩至
> `pollinations / kilo / opencode-zen / llm7`（沙箱实测 `kilo` 支持原生 tool_calls）。
> 详见 [ROADMAP.md](./ROADMAP.md) 的「混合推理」工作流与 `docs/FREE-LLM-APIS.md` 第六节。

详细优先级、输入/产出物、验收标准见 [ROADMAP.md](./ROADMAP.md)。

---

## 7. 版本与发布（Versioning → CHANGELOG）

- 语义化版本 `MAJOR.MINOR.PATCH`：破坏性架构变更 / 新增能力域 / 修复或证据更新。
- 发布动作：feature 完成 → 跑 `npm run project:status` 全绿 → `git tag -a vX.Y.Z` → 追加 `CHANGELOG.md` 条目 → 同步本登记册 §3 状态。
- 当前最新：**v2.0.1**（初始工程化基线 v2.0.0 + 产出物管理交付）。
