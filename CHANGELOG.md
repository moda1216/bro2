# bro2 · 发布日志（CHANGELOG）

> 语义化版本 `MAJOR.MINOR.PATCH`：
> - **MAJOR**：破坏性架构变更（接口/契约不兼容，需迁移）。
> - **MINOR**：新增能力域或重大特性（向后兼容）。
> - **PATCH**：修复、证据更新、文档/验收脚本补齐（向后兼容）。
>
> 发布动作（强制）：feature 完成 → `npm run project:status` 全绿 → `git tag -a vX.Y.Z` → 追加本条目 → 同步 [DELIVERABLES.md](./DELIVERABLES.md) §3 状态。
> 产出物管理三件套：`DELIVERABLES.md`（登记册）· `CHANGELOG.md`（本文件）· `ROADMAP.md`（演进）。

---

## [2.0.4] — 2026-11-08 · 无 Key 端点统一聚合器（PATCH）

> 类型：**PATCH · 能力增强 + 接入扩展**。回答"所有远程无 Key 端点应被统一智能管理、聚合成唯一接口"——对标 KeylessAI / Zerogateway 的统一路由器设计。

### 新增（Added）
- **无 Key 端点统一聚合器** `src/models/keyless.ts` · `KeylessAggregator implements LLMProvider, StatsProvider, CompositeProvider`：把 `kilo` / `pollinations` / `opencode-zen` / `keylessai` / `llm7` 等免 Key 上游（含 KeylessAI 统一网关、Zerogateway 风格路由器、DeepSeek-Harness 插件模型）**聚合成唯一 OpenAI 兼容接口**交给 bro2；`tests/keyless.test.ts`（10 项）。
- **智能管理（四类机制）**：
  1. **健康评分路由（smart-fallback）**：综合优先级、失败惩罚、限流惩罚、最近延迟、成功率打分选最优上游；并支持 `round-robin` / `priority` 策略。
  2. **限流感知故障转移**：识别 `429 / FreeUsageLimit / Too Many Requests / 5xx` 等，将上游标记为限流冷却并自动切到其它可用上游，而非反复重试打满配额。
  3. **能力感知**：标记「不支持 function calling」的上游在带 `tools` 的请求中被跳过，避免真实工具任务上踩坑。
  4. **应急兜底**：全部上游失败时降级到 `emergencyProvider`（如本地小模型），不静默返回空响应。
- **网状可观测**：`meshStats()` 露出每个上游明细健康度（失败/冷却/限流/延迟/成功率）；`inferenceStats()` 暴露聚合层远程调用计数；`underlying()` 供 `preflight` 对真实端点做探针。
- **配置与装载**：`agentos.config.json` 新增 `keyless` 聚合器（`autoDiscoverKeyless:true` 自动纳入所有「apiKeyOptional 且非本地」的已注册 provider），新增上游 `keylessai`（统一网关）、`zerogateway`（路由思路）、`dsv41-flash` / `kimi-k3` / `glm-53`（DeepSeek-Harness 插件免 Key 模型，填 `OUR_FREE_MODEL_BASE_URL` 即接入）；`src/index.ts` 增加第三遍 `keyless` 装配。
- **CLI 增强**：`doctor` 现可展示聚合器网状健康度；`npm run free:probe` 新增 keyless 网状报告；`npm run keyless:demo` 离线确定性演示限流故障转移 + 应急兜底（`examples/keyless-demo.ts`）。
- `OpenAICompatProvider` 新增 `supportsTools` 能力声明（供聚合器做能力感知路由）。

### 诚实边界（不变）
- `leadership.verdict = not-proven`、证据阶梯 L4 = `not-achieved` 不变：聚合器提升的是「网状韧性 + 接入便利」，不抬高单模型能力；公开基准对齐与第三方复现（ROADMAP P5）仍待完成。

---

## [2.0.2] — 2026-11-07 · 无 Key 真实评测通路（PATCH）

> 类型：**PATCH · 真实证据 + 接入补齐**。打通「零 API Key、零注册」的真实模型评测，并归档首份无 Key 真实分数。

### 新增（Added）
- **无 Key 匿名端点接入**：`agentos.config.json` 新增 `pollinations` provider（`apiKeyOptional:true`，匿名层，免 Key、免注册），复用现有 OpenAI 兼容适配器。沙箱实测 6/6 通过 `preflight`。
- **首份无 Key 真实分数**：`AGENTOS_LIVE_PROVIDER=pollinations npm run eval:live` 真跑出 `gpt-oss-20b`（经 Pollinations 匿名层）的 **overall 25%（3/12）**、**协议违规 0**、零 API Key。已归档 `data/live-pollinations-gptoss20b.json`。
- 文档 `docs/FREE-LLM-APIS.md` 新增「无 Key 匿名端点（已实测可用）」章节，登记 Pollinations 并诚实标注其分数受匿名限速（~45s/IP）与 20B 模型规模压制。

