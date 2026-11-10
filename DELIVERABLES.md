# bro2 · 产出物管理登记册（Deliverable Management Register）

> 本文件是 bro2 工程化产出物管理的**单一事实源**（single source of truth）。
> 任何"交付物"的增删改、状态变更、版本晋升，都必须先在此登记，再由对应验收门禁（`npm run project:status`）校验。
> 配套文件：版本发布见 [CHANGELOG.md](./CHANGELOG.md)，演进路线见 [ROADMAP.md](./ROADMAP.md)，文档导航见 [docs/INDEX.md](./docs/INDEX.md)。

---

## 1. 项目元信息（Project Metadata）

| 字段 | 值 |
| --- | --- |
| 名称 | `bro2`（Agent OS / Harness） |
| 版本 | **v2.26.0**（语义化，见 CHANGELOG） |
| 定位 | `Model + Harness = Agent` —— 你可控的 Agent 操作系统（harness 层） |
| 语言 / 运行时 | TypeScript（Node 22 `--experimental-strip-types`，零构建步骤） |
| 运行时依赖 | **0**（仅用 Node 内置模块） |
| 架构 | 8 层：kernel / models / context / tools / memory / cognition / delegation / governance / observability / interfaces |
| 唯一真相源 | `Trajectory`（每次运行的轨迹日志，不可变追加） |
| 源代码规模 | 68 个 `src/*.ts` + 4 个入口/脚本 `.ts` + 1 个 Web 入口 HTML + 1 个 Python 本地推理服务 |
| 测试规模 | 34 个测试文件；`npm test` **290** 项全绿 |
| 诚实判定 | `leadership.verdict = not-proven`；证据阶梯 L4 = `not-achieved`（不伪造外部基准） |
| 仓库状态 | 已初始化 git，初始提交 `v2.0.0` tag；`.gitignore` 隔离运行时产物 |
| 版本控制 | git（提交粒度 = 逻辑交付单元；发布 = tag + CHANGELOG 条目） |

---

## 2. 验收基线（当前绿色门禁 — Acceptance Baseline）

> 这些是"产出物健康度"的判定依据。`npm run project:status` 会逐一复跑并汇总。

