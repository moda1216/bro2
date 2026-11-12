# bro2 · 文档索引

> 全部文档的导航与阅读路径。项目根：`/workspace/bro2`。

---

## 1. 文档地图

| 文档 | 定位 | 什么时候读 |
| --- | --- | --- |
| [README.md](../README.md) | 总入口：快速开始、能力矩阵、目录、运行命令 | 第一次接触 |
| [DESIGN.md](../DESIGN.md) | 8 层架构、能力矩阵、接口契约、治理模型；附录 A 选型决议 · B 有界 RSI · C 策略层 / meta RSI / 基准追加设计 | 想改架构 / 理解分层 |
| [EVAL.md](../EVAL.md) | 能力评测体系、指标口径、门禁、持续提升闭环、meta RSI 与证据阶梯、真实模型接入 | 要跑评测 / 定位能力问题 |
| [RSI.md](../RSI.md) | RSI 前沿调研（2026 综述、DGM/SICA/ADAS/SkillOpt 等）、验证层级、失败模式、bro2 有界定位 | 理解"为什么这么设计自我改进" |
| [META-RSI.md](../META-RSI.md) | meta RSI：改进改进机制自身、冻结 fitness、防自确认循环、实证 | 理解 L4 自指与元层治理 |
| [BENCHMARK.md](../BENCHMARK.md) | 「领先」的可证伪定义、5 级证据阶梯、ablation、外部基准导入接口 | 要判断能力水平 / 接外部基准 |
| [ITERATIONS.md](../ITERATIONS.md) | 本轮多轮迭代日志：每轮发现→改动→证据→晋升/拒绝，含被拒改动与未解决问题 | 复核改动 / 继续迭代 |
| [docs/API.md](./API.md) | REST + SSE API 端点、SSE 事件格式、示例、安全边界 | 接前端 / 外部系统 |
| [docs/TAKEOVER.md](./TAKEOVER.md) | 真机接管手册：接真实模型 → 跨 provider 矩阵 → 公开基准 → 外部结果导入 | 要把 `not-proven` 往前推 |
| [docs/LOCAL-LLM.md](./LOCAL-LLM.md) | 本地真实推理服务（llama.cpp + Ollama 官方权重）：装不上 Ollama 二进制时的等价 OpenAI Compat 端点与实测坑 | 沙箱内要跑真实模型 |
| [docs/FREE-LLM-APIS.md](./FREE-LLM-APIS.md) | 免费 LLM API 接入：OpenRouter/NIM/SiliconFlow/DeepSeek/Groq 的沙箱实测可达性、免费模型、限速、一条命令跑真实强模型 | 本地算力不足、要零部署测真模型 |
| [docs/RSI-NEXT.md](./RSI-NEXT.md) | RSI 演进路线图：对齐 HARNESS²/Evo²/RRSI/OO-Harness，逐篇映射到 bro2 下一步 | 想推进"业界水平"、理解演进方向 |
| [docs/ITERATION-WATERMARK.md](./ITERATION-WATERMARK.md) | 迭代水位：在哪里看、逐轮变化、如何推进、诚实边界（自动生成） | 想看「越用越快」是否真的发生 |
| [docs/COMPOUND-LOOP.md](./COMPOUND-LOOP.md) | 复利闭环：经验库 + 冻结速度尺子 + 学习型路由的设计与边界 | 理解两大设计目标的共享底座 |
| [docs/PLAN-TOP-HARNESS.md](./PLAN-TOP-HARNESS.md) | **竞争顶级 Agent Harness 作战计划书**：九维差距矩阵、HLR/CAS 北极星指标、W1–W5 五大战役、13 周里程碑、风险与退出条件 | 想知道「bro2 凭什么竞争、下一步做什么」 |
| [docs/CAPABILITY-POSITION.md](./CAPABILITY-POSITION.md) | **能力水位定位与 ROI 转向（v2.26.0）**：诚实水位=内部可验证/外部未测量、2026 公开参照系四层、为何至今无法定位的结构性根因、Harbor 突破路径、可复用 ROI 判据与 P0 解耦（§8.1 记录 v2.27.0 已走出去测量、§8.2 记录 v2.28.0 k=3 硬化 + 跨模型 holdout 尝试、§8.3 记录 v2.29.0 P0 接入口收口：Harbor 装载 + 跨 agent 对照框架 + 跨模型复测启动、§8.4 记录 v2.30.0 公开榜单任务集直跑 + 轨迹层面能力画像） | 想回答「能力到底如何、有没有公开对比、下一步做什么」 |
| [docs/EXTERNAL-MEASUREMENT.md](./EXTERNAL-MEASUREMENT.md) | **走出去测量硬化（v2.28.0）+ P0 接入口收口（v2.29.0）**：k=3 通过率 + 跨模型 holdout 尝试；公开任务 + 公开评分器双向反证、同模型同预算对照 kilo 上 bro2 6/9 vs minimal 2/9（Δ=+4）、ovhcloud 限流致 0/3 无效对照、Harbor 装载与跨 agent 可复核对照框架、诚实边界与复现命令 | 想把「外部未测量」变成可辩护的真实测量 |
| [docs/TRAJECTORY-ANALYSIS.md](./TRAJECTORY-ANALYSIS.md) | **轨迹层面能力画像（v2.30.0，策略 B）**：不等人填对照槽，直接抓其他 agent 公开轨迹数据、靠轨迹差异判断 bro2 能力；bro2 步数/工具调用/停止行为 vs 公开轨迹统计（SWE-bench `Avg. $ Trajs`、2025 研究每题 5–20 轨迹），HF 不可达故只用聚合参照轴；读出「失败题工具调用反而更多」的可证伪 harness 行为结论 | 想从轨迹效率/停止行为轴看 bro2 与公开 agent 的差异 |
| [docs/INDEX.md](./INDEX.md) | 本文件 | 找文档 |

