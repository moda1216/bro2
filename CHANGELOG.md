# bro2 · 发布日志（CHANGELOG）

> 语义化版本 `MAJOR.MINOR.PATCH`：
> - **MAJOR**：破坏性架构变更（接口/契约不兼容，需迁移）。
> - **MINOR**：新增能力域或重大特性（向后兼容）。
> - **PATCH**：修复、证据更新、文档/验收脚本补齐（向后兼容）。
>
> 发布动作（强制）：feature 完成 → `npm run project:status` 全绿 → `git tag -a vX.Y.Z` → 追加本条目 → 同步 [DELIVERABLES.md](./DELIVERABLES.md) §3 状态。
> 产出物管理三件套：`DELIVERABLES.md`（登记册）· `CHANGELOG.md`（本文件）· `ROADMAP.md`（演进）。

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