| 验收项 | 命令 | 当前结果 | 性质 |
| --- | --- | --- | --- |
| 单元测试 + e2e + 故障注入 | `npm test` | **290 / 290 PASS** | 交付门禁 |
| CI 可移植性（测试不得依赖本机环境事实） | `npm test` → `tests/remote-sync.test.ts` 第 6 项 | 有/无凭证两环境均 6/6 | 防复发门禁 |
| 能力矩阵结构自检 | `npm run verify` | 23 项 PASS | 结构门禁 |
| 行为策略代码分支实证 | `npm run policy:check` | 19 项 PASS | 策略门禁 |
| RSI 端到端 + 恶意候选注入 | `npm run rsi:check` | **22 / 22 PASS** | RSI 门禁 |
| 对比式改进 live 闭环（防 reward hacking） | `npm run contrast:live` | 完整性 ✓ OK，2 晋升 / 2 拦截 | P1 门禁 |
| 复利中枢（越用越快 / 越用越省） | `npm run compound:demo` | 10/10 断言，trend=accelerating，remoteAvoided=6 | 两大目标门禁 |
| 迭代水位（唯一尺子 / 只增账本 / 只读投影） | `npm run watermark:check` | 13/13 项，账本 14 轮 `trend=accelerating` | 水位门禁（第 12 道） |
| **代码预算（少而精）** | `npm run budget:check` | 16,498 / 16,500 行 · 88 / 90 文件 · 最大 584 行 · 测试比 0.27 · 依赖 0 | 体积门禁（第 13 道） |
| 预算阈值防暗调（冻结量尺） | `node --test tests/budget-integrity.test.ts` | **4/4 PASS**（limits ≤ 冻结 FLOOR、依赖恒 0、note 留痕约定、纯函数可证伪对照）；实测把 sourceLines 改 20000 精确 fail、还原后干净 | 发布门禁（test 道自动纳入） |
| **v2 分层任务装载** | `npm run bench:v2 -- --layer l1` | 19/19 通过，指纹 `d1419b1efaa7` 与既有评测一致 | 迁移回归门禁（第 14 道） |
| **fixture 快照** | `npm run fixture:check -- --run` | 3 仓库结构完整 · 7,585 / 3,145,728 字节 · 离线测试 3/3 通过 | fixture 门禁（第 15 道） |
| **L2 任务双态校准** | `npm run task:check -- --layer l2 --quiet` | 18/18：原始快照必失败、参考解必通过 | 任务有效性门禁 |
| **编辑接口指标** | `npm run aci:check` | 7/7：精确/空白/缩进可改对，多处命中拒绝，补丁零半成品 | ACI 门禁 |
| **故障恢复确定性对照** | `npm run fault:check` | 3/3 接受（retry / empty-guard / repair）：离线可复算、防哑弹、拒绝自报增益 | 恢复力回归门禁（第 18 道） |
| **三段晋升判据** | `npm run promotion:check` | 合法晋升 1/1 接受（三段分数由 `runEval` 真实产出：dev 0→1、holdout/ood 1→1）+ 12 个受控违规信号全部拒绝；OOD 退化即阻断、自报增益不参与 | 阶段 C 前置闸门（第 19 道） |
| **三段任务集分层（W1-06 重定口径）** | `npm run segments:check` | 37 个真实任务冻结成 dev 12 / holdout 15 / ood 10；31/31 断言（源指纹一致 / 三段互不相交 / 指纹互异 / OOD 只读 / 真实分段接 `judgePromotion` / 6 个反例改坏必红）；真篡改 `ood.hash` 实测 `exit=1` | 阶段 C 输入契约门禁（第 21 道） |
| **阶段 C 接入 RSI 主循环** | `npm run phasec:check` | 7/7 断言：`judgePromotion` 消费真实三段（dev 严格提升 / holdout·OOD 不退化 / OOD 完全只读 / 协议零违规）、OOD 退化即阻断且写 journal、`runEvolve` 搜索只碰 dev；`data/evolve/ood.jsonl` 为只读退化探针 | 阶段 C 接入门禁（第 22 道） |
| **P0.5-c 成本晋升目标** | `npm run p0.5c:check` | 6/6 断言：`judgePromotion` 新增可选 `cost` 目标（remoteAvoided↑ 且分数不降才纳入晋升）；能力晋升+成本不升→晋升、能力晋升+成本反升→阻断、成本不越权覆盖能力、未传成本→向后兼容 | P0.5-c 成本晋升门禁（第 23 道） |
| **只增账本 git 历史完整性** | `npm run ledger:check` | 对 `data/plan/journal.jsonl` / `data/plan/lessons.jsonl` 两本真正只增账本，逐对相邻 commit 校验「旧条目序列是新条目序列前缀」（条目级 canonical 比对：删除/重排/语义篡改必抓，纯格式化放行）；零依赖零算力，CI 浅克隆优雅降级 | 只增账本门禁（第 24 道） |
| **端点健康经验接线** | `npm run endpoint:check` | 13/13 断言（经验折叠 / 冷启动让位 / 硬过滤不绕过 / 回写闭环跨会话 / 失效归零）；先验只影响 `score()` 排序、绝不绕过冷却/限流 | 越用越稳闭环门禁（第 20 道） |
| 远程同步一致性（防漏推，纯只读） | `npm run push:check` | `✓ 远程已同步`，main 与本地一致、最新 tag 已推送 | 信息展示门禁 |
| 改进同步闭环（提交 + 唯一通道推送 + 自检） | `npm run ship` | 复用仓库外 600 权限 PAT，凭证不入库、不回显 | 发布流程 |
| 元 RSI 写保护 + 冻结 fitness | `npm run meta:check` | 25 项 PASS | 元层门禁 |
| 基准诚实性测量 | `npm run benchmark:check` | 21 项 PASS | 基准门禁 |
| 外部证据防伪造 | `npm run external:check` | **38 / 38 PASS** | 反自证门禁 |
| 能力水位定位视图（外部参照 / 防自指 / 只读） | `npm run position:check` | **17 / 17 PASS**（真实阶梯 L4 not-achieved·verdict not-proven·外部证据 0 条；14 条外部参照逐条带来源/证据等级且 `bro2Measured=false`；定位表 bro2 全格 not-measured） | 定位体检（非门禁） |
| 真值任务集评测（外部可证伪评分） | `npm run eval:truth` | 10/10 通过、总体 100%、五类全绿、协议违规 0（确定性全链路；live 经 kilo 端点实测 7/10·overall 0.7，端点工具能力不稳，非干净基准） | 真值评测门禁 |
| 外部真值段接入 evolve 晋升（独立 veto 可证伪） | `node --test tests/evolve-truth-veto.test.ts` | **5/5 PASS**（3 项 v2.23.0 正反对照 + 2 项 v2.24.0：MIX 基线<1 相对零退化仍 fail-closed 不放水·根因可诊断；钉死「相对基线」放水必挂） | 晋升闭环门禁 |
| live 链路自检（仿真，非能力分） | `npm run live:smoke` | 17 项 PASS | 链路门禁 |
| 接入门禁防误判 / 证据隔离 | `npm run preflight:check` | 37 项 PASS | 接入门禁 |
| 免费 API 可达性探针 | `npm run free:probe` | 6 家可达（含 pollinations 无 Key）、正确报缺 Key | 接入门禁 |
| 确定性主评测 | `npm run eval` | overall **1.0**，19/19，协议违规 0 | 能力证据 L1 |
| 第一份真实分数 | `npm run eval:live`（本地 qwen2.5:0.5b） | overall **0.0%**（0/12），协议违规 0 | 真实证据（诚实） |
| **无 Key 真实分数** | `npm run eval:live`（Pollinations 匿名层 · gpt-oss-20b） | overall **25%（3/12）**，协议违规 **0**，零 Key | 真实证据（无 Key） |
| **强模型真实分数** | `npm run eval:live`（OpenRouter · nemotron-3-ultra-550b-a55b:free） | overall **41.7%（5/12）**，协议违规 **0**，免费层 550B | 真实证据（强模型，v2.0.6） |

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
| 本地+远程混合 | `src/models/hybrid.ts` | HybridProvider：缓存优先 + 启发式路由 + 限流降级 + `remoteDetail` 网状明细 | `tests/hybrid.test.ts` |
| 无 Key 端点聚合 | `src/models/keyless.ts` | KeylessAggregator：多免 Key 上游统一为单一接口 + 健康评分/限流感知/故障转移/能力感知 + 网状统计 | `tests/keyless.test.ts` |
| 组合/网状端点穿透 | `src/models/resolve.ts` | resolveLeaves / leafEndpoints / probeTargets：递归展开 + 去重防环 + 远端优先（门禁共用） | `tests/nested-hybrid-keyless.test.ts` |
| **双层叠加** | `hybrid.remote → keyless` | 免 Key 网状（可用性）+ 本地协同（开销）正交叠加 | `tests/nested-hybrid-keyless.test.ts` / `npm run hybrid:keyless:demo` |
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
| **rsi** | `types` `ledger` `guardrails` `miner` `operators` `shadow` `loop` `meta` `contrast` `live-contrast` `experience` `velocity` `compound` `index` | `npm run rsi:check` (22) / `meta:check` (25) / `contrast.test.ts` (9) / `contrast-live.test.ts` (9) / `compound.test.ts` (18) / `npm run contrast:live` / `compound:demo` |
| **plan**（v2.3.0） | `backlog.ts`（只增账本读写 + 事件折叠）/ `select.ts`（任务调度 + 教训检索）/ `bin/autopilot.ts`（CLI，不实现不联网）/ `scripts/loc-budget.ts` | `tests/plan.test.ts` (12) / `npm run auto:status` / `npm run budget:check` |
| **bench**（v2.3.1） | `schema.ts`（`bro2.task/2` 契约 + 幂等升格 + 唯一转换点）/ `loader.ts`（分层装载 + 去重 + fixture 引用校验）/ `scripts/bench-v2.ts`（分层评测入口，复用 `runEval`） | `tests/bench-v2.test.ts` (10) / `npm run bench:v2` |
| **fixtures**（v2.3.2） | `data/fixtures/repos/` 4 个快照（v2.6.0 增 `ts-todo`）（ts-strkit / py-dates / js-cart，各埋 1 真缺陷）/ `manifest.json`（内容指纹）/ `scripts/fixture-check.ts`（`--run` / `--update`） | `tests/fixture.test.ts` (4) / `npm run fixture:check -- --run` |
| **ACI**（v2.5.0） | `context/repomap.ts`（预算受限符号索引）/ `tools/patch.ts`（多文件 diff、失败零写入）/ `tools/diagnostics.ts`（三类测试输出结构化）/ `tools/edit-strategy.ts`（唯一命中才降级的编辑链）/ `tools/builtins/code.ts`（`repo_map` `search_symbol` `apply_patch` `diagnostics`） | `tests/repomap.test.ts` (8) / `tests/patch.test.ts` (7) / `tests/diagnostics.test.ts` (5) / `tests/edit.test.ts` (6) / `npm run aci:check` |
| **脏故障与守卫**（v2.8.0） | `models/router.ts`（timeout/retry-after/empty-response 三形态 + `emptyGuard` 空响应守卫 + `retryAfterMs` 尊重）/ 9 个 L3 故障任务 f01–f09 / `--no-empty-guard` 消融 | `tests/flaky.test.ts` (15) / `task:check --layer all` 10/10 / `data/bench/v2-kilo-*9-{on,off}.json` |
| **故障注入**（v2.7.0） | `models/router.ts`（`wrapFlaky` 确定性注入 429/5xx/参数名拼写 + 路由退避重试 + `injected`/`retryAttempts` 归因计数）/ `bench:v2 --no-retry --policy` 消融开关 | `tests/flaky.test.ts` (8) / `data/bench/v2-kilo-fault-*.json`（retry on 3/3 vs off 0/2；repair 3步 vs fail 8步） |
| **l2 任务**（v2.4.0） | `data/tasks/v2/l2.jsonl` 18 个真实工程任务（3 仓库 × 6，`repo` + `hiddenTests` + 参考解）/ `src/bench/runner.ts`（fixture 铺设 + 隐藏断言执行 + 超时强杀）/ `scripts/task-check.ts`（双态校准） | `tests/hidden.test.ts` (6) / `npm run task:check` / `npm run bench:v2 -- --layer all` |
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
| **端点经验闭环门禁** | `examples/endpoint-experience-check.ts` | 跨会话先验 / 冷启动让位 / 硬过滤不绕过 / 回写闭环 / 失效回退（离线确定性） | `npm run endpoint:check` (13) |