运行产物（非文档，但常被引用，均在 `data/`）：

| 文件 | 内容 |
| --- | --- |
| `data/eval-report.json` / `eval-baseline.json` | 确定性主评测报告与回归基线（仅 `eval` 写，L1 证据来源） |
| `data/eval-live-report.json` | 真实模型 live 评测报告（第一份真实分数 `0/12`，仅 `eval:live` 写） |
| `data/live-link-smoke.json` | live 链路自检（显著标注非模型能力分数） |
| `data/local-llm-stats.json` | 本地真实推理服务累计统计（requests / tokens / 推理秒数，**非能力分数**） |
| `data/evolve-report.json` | 能力面 RSI 演进报告（train/holdout 曲线、晋升明细） |
| `data/evolve/ledger.jsonl` / `incidents.jsonl` | 能力层只增账本 / 安全事件 |
| `data/evolve/state.json` / `strategy.json` | 已落地的能力状态 / 算子先验 |
| `data/meta-report.json` | meta RSI 报告（冻结 fitness 曲线） |
| `data/evolve/meta-state.json` / `meta-ledger.jsonl` | 已落地的元状态 / 元层只增账本 |
| `data/benchmark-report.json` | ablation + 证据阶梯 + 领先度声明 |
| `data/reference-landscape.json` | **外部公开参照系台账**（2026-11-10）：14 条公开榜单/锁定 harness 协议/同模型增益/harness-RSI 赛道，逐条带来源·日期·证据等级；`bro2Measured=false`·`notL4Evidence=true`，不是 bro2 成绩 |
| `data/bench/external/` | **外部公开任务测量**（2026-11-11 起）：`UPSTREAM.json` 固定 commit + `SHA256SUMS` + `tasks.jsonl`（4 个 SOUND 任务，含剔除 4 个构建时依赖任务的留痕）+ `external-measure-report.json`（对照 Δ 与诚实声明）+ `bro2-eval-report.json` + `harbor-verify-report.json`（P0-01 零 Key 接线验证）+ `agent-comparison.json`（P0-02 跨 agent 对照模板）+ `cross-model-report.json`（P0-04 ovhcloud 有界复测）+ `tb-leaderboard-snapshot.json`（A1 公开榜快照，带出处）+ `tb-leaderboard-compare-report.json`（A2 bro2 直跑公开任务集对照，kilo 2/4 positioning-only）+ `tb-leaderboard-compare-kilo.json` + `tb-leaderboard-compare-ovhcloud.out`（同模型锚点尝试证据）；`upstream/` 不入库，外部成绩不记入 bro2 名下 |
| `examples/harbor/` | **P0-01 Harbor 装载接入口**：`bro2_agent.py`（Harbor `BaseInstalledAgent` 契约）+ `config.yaml` + `README.md`；`examples/harbor-verify.ts` 零 Key 三方对齐验证；`npm run harbor:verify` |
| `examples/cross-model-retest.ts` | **P0-04 跨 holdout 模型复测**：在 ovhcloud/gpt-oss-120b（与 kilo 不同模型族）上重跑 bro2 vs minimal；`npm run cross:model` |
| `data/rsi/velocity.jsonl` / `experience.jsonl` | 复利速度 / 经验的只增账本（跨会话累积，不回写历史） |
| `data/rsi/watermark.html` / `watermark.json` | 迭代水位可视化看板与结构化数据（自动生成） |
| `data/rsi/compound-tasks.jsonl` | 复利回路专属工作负载（与主能力评测任务集隔离） |
| `data/workspace/` | 工具真实写入的工作区 |