### 修复（Fixed）
- `examples/free-api-probe.ts`：把硬编码的免费 provider 名单补入 `pollinations`，使 `npm run free:probe` 自动覆盖该无 Key 端点（`toolCalling: native`、`streaming: ✓`、`authRejected: ✗`）。

### 诚实边界（不变）
- `leadership.verdict = not-proven`、证据阶梯 L4 = `not-achieved` 不变：25% 是 20B 开放权重模型在受限匿名端点上的**下界**（限速拖慢至 ~90s/任务、工具错误率含重试超时），非 bro2 harness 能力的上限证明；公开基准对齐与第三方复现（ROADMAP P5）仍待完成。

---

## [2.0.3] — 2026-11-08 · 本地+远程协同降远程调用 + 无 Key 端点扩展（PATCH）

> 类型：**PATCH · 能力增强 + 接入扩展**。回答"本地模型如何与远程 API 配合减少远程调用"，并把无 Key 端点从 1 家扩到 4 家。

### 新增（Added）
- **透明响应缓存** `src/models/cache.ts` · `CachedProvider`：相同 `(model+messages+tools+temperature)` 请求命中即零调用，统计 `cacheHits / remoteAvoided`；`tests/cache.test.ts`（3 项）。
- **本地+远程混合推理** `src/models/hybrid.ts` · `HybridProvider`：① 缓存优先 ② 启发式路由 `cheap-to-local`（无工具/工具结果整理走本地，需推理走远程）③ 远程限流/5xx 自动降级到本地而非失败；`tests/hybrid.test.ts`（6 项）。
- **配置与装载**：`agentos.config.json` 新增 `hybrid` provider（`remote=kilo` / `local=local-qwen`）+ 无 Key 端点 `kilo` / `opencode-zen` / `llm7`；`src/index.ts` 增加 `cached`/`hybrid` 组合类型装载（两遍装配，引用已注册底层 provider）。
- **OpenAI 兼容适配器增强**：`src/models/openai-compat.ts` 支持 `extraHeaders` 与 `genSessionHeader`（OpenCode Zen 等需 `x-session-id` 的无 Key 端点）。
- **评测效率指标**：`eval:live` 报告新增 `inference` 字段（`remoteCalls / localCalls / cacheHits / remoteAvoided / remoteCallRatio`）；`ProviderRouter.inferenceStats()` 委托聚合。
- **真实演示** `examples/hybrid-demo.ts` + `npm run hybrid:demo`：5 次相同工具调用只打 1 次远程、2 次纯生成走本地，远程占比 100%→14.3%。
- `live` 门禁放宽：组合 provider（hybrid/cached）不再被拒，门禁落到其底层远程端点（`bin/agentos.ts`）。

### 修复（Fixed）
- `bin/agentos.ts` live 预检仅认裸 `OpenAICompatProvider`，导致 `hybrid`/`cached` 无法进 live 评测——改为委托底层端点做门禁，仅拒绝 Mock。

### 验证（Verification）
- `tests/cache.test.ts` + `tests/hybrid.test.ts`：9/9 通过；全量 `npm test` **104/104**。
- `npm run hybrid:demo`：远程占比降至 14.3%，`remoteAvoided=4`。
- `AGENTOS_LIVE_PROVIDER=hybrid npm run eval:live`（t01 真实任务）：报告含 `inference={remoteCalls:1, localCalls:2, remoteCallRatio:0.333}`，**67% 模型调用未打远程**，协议违规 0。已归档 `data/live-hybrid-kilo-qwen.json`。

### 诚实边界（不变）
- `leadership.verdict = not-proven`、L4 = `not-achieved` 不变。混合推理降低的是**远程调用成本与限流脆弱性**，不改变"需公开基准+第三方复现才能宣称领先"的结论；单任务真实评测分数低源于无 Key 端点模型较弱，非 harness 退化。

---

## [2.0.1] — 2026-11-07 · 产出物管理交付（PATCH）

> 类型：**PATCH · 工程化治理**。把"产出物管理"作为独立交付物落地：中心化登记册、发布日志、演进路线图、CI 门禁、健康度聚合指令。

### 新增（Added）
- **产出物管理三件套**：`DELIVERABLES.md`（中心化产出物登记册，含项目元信息 / 验收基线 / 分层登记 / 证据链可追溯 / 发布门禁）、本文件 `CHANGELOG.md`、`ROADMAP.md`（P0–P5 受管理工作流）。
- **CI 验收门禁**：`.github/workflows/ci.yml`，push 时自动复跑离线验收脚本（`project:status`），任一阻断门禁失败即 CI 红。
- **`project:status` 指令**：`package.json` 新增脚本，聚合全部离线验收门禁为"产出物健康度"报告（9/9 阻断门禁 + 1 信息项），退出码反映健康度，可供 CI 与本地使用。
- `scripts/project-status.ts`：零依赖聚合器（直接调用 `node --test` 绕过 npm 对 `test` 生命周期脚本的嵌套限制）。