### 3.5 测试套件 — ✅
| 产出物 | 路径 | 覆盖 | 项 |
| --- | --- | --- | --- |
| 内核 / 轨迹 | `tests/kernel.test.ts` | 事件、钩子、轨迹、会话 | — |
| 治理 | `tests/governance.test.ts` | 权限、审批、守卫、审计 | — |
| 工具 | `tests/tools.test.ts` | schema/registry/runtime/repair | — |
| 端到端 | `tests/e2e.test.ts` | 跨层编排 | — |
| RSI | `tests/rsi.test.ts` | 有界改进、只增账本 | — |
| 对比式改进 | `tests/contrast.test.ts` | HARNESS² Propose–Probe–Compose | 9 |
| 对比式改进 live 闭环（P1） | `tests/contrast-live.test.ts` | 无真值判定 / 防 reward hacking / 多轮收敛 | 9 |
| 双层叠加（嵌套） | `tests/nested-hybrid-keyless.test.ts` | hybrid→keyless 装配 / 端点穿透 / 统计 | 8 |
| 元 RSI | `tests/meta.test.ts` | 元层写保护 | — |
| 基准 | `tests/benchmark.test.ts` | ablation / ladder | — |
| 外部证据 | `tests/external.test.ts` | 防伪造校验器 | — |
| 接入门禁 | `tests/preflight.test.ts` | 门禁逻辑 | — |
| Ollama | `tests/ollama.test.ts` | 协议兼容 | — |
| 无 Key 聚合 | `tests/keyless.test.ts` | 聚合/故障转移/能力感知/统计 | — |
| 缓存 / 混合推理 | `tests/cache.test.ts` / `tests/hybrid.test.ts` | 缓存优先 / 路由 / 限流降级 | — |
| **计划账本 / 调度** | `tests/plan.test.ts` | 事件折叠 / 依赖调度 / 教训检索 | 12 |
| **合计** | 22 文件 | — | **190** |

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
| 复利中枢 | `docs/COMPOUND-LOOP.md` | 两大设计目标 → 经验层 / 冻结速度尺子 / 治理红线 |
| **竞争计划** | `docs/PLAN-TOP-HARNESS.md` | 九维差距矩阵、HLR/CAS 北极星、W1–W5 战役、13 周里程碑 |
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