---

## 2. 按任务阅读

| 我想… | 读 | 跑 |
| --- | --- | --- |
| 先跑起来 | README §快速开始 | `npm run cli` / `npm run web` |
| 看懂架构再改代码 | DESIGN → docs/API | `npm test` |
| 判断能力到底如何 / 有无公开对比 | **docs/CAPABILITY-POSITION.md** → BENCHMARK → EVAL | `npm run position:check` → `npm run benchmark` → `npm run benchmark:check` |
| 在公开任务上量一次 harness Δ | **docs/EXTERNAL-MEASUREMENT.md** | `npm run external:fetch` → 构建 verifier 镜像 → `AGENTOS_LIVE_PROVIDER=kilo npm run external:measure` |
| 接真实模型 / Ollama | EVAL §真实模型 → docs/API §5 | `npm run doctor` → `npm run preflight` → `npm run eval:live` |
| 理解自我改进 | RSI → ITERATIONS | `npm run evolve` → `npm run rsi:check` |
| 理解 meta 改进 | META-RSI | `npm run meta` → `npm run meta:check` |
| 验证策略分支真的生效 | ITERATIONS 轮 1 | `npm run policy:check` |
| 接真实模型 / 补齐外部证据 | docs/TAKEOVER | `npm run preflight` → `npm run eval:live` → 导入外部结果 |
| 沙箱内验证 live 链路 | docs/TAKEOVER §1.3 | `npm run live:smoke` → `npm run preflight:check` |
| 沙箱内跑真实模型推理 | docs/LOCAL-LLM.md | 起本地服务 → `npm run preflight` → `npm run eval:live` |
| 零本地部署跑真实强模型 | docs/FREE-LLM-APIS.md | `npm run free:probe` → 填 Key → `AGENTOS_LIVE_PROVIDER=openrouter npm run eval:live` |
| 推进 RSI 演进路线 | docs/RSI-NEXT.md | 读路线图 → 落 P0–P5 |
| 查看 / 推进迭代水位 | docs/ITERATION-WATERMARK.md → `data/rsi/watermark.html` | `npm run watermark` → `npm run evolve:tick -- --rounds 8` |
| 规划「如何竞争顶级 harness」 | docs/PLAN-TOP-HARNESS.md | 先读 §1 现状体检 → §4 W1 基准重建 → §9 本周第一步 |
| 改进后同步 GitHub 远程 | 发布流程见 CHANGELOG v2.2.1 | `npm run ship`（提交 + 推送 + 自检）→ `npm run push:check` |
| 提交前全量回归 | 本页 §3 | `npm test && npm run verify && ...` |

---

## 3. 命令速查