### 变更（Changed）
- `package.json` 版本 2.0.0 → **2.0.1**。
- `DELIVERABLES.md` §7 最新版本更新为 v2.0.1。

### 验证（Verification）
- `npm run project:status` → 阻断门禁 **9/9 通过**（test 96 · verify 23 · policy 19 · rsi 22 · meta 25 · benchmark 21 · external 38 · preflight 37 · live:smoke 17），信息项 free:probe 5 家可达。

---

## [2.0.0] — 2026-11-07 · 工程化产出物管理基线

> 类型：**MINOR 能力域 + 工程化治理**。首个纳入正式版本控制与产出物管理的基线。

### 新增（Added）
- **版本控制**：初始化 git 仓库，`.gitignore` 隔离运行时产物（`node_modules/`、`data/sessions/`、`data/workspace/`、`*.gguf`、本地密钥等），初始提交打 `v2.0.0` tag。
- **免费 LLM API 接入**：`agentos.config.json` 新增 `openrouter` / `nvidia-nim` / `siliconflow` / `deepseek` / `groq` 五个 OpenAI 兼容 provider；`src/index.ts` 改为遍历配置装载 provider（修复此前仅硬编码 openai/ollama 的真实缺陷）。
- **免费 API 探针**：`examples/free-api-probe.ts` + `npm run free:probe`，沙箱实测 5 家全部网络可达、正确报告缺 Key。
- **对比式改进（HARNESS² Propose–Probe–Compose）**：`src/rsi/contrast.ts` + `tests/contrast.test.ts`（9 项），无真值标签即可判定改动是否修复具体失败模式，天然防 reward hacking。
- **文档**：`docs/FREE-LLM-APIS.md`（免费 API 实测可达性/限速/一条命令跑真模型）、`docs/RSI-NEXT.md`（对齐 HARNESS²/Evo²/RRSI/OO-Harness 的 P0–P5 映射）。

### 变更（Changed）
- `src/index.ts`：provider 装载由"硬编码 openai/ollama"改为"遍历配置中所有 `type: openai` 条目"，使新增免费 provider 无需改代码即可生效。
- 文档体系同步到"87→96 测试、真实分数、verdict=not-proven"状态（README/DESIGN/EVAL/RSI/BENCHMARK/ITERATIONS/docs/INDEX）。

### 修复（Fixed）
- **真实缺陷**：`createAgentOS` 未装载配置中新增的 provider，导致免费 API 仅"写在配置里、跑不起来"。现遍历配置装载，可被测试套件覆盖。

### 验证（Verification）
| 门禁 | 结果 |
| --- | --- |
| `npm test` | **96 / 96 PASS**（87 + 新增 9 项 contrast） |
| `verify` / `policy:check` | 22 / 19 PASS |
| `rsi:check` / `meta:check` | 22 / 25 PASS |
| `benchmark:check` / `external:check` | 21 / 38 PASS |
| `preflight:check` / `live:smoke` / `free:probe` | 37 / 17 / 5 家可达 |
| `eval`（确定性） | overall **1.0**，19/19，协议违规 0 |
| `eval:live`（本地 qwen2.5:0.5b） | overall **0.0%**（0/12），协议违规 0 |

### 严格边界（Honest Boundaries）
- `leadership.verdict = not-proven`：内部 ablation 是可证伪内部对照，非行业领先证明。
- 证据阶梯 L4 = `not-achieved`：`data/benchmark/external-results.json` 从未被编造。
- 确定性报告（`eval-report.json`, overall=1）与真实报告（`eval-live-report.json`, overall=0）证据面隔离。

### 后续里程碑（指针）
- **P0**（下一优先）：免费 API 跑真实强模型 `eval:live`，拿第一份有效真实分数 → 见 [ROADMAP.md](./ROADMAP.md) P0。
- **P1–P5**：对比式接入 live RSI / 经验库 / RRSI 正则+OOD / OO-Harness 类族 / 公开基准对齐。

---

## [1.x] — 演进前史（未纳入版本控制）

> 本阶段（轮 0–6）完成了可运行内核、有界 RSI、元 RSI、基准体系、本地真实推理基础设施（llama.cpp + preflight 门禁），并跑出第一份真实分数。
> 因当时未初始化 git，仅以文件形式存在；其全部产物已被本 `v2.0.0` 基线一次性纳入版本控制。
> 关键历史证据保留于：`data/first-real-live-report.json`（真实 0/12）、`data/evolve-report.json`、`data/meta-report.json`、`data/benchmark-report.json`、`ITERATIONS.md`。