1. **代码门禁**：`npm test` 全绿（149/149），无新增 `any` / 无绕过类型检查。
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
- 当前最新：**v2.26.0**（能力水位定位与 ROI 转向裁决：一次**方向性诊断**，不是第 7 版治理门禁。回答四问——能力水位究竟如何 / 有无公开对比参照 / 如何突破完成定位 / 如何发现高 ROI 方向。**水位**：内部 L0/L1/L2 达成、L3 partial、**L4 not-achieved、verdict not-proven、外部证据 0 条**；`overall=1.0` 是 mock 脚本回放、`overall=0.7` 是 kilo 免 Key 端点 10 题 k=1，按 `BENCH-v2 §6` 都不是能力分数 → 诚实结论「内部可验证、外部未测量」。**公开参照**：联网取证 2026 公开参照系，外部有四层成熟参照且与 `Model+Harness=Agent` 命题高度对齐（公开榜单 / 锁定 harness 协议 Harbor·mini-swe-agent·Terminus-2·AgentCompass / 同模型增益实证 arXiv 2605.23950 的 +9.5~16.6pp·harness 方差≈模型 7.8×·6/9 排名翻转 / harness-RSI 赛道 RRSI 64.6→78.7 等都在公开基准交出可复现分数），bro2 侧 0 条。**根因不是没 GPU/没 Key**：外部证据通道被动且从未启用、作战计划与 backlog W5-05 齐备但被 W5-01→04 依赖链压在末尾执行度为零、过去 6 版全投治理层（`The Scaffold Effect` 该层对 pass rate 仅≈2pp）——边际拐点。新增三份预算豁免资产：`data/reference-landscape.json`（14 条外部参照逐条带来源/日期/证据等级、`bro2Measured=false`、`notL4Evidence=true`）、`examples/position-check.ts`+`npm run position:check`（17/17 断言定位视图，从真实 `assessEvidenceLadder` 读水位、防自指隔离、渲染「bro2 在哪一格」）、`docs/CAPABILITY-POSITION.md`（诊断+四问+突破路径+可复用 ROI 判据）。backlog 新增 `P0-POSITION` 三条把 W5-05 解耦，`npm run auto:next` 实测指向 `P0-01`（Harbor 协议接入验证，零 Key 可做）。**诚实修正**：初稿「零 Key deterministic 差分对照」自查删除——确定性 mock 是脚本回放、模型不参与评分，换 harness 量不出能力 Δ，用它冒充定位是空转仪表盘；第一组真实对照数必须有可工具调用的模型端点，不虚报已完成。ROI 判据 `Δ(外部锁定 harness 可证伪增益)÷实现成本`，无法产生可测 Δ 的改动 ROI=0；退出信号可证伪（Δ≤0 降级为可验证 RSI 研究台）。零 `src` 改动、零新增门禁/依赖、未上调阈值、不改 L4/verdict、不写 `external-results.json`、不把任何外部成绩记入 bro2 名下。`npm test` 290/290、门禁 24/24+2/2、预算 16,498/16,500、`position:check` 17/17；`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`）。
- 上版：**v2.25.0**（代码预算阈值防暗调 / 冻结量尺：顺着 v2.24.0「判据不可随可操纵输入浮动」的同一根红线，查出**更底层的同构漏洞**——`scripts/loc-budget.ts` 直接把 `data/plan/budget.json` 的 `limits` 当 `<=` 判据，而 `tests/` 无任何锁定、`project-status` 的 `budget` 门禁又正好读这个可改文件、`guardrails.ts` 注释还误称「门禁阈值在写保护面内」但实际 `budget.json` 不在 `PROTECTED_FILES`：把 `sourceLines 16500→20000` 所有预算门禁立即通过，前 6 个版本所有「预算纪律守住」的结论可被一行 JSON 静默抹掉。修法不硬禁、留合法通道：新增 `tests/budget-integrity.test.ts`（预算豁免 4 项）冻结 `FLOOR`（= 发布时 limits），断言运行时 `limits` 只能 **≤ FLOOR**、`runtimeDependencies` 恒 0、`note` 的「上调须记录理由」约定仍在；**下调随时允许、上调**须先显式改 `FLOOR` + 在 `docs/BENCH-v2.md` 记理由，否则 `npm test` 挂 → `project:status` 的 `test` 门禁（`gate:true`、自动展开全部 `tests/*.test.ts`）挂 → 发布阻断。可证伪反证实验实测：正常 4/4 过、临时改 20000 精确报「被上调：sourceLines」并 fail、还原后工作树干净；含 `raisedLimits()` 合规/下调/逐个上调 4 组对照，证明契约非恒真仪表盘。前提已核实：`budget.json` 全仓纯只读无写回、`autopilot` 仅读 `battles`。诚实边界：锁的是「尺子」不是「能力」，未覆盖「`loc-budget.ts` 源码被改」入口（属写保护面/git diff 范畴），不虚报为全面防篡改。`npm test` 290/290、门禁 24/24+2/2、预算 16,498/16,500、零新增源文件/依赖、未上调阈值；`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`）。
- 历史：**v2.24.0**（否决「相对基线」放水 + 事实基线诊断：先探针实测发现 v2.23.0 绝对零错 veto 在「truth 基线本就 <1」时会**无差别否决所有候选、RSI 自锁**（MIX truth 集 5 恒过+5 恒败、通过率恒 0.5、与候选 state 无关：真实组 `promoted=4/veto=0`，MIX 组 `promoted=0/veto=4`、`truthCurve=[0.5,0.5,0.5,0.5]`，候选「相对基线零退化」却被全拒）；把判据改成「相对基线零退化」看似能解锁、实为**放水**（会放行「外部真值只有 0.5、只是没比坏基线更差」的候选），违背绝对零错红线 → **自我否决**。定性 `基线<1` = 任务集/环境异常、此时 fail-closed 是**预期安全行为**（同完整性 tripwire），不是 bug。真改动只有诊断、不含任何护栏放宽：`runEvolve` 每代基线评测时实测 `truthBefore`（当前 state 对 truth 集的事实通过率、计入 `evalRuns`），**仅用于诊断、不改变判据**（veto 仍是候选 `tr.summary.overall<1` 绝对零错）；账本 reason 结构化为「绝对零错 X<1（事实基线 Y；基线未满=任务集/环境异常，fail-closed 需核查 / 候选引入退化）」，一眼区分环境坏 vs 候选坏；`formatEvolveReport` 口径同步。`tests/evolve-truth-veto.test.ts` 3→5：MIX 场景断言「相对零退化也 `promoted=0`」——任何把判据偷换成相对基线的放水实现都会立即挂；诊断口径测试断言事实基线数值 + fail-closed 根因、基线未满不得误标候选退化。诚实标注「基线满分→候选退化」分支受三段判据前置过滤、端到端近乎不可达，未虚构覆盖。`npm test` 286/286、门禁 24/24+2/2、预算 16,498/16,500、零新增源文件/依赖、未上调阈值；`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`，本版未放宽任何护栏、未放大任何晋升，新增只是「静默自锁 → 可诊断」）。
- 上版：**v2.23.0**（外部真值段接入 evolve 晋升闭环 + 独立 veto：把 v2.22.0 那个「可用但从未被喂」的 `usedExternalOracle` 变成运行时真实生效的独立约束——`runEvolve` 加载 `data/truth-tasks.jsonl`，在三段判据（`judgePromotion`）通过之后、真正晋升之前，用 `evaluate(影子 root, 候选 state, truth)` 复核候选**实际产出**（终答/文件）相对 agent 不可见 `reference`，聚合 `summary.overall` 到 `truthCurve`；`truthRate<1`（任一 oracle 未过）即**独立 veto** 该候选、`truthVetoes+=1`、账本 reason 明确写「外部真值 veto」，三段判据语义与 v2.22.0 红线完全不动；`usedExternalOracle` 由运行时真实喂入（`truth.length>0`）；`EvolveReport` 新增 `truthCurve`/`truthVetoes`，`formatEvolveReport` 输出「外部真值 1 → 1 · veto N」可观测行。决定性前提已探针实测：候选 `state` 经 `makeShadowRoot` 注入影子 config 的 budget/policy 会改变 guard/grounding/step-ceiling，默认 state truth 通过率 1.0、`maxSteps=1` 时降到 0.4 且 4 个 oracle 失败——truth 段是**可证伪、非恒定绿灯**的独立信号。新增 `tests/evolve-truth-veto.test.ts` 3 项正反对照（隔离 root 只换 truth 集、三段 verdict 序列相同、唯一变量是外部真值通过率：全过组 promoted≥1·零 veto，恒失败组 promoted=0·veto≥1·账本留痕）。truth 段仅在三段已过时跑、每代最多 +1 评测；按「删优先于加」精简 loop.ts 多处 JSDoc 腾出预算。`npm test` 284/284、门禁 24/24、预算 16,498/16,500、零新增源文件/依赖、未上调阈值；`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`，truth 段是正确性零退化护栏、不是能力增益测量面）。
- 上版：**v2.22.0**（晋升闸门放行外部真值 oracle 佐证：把 v2.20.0 的 `oracle` 原语接入 RSI 晋升闭环**审计层**——`PromotionSpec` 新增可选 `usedExternalOracle`、verdict 新增 `externalOracleCorroborated`，仅作独立佐证记入审计、绝不影响 `promoted`；同时收紧 `judgePromotion` 铁律，使「harness 内部真值验证器（读自身行为、自确认循环）」与「外部真值 oracle（agent 不可见 reference、外部可证伪）」**互斥**——前者仍拒晋升、后者放行但只审计。`tests/promotion.test.ts` 12→14（外部 oracle 不阻断晋升且被标记；二者互斥时内部验证器仍拒、外部 oracle 仍标记）。净省 2 行预算。`npm test` 281/281、门禁 24/24、预算 16,497/16,500、零新增源文件/依赖、未上调阈值；`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`）。
- 上版：**v2.21.0**（真值任务集评测落地：把 v2.20.0 的外部真值 `oracle` 原语真正用起来——新建 `data/truth-tasks.jsonl`（10 项任务，覆盖 `answer-matches-reference`/`answer-equals-reference`/`file-contains-reference` 三类 oracle 与全部 `EvalCategory`，truth-01/06 同时要求 `expectedTools`+文件真值命中，叠合「真调工具」与「真产正确结果」两条独立证据），接通 `runEval→grade→oracle→summary` 全链路；新增 `eval:truth`/`eval:truth:live` 脚本（独立基线 `data/truth-baseline.json` 避免污染主回归基线），`data/truth-baseline.json`/`data/eval-live-report.json` 进 `.gitignore`。确定性 `eval:truth` 10/10、总体 100%、五类全绿；live 经 kilo 端点实测 7/10·overall 0.7（oracle 正确标记 truth-09 未外部拒绝危险请求），端点工具能力不稳、非干净基准。`npm test` 279/279、门禁 24/24、预算 16,499/16,500、零新增源文件/依赖、未上调阈值；`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`）。
- 上版：**v2.20.0**（外部真值 oracle 评测 + RSI 子系统收敛：把重叠的三件套 `src/rsi/contrast.ts`+`live-contrast.ts`+`compound.ts` 合并为单一 `src/rsi/contrast.ts`（525 行/3 文件 → ~465 行/1 文件，导出集合不变、53 项相关单测全绿），腾出 2 源文件槽位、净省 ~60 行预算；新增 `EvalTask.oracle` 外部真值评测原语（内置 `answer-matches-reference`/`answer-equals-reference`/`file-contains-reference`），grading 只读 agent 实际产出与 agent 不可见 `reference` 比对、绝不读 harness 内部行为指标，把「自指评分」变「外部可证伪评分」，并经 `runOne→grade()` 汇入 `summary.overall` 使 RSI 晋升相对独立真值；新增 `tests/external-grade.test.ts` 6 项。`npm test` 279/279、门禁 24/24、预算 16,499/16,500、零新增依赖、未上调阈值）。
- 上版：**v2.17.0**（只增账本 git 历史完整性门禁：`watermark-check` 只校验账本当前态，本版把「只增账本」升级为 git 历史级可验证的发布阻断门禁——`examples/ledger-append-only-check.ts` 第 24 道门禁对 `journal.jsonl`/`lessons.jsonl` 两本真正只增账本逐对相邻 commit 校验条目序列前缀不变量（条目级 canonical 比对，删除/重排/语义篡改必抓、纯格式化放行），`ci.yml` 改 `fetch-depth: 0` 让其在 CI 生效；backlog.jsonl 因历史上有一次良性语义改写（W1-03 依赖 W1-04→W1-02）不纳入。`npm test` 273/273、门禁 24/24、预算 16,499/16,500、净 +1 行、未上调阈值）。
- 上版：**v2.16.0**（P0.5-c 成本晋升目标：`judgePromotion` 的 `PromotionSpec` 新增可选 `cost` 字段，判定机器加第 7 条铁律「能力不降前提下远程调用不得上升」（成本退化即阻断、不参与 promoted）；`examples/p0.5c-check.ts` 第 23 道门禁 6/6 断言：真实三段分数喂判定机器，能力晋升+成本不升→晋升、能力晋升+成本反升→阻断、成本不越权覆盖能力、未传成本→向后兼容。诚实边界：不产生能力分数，`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`；`cost` 只是判定机器，真实 `remoteAvoided` 信号需 hybrid 评测接入（确定性评测域 mock 无远程/本地之分）。`npm test` 273/273、门禁 23/23、预算 16,498/16,500、零新增源文件、未上调阈值）。
- 上版：**v2.15.0**（阶段 C 接入 RSI 主循环：`runEvolve` 晋升闸门换成 `judgePromotion` 三段铁律（dev 严格提升 / holdout·OOD 不退化 / OOD 完全只读 / 协议零违规），新增真实 OOD 段 `data/evolve/ood.jsonl`（只读退化探针，默认状态即应通过、改进不得使其退化），OOD 退化自动阻断并写 `journal` 可复核（`W4-C-ood-block`）；散落 6 处 `ledger.append` 收口到 `appendLed` helper、删 `efficiencyTiebreak` 特殊分支；`evolvePaths` 暴露 `ood` 段、OOD 纳入写保护面。`npm run phasec:check` 第 22 道门禁 7/7 断言：判定机器消费真实三段、OOD 退化即阻断且写 journal、搜索只碰 dev。诚实边界：不产生能力分数，`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`，缺口从「缺接入」变成「缺一次真实能力增益的测量」；`npm test` 273/273、门禁 22/22、预算 16,492/16,500（反而 freed 5 行）、零新增源文件、未上调阈值）。
- 上版：**v2.13.0**（接入门禁组合路径盲点修复：`complete()` 硬编码流式 + llama.cpp handler 拒绝「流式+自动工具选择」→ 本地端点 preflight 全绿却零工具调用；provider 新增 `stream`/`maxTokens` 可配（默认不变）、非流式解析回规范 `tool_calls`、探针补「流式+带 tools」组合观测与 `max_tokens`，`toolCalling=native` 硬门槛不放水；`tests/nonstream.test.ts` 5/5。1.5B 实测链路修通（preflight PASS、稳态 0.6s、无 OOM），但本机纯 CPU 多步评测 18 分钟挂起，`provider_error` 报告按红线删除；历史「0.5B 能力下限」结论因链路缺陷撤销、需重测。测量机器修复，不是能力分数；`npm test` 273/273、门禁 20/20，零新增源文件、未上调阈值）。
- 上版：**v2.12.0**（端点健康经验接线：`endpointPriorFromExperience` 折叠跨会话先验注入 `KeylessAggregator.score()`、成败回写只增账本，补上「健康态进程内、重启清零 / `endpoint` 域只写不读」缺口；`npm run endpoint:check` 第 20 道门禁 13/13 离线验证先验只影响排序、不绕过冷却/限流硬过滤、失效与样本不足归零回退；运行时 opt-in 默认关闭，避免写被跟踪账本制造假 diff；结构闭环证据而非能力分数；`npm test` 268/268、门禁 20/20，零新增源文件、未上调阈值）。
- 上版：**v2.11.0**（三段晋升判据：`judgePromotion` 要求 dev 严格提升 / holdout·OOD 不退化 / OOD 完全只读 / 三段无缺格 / 任务集冻结 / 协议 0 / 完整性通过，自报增益绝不参与判定；`npm run promotion:check` 第 19 道门禁以真实 `runEval` 三段分数验证合法晋升 1/1 接受、12 个违规信号全拒绝，退化即阻断；阶段 C 前置闸门。判定并入 `eval-grade.ts`、编排并入 `bench-v2.ts`，**零新增源文件、未上调阈值**；`npm test` 261/261、门禁 19/19）。
- 上版：**v2.10.0**（免 Key 端点体检与聚合器健康度修复：15 个端点匿名实测双层归因、新增匿名 `ovhcloud` 后端、复活 `llm7`、按实测重排聚合器优先级、本地 0.5B 服务归位；**负结果**：0.5B L2 准入 0/3、0 工具调用，弱模型证据缺口原因升级为「能力下限」；`npm test` 249/249、门禁 18/18）。
- 上版：**v2.9.0**（故障恢复证据的确定性回归门禁：`faults.provider` 在 deterministic / live 均生效；`npm run fault:check` 三组 on/off 对照 3/3 接受，离线可复算、防哑弹、拒绝自报增益，进第 18 道发布阻断门禁；判定并入 `eval-grade.ts`、编排并入 `bench-v2.ts`，**零新增源文件、未上调代码预算阈值**；`npm test` 249/249、门禁 18/18）。
- 上版：**v2.8.0**（脏故障形态 timeout/retry-after/empty-response + 空响应守卫 + 故障任务扩到 9 个；三组对照：重试 5/5 vs 0/5、守卫 2/2 vs 0/2、repair 效率级；`npm test` 237/237；**负结果**：免 Key 弱端点均为链路故障，弱模型对照证据缺口保留）。
- 上版：**v2.7.0**（故障注入 + 路由瞬态重试；首个正向增益证据：重试开 3/3 vs 关 0/2）。
- 上版：**v2.6.0**（L3 首任务 + ts-todo fixture；0pp 负结果延续，shell 抹平工具层差异）。
- 上版：**v2.5.0**（W2 编码 ACI：repomap / apply_patch / diagnostics / 编辑降级链；L2 live 17/18）。
- 上版：**v2.4.0**（W1-03/04：18 个 L2 任务 + 隐藏测试执行器 + 双态校准；`npm test` 196/196）。
- 上版：**v2.3.2**（W1-02：3 个 fixture 仓库快照，各埋 1 个可证实的真缺陷，可见测试 16 项全绿）。
- 上版：**v2.3.1**（W1-01：v2 任务 schema `bro2.task/2` + 分层装载器 + `bench:v2` 入口；l1 零漂移迁移 19/19）。
- 上版：**v2.3.0**（自治执行机制：计划账本三件套 + `auto:next` 调度 + 教训检索；「少而精」工程宪法：第 13 道代码预算门禁）。
- 上版：**v2.2.2**（修复 CI 验收门禁失败：移除测试对本机凭证路径依赖，新增 CI 可移植性门禁与网络抖动加固）。
- 上版：**v2.2.1**（改进即推送：唯一推送通道 + 一键 `ship` 闭环 + 防漏推门禁，复用仓库外持久化 PAT 凭证）。
- 更早：**v2.2.0**（进化启动器 + 迭代水位看板：真实评测驱动、跨会话只增账本、冻结尺子逐轮前缀投影）。