```bash
# 运行
npm run cli                    # 交互 CLI
npm run web                    # Web UI + REST/SSE (127.0.0.1:3080)
npm run demo                   # 完整离线演示
npm run doctor                 # 模型端点 + tool_calling 能力诊断（面向人）
npm run preflight              # 接入门禁：ready=PASS→EXIT=0，未就绪→EXIT=1（CI 可用）
npm run live:smoke             # live 全链路自检（仿真端点，明确非模型能力分数）
# 本地真实推理服务（Python，见 docs/LOCAL-LLM.md）：
#   LOCAL_MAX_TOKENS=128 python3 tools/local-llm-server.py --threads 4 --stats-file data/local-llm-stats.json

# 评测与验证
npm test                       # 单元 + 端到端 + 故障注入（190 项）
npm run verify                 # L0–L7 能力矩阵结构自检（23 项）
npm run eval                   # 确定性行为回归（19 任务 + 门禁）
npm run bench:v2               # 分层任务评测（--layer l1|l2|all，判分复用唯一评测器）
npm run fixture:check -- --run # fixture 快照校验（结构 / 体积 / 内容指纹 / 离线测试）
npm run eval:live              # 真实模型端到端（内置 preflight 门禁，需自备端点）
npm run preflight:check        # 门禁防误判 / 证据面隔离（37 项）
npm run policy:check           # 5 个策略代码分支实证（19 项）
npm run ollama:check           # Ollama 协议级高保真仿真（4 项）
npm run free:probe             # 免费 LLM API 可达性 / 鉴权状态探针（5 家）

# 自我改进
npm run evolve                 # 能力面 RSI（改进固化到运行时）
npm run evolve:dry             # 只诊断不写回
npm run rsi:check              # RSI 端到端 + 恶意候选注入（22 项）
npm run meta                   # meta RSI（改进机制自身）
npm run meta:dry               # 只诊断不写回
npm run meta:check             # 元层写保护 / 冻结 fitness（25 项）

# 自治推进与工程预算
npm run auto:status            # 五战役进度 / 阻塞项 / 已用 LOC
npm run auto:next              # 下一个任务卡（含验收标准与命中的历史教训）
npm run budget:check           # 代码预算门禁（行数 / 文件数 / 依赖 / 测试比）

# 能力基准
npm run benchmark              # ablation + 证据阶梯 + 领先度声明
npm run benchmark:check        # 测量机器诚实性（21 项）
npm run external:check         # 外部证据导入防伪造（38 项）
npm run position:check         # 能力水位定位视图（17 项断言，只读、不产生能力分数）
```

**推荐复现顺序**（报告之间有依赖，benchmark 会读其它报告）：

```
npm run evolve  →  npm run meta  →  npm run eval  →  npm run benchmark
```

---

## 4. 目录结构

```
agent-os/
├── DESIGN.md  README.md  EVAL.md  RSI.md
├── META-RSI.md  BENCHMARK.md  ITERATIONS.md      # 本轮新增
├── docs/  API.md · INDEX.md · TAKEOVER.md          # 真机接管手册
├── agentos.config.json    package.json
├── bin/agentos.ts                               # CLI / Web 入口
├── src/
│   ├── kernel/       events · hooks · trajectory · session · runtime · loop
│   ├── runtime/      policy.ts                   # ★ 行为策略分派层（本轮新增）
│   ├── models/       base · mock · openai-compat · router · preflight
│   ├── context/      budget · builder
│   ├── tools/        schema · registry · runtime · repair.ts · mcp · plugin · builtins/
│   ├── governance/   permissions · approval · guards · audit
│   ├── memory/  cognition/  delegation/
│   ├── observability/ tracing · eval
│   ├── benchmark/    ladder · ablation · scoring · external · index
│   ├── rsi/          types · ledger · guardrails · miner · operators · shadow · loop · meta.ts  # ★ meta 新增
│   └── interfaces/   cli · api · web/index.html
├── skills/*/SKILL.md   presets/*.json
├── data/               eval-tasks.jsonl · evolve/{train,holdout,...} · benchmark/ · 运行时产物
├── examples/           demo · verify · policy-check · evolve-check · meta-check · benchmark-check · ollama-*
└── tests/              kernel · governance · tools · e2e · ollama · rsi · meta · benchmark
```

---

## 5. 一句话边界

bro2 是**可读、可改、与设计逐条对应**的 Agent OS 内核，零第三方依赖；
它在自建确定性域内实现了可验证的多轮自我改进与 meta 改进，
但**未证明行业领先**（缺公开基准与真实模型对比），也**不是生产级底座**（应用层沙箱、无类型检查）。
详见 [BENCHMARK.md](../BENCHMARK.md) 与 [DESIGN.md 附录 A](../DESIGN.md)。
