# bro2 · 真机接管手册（从内部证据走向外部证据）

> 本手册回答：如何把 `leadership.verdict = not-proven` 里的缺口逐条补齐。
> 沙箱无 GPU / API Key，且 GitHub Release 出口受限装不上 Ollama 二进制；本轮已用**路线 B**（llama.cpp + Ollama 官方权重，见 [docs/LOCAL-LLM.md](./LOCAL-LLM.md)）在沙箱内跑出第一份真实分数。
> 跨 provider 矩阵与公开基准仍需在真机完成；bro2 已把链路、能力探针、接入门禁、外部结果校验器与报告格式全部备好，本手册给出可复制的操作序列。
>
> 相关：[BENCHMARK.md](../BENCHMARK.md)（判据）· [EVAL.md](../EVAL.md)（指标口径）· [docs/API.md](./API.md)（接口）· [docs/INDEX.md](./INDEX.md)（全部文档）

---

## 0. 先确认沙箱基线

```bash
cd /workspace/agent-os          # 或软链 /workspace/bro2
npm test                        # 87/87
npm run eval                    # 19/19，门禁 PASS，协议违规 0
npm run benchmark               # L0–L2 achieved / L3 partial / L4 not-achieved
npm run external:check          # 38/38，外部证据通道防伪造实证
npm run preflight:check         # 37/37，接入门禁防误判实证
npm run live:smoke              # 17/17，live 全链路自检（不是模型能力分数）
```

当前 `data/benchmark-report.json` → `leadership.verdict = not-proven`。**这是设计，不是待修的 bug**：内部满分不能证明外部比较命题，程序也不会因为导入一份文件就自动宣布领先。

---

## 1. 拿第一份真实分数

### 1.0 环境实测：轮 6 的「拿不到」与轮 7 的路线 B

在本沙箱做了真实环境探测，结论如下（可复现：`npm run doctor` / `npm run preflight`）：

| 探测项 | 实测结果 | 含义 |
| --- | --- | --- |
| `OPENAI_API_KEY` 等凭据 | 不存在 | 无法调用任何云端模型 |
| 本地 `127.0.0.1:11434` | 连接失败 | 无 Ollama / vLLM / LM Studio |
| `api.deepseek.com/v1/models` | **HTTP 401** | **网络可达**，标准 OpenAI 兼容认证错误，只缺 Key |
| `dashscope.aliyuncs.com/.../models` | **HTTP 401** | 同上，国内端点通 |
| `api.openai.com` / `google.com` | 超时 | 该出口不可达 |

所以这里**不存在「写一份结果让 L4 升级」的可信做法**——那正是本项目全程防范的 self-confirming loop。轮 6 先把「除模型权重外的每一环」做成机器可判定的基础设施；**轮 7 用户允许部署本地服务后，改用 [docs/LOCAL-LLM.md](./LOCAL-LLM.md) 的路线 B 拿到第一份真实分数 `0.0%`（0/12）**，见 §1.4。轮 6 打通的基础设施：

- **认证分级诊断**：`probe()` 现在区分「网络不可达」与「端点可达但 401/403 认证被拒」。旧实现把两者都报成「不可达」，会把「Key 错」误导成「服务没起」。
- **`preflight` 门禁**：把「能不能开跑 live 评测」压缩成一个布尔值 + 退出码，可直接放进 CI 的 `&&` 链。
- **live 报告隔离**：`eval:live` 不再覆盖 `data/eval-report.json`。
- **live 链路自检**：用进程外真实 HTTP/SSE 端点跑通 `runEval(mode=live)` 全链路，产出 `data/live-link-smoke.json`（**明确标注非模型能力分数**）。

### 1.1 配置端点

**本地 Ollama（免 API Key）**

```bash
ollama serve
ollama pull qwen3:8b                                   # 必须选带 tool-use 训练的模型
export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"    # /v1 前缀别漏
export OLLAMA_MODEL="qwen3:8b"
export AGENTOS_LIVE_PROVIDER="ollama"
```

**云端 / 任意 OpenAI 兼容端点**

```bash
export OPENAI_BASE_URL="https://api.deepseek.com/v1"
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="deepseek-chat"
export AGENTOS_LIVE_PROVIDER="openai"
```

所有端点共用 `OpenAICompatProvider`，内核不感知差异。`AGENTOS_LIVE_PROVIDER` 决定 live 评测与 preflight 检查哪个 provider（缺省 `ollama`）；也可显式传 `--provider openai`。配置在 `agentos.config.json`，`${ENV_VAR}` 占位符由环境变量解析；密钥只从环境变量读并做日志脱敏。本地地址（`localhost` / `127.0.0.1` / `::1`）自动免认证。

**路线 B · 装不上 Ollama 二进制时（本沙箱实测）**

```bash
# GitHub Release 出口受限时，用 llama.cpp + Ollama 官方 registry 权重起等价端点
# 完整命令、权重校验、cgroup 坑见 docs/LOCAL-LLM.md
LOCAL_MAX_TOKENS=128 python3 tools/local-llm-server.py --threads 4 \
  --model /root/.cache/bro2-llm/qwen2.5-0.5b.gguf --model-id qwen2.5:0.5b \
  --stats-file data/local-llm-stats.json
```

`--threads` 必须对齐 `cat /sys/fs/cgroup/cpu.max` 的真实配额（本沙箱 4 核）；`nproc` 报的是宿主机核数，超订阅会触发 cgroup 限流，把单次推理从秒级拖到几十秒。端点同样免认证、同样要过 `preflight` 六项门禁。

### 1.2 两级诊断，别跳过

```bash
npm run doctor       # 面向人：端点 / 模型清单 / network / auth / SSE / toolCalling，永远 EXIT=0
npm run preflight    # 面向机器：ready=true → EXIT=0；否则 EXIT=1，禁止开跑
npm run preflight -- --provider openai --json    # CI 可解析；--all 检查全部 provider
```

`preflight` 的六项硬检查：配置完整 · 端点可达 · 认证通过 · 模型可用 · SSE 流式 · **原生 `tool_calls`**。

| 判定 | 含义 | 处理 |
| --- | --- | --- |
| `ready=PASS` | 六项全过 | 可以开跑 `eval:live` |
| `networkReachable=false` | 端点没起 / `/v1` 前缀漏了 / 端口错 | 检查 `ollama serve` 与 baseUrl，**别去改 Key** |
| `authRejected=true`（HTTP 401/403） | 端点通、认证失败 | **修正 API Key**（值 / 有效期 / 模型权限），别去查网络 |
| `toolCalling=text-json` | 把工具调用写进正文 | **换模型**：Agent Loop 因零 `tool_calls` 直接终答，任务静默失败且不报错 |
| `toolCalling=unsupported` | 完全不响应工具 | 换模型 |
| 模型不在 `/v1/models` 清单 | 模型名写错 | 用清单里的 id 设 `OLLAMA_MODEL` / `OPENAI_MODEL` |

另需在 Modelfile 里设 `num_ctx`（OpenAI 兼容 API 没有上下文窗口字段），长会话评测前先调大，否则被截断。

### 1.3 沙箱内先跑链路自检（不是能力分数）

```bash
npm run live:smoke
```

它会启动 `examples/ollama-bridge.ts`（进程外真实 HTTP/SSE 服务），先过 `preflight`，再跑 `runEval(mode=live)`：单任务闭环判分 + 完整 19 任务集稳定性。产物 `data/live-link-smoke.json` 里写死了 `isModelCapabilityScore: false` 与 `endpointKind: simulated-local-bridge`。

> **这份报告只证明链路可用，不证明模型聪明。** 端点返回脚本化响应，完整任务集分数低是预期结果；它绝不写入 `external-results.json`、不进证据阶梯 L4、不改 `verdict`。其价值是把「文档说 live 能跑」变成「实测跑通」：真机上换掉 baseUrl，同一条命令即得真分数。

### 1.4 真机上跑 live 评测（这才是第一份真实分数）

```bash
npm run preflight && npm run eval:live
# 或指定 provider / 重复次数
AGENTOS_LIVE_PROVIDER=openai npm run eval:live -- --k 3 --json > live.json
```

`eval:live` **内置 preflight 门禁**：端点未就绪时明确拒绝开跑并 `EXIT=1`，不会产出一份会被误读成「能力差」的低分报告（确需跳过用 `--skip-preflight`，不建议）。`strict` 保证端点失败时明确报错，绝不降级到 Mock 伪造成功。

**报告落在 `data/eval-live-report.json`**，与确定性报告 `data/eval-report.json` 完全隔离。判分不只看终答：期望工具集、终答关键词、生成文件、停止原因、Guard / 压缩 / 审批、协议违规零容忍，详见 [EVAL.md §1.3](../EVAL.md)。

**第一份真实分数（轮 7 沙箱实测，路线 B）**：本地真实推理服务（`llama.cpp` 0.3.36 + Ollama 官方 registry 权重 qwen2.5:0.5b，CPU 4 核、`--threads 4`）过 `preflight` 六项门禁后执行 `eval:live`：

| 指标 | 实测值 |
| --- | --- |
| 总体得分 / pass@k | **0.0% / 0.0%** |
| 通过任务 | **0 / 12** |
| 门禁 | **FAIL**（9 条阈值） |
| 协议违规 / 工具错误率 / Guard | **0 / 0.0% / 0.0%** |
| 平均步数 / 工具调用 | 1 / 0 |
| 服务端真实推理 | 18 次请求、35446 prompt tokens、`errors=0` |

0 分是真实的，但只代表这个 0.5B CPU 单模型配置：模型不发起工具调用直接终答。**协议违规 0 说明 Harness 链路正常**，因此不能把 0 分归因到框架；也不能拿它宣布或否定「领先」。`verdict` 仍 `not-proven`、L4 仍 `not-achieved`。边界见 [docs/LOCAL-LLM.md §5](./LOCAL-LLM.md)。

### 1.5 报告隔离（为什么重要）

| 报告 | 由谁写 | 用途 |
| --- | --- | --- |
| `data/eval-report.json` | 仅 `eval --mode deterministic` | L1 证据 + 回归基线唯一来源，`ladder.ts` 读它 |
| `data/eval-live-report.json` | 仅 `eval --mode live`（真机） | 第一份真实模型分数 |
| `data/live-link-smoke.json` | 仅 `live:smoke` | 链路自检，标注非能力分数 |
| `data/benchmark/external-results.json` | **只能由你手工导入实测值** | 唯一的外部证据入口，须通过校验 |

旧实现里 live 会覆盖 `data/eval-report.json`，一次失败的 live 尝试就会把 L1 从 `achieved` 打回 `partial` 并抹掉确定性证据。本轮已修复，`preflight:check` 对此有断言。

---

## 2. 跨 provider 对比矩阵（≥3 个模型）

同一任务集、同一预算、重复 k 次，逐个切换 `AGENTOS_LIVE_PROVIDER`：

```bash
for m in ollama openai openai-alt; do
  AGENTOS_LIVE_PROVIDER=$m npm run eval:live -- --k 3 --json > "data/live-$m.json"
done
```

建议至少 3 列：本地 Ollama + 2 个云端（不同厂商 / 不同规模）。记录模板：

| provider | 模型与版本 | overall | pass@3 | 协议违规 | 平均步数 | token | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |

**怎么判读**：
- 某项只在某一个模型掉分 → 模型 / 提示词问题；
- 所有模型都掉同一项 → 框架问题，回到 Harness 修；
- 改动前后用同一矩阵复验，才能把增益归因到框架而不是模型波动。

这一步是证据阶梯 L3 从 `partial` 往前走的必要条件之一。

---

## 3. 公开基准对齐

把 BFCL（函数调用）/ τ-bench（多轮状态一致）/ GAIA（多步检索）/ SWE-bench 类（代码修复）的任务转成 bro2 的 `EvalTask` 格式，用 `runEval` 跑分。`BENCHMARK_FAMILIES` 已把内部 6 个分类映射到这些基准族，便于对齐口径 —— **这只是分类映射，不冒充已跑过这些基准**。

两条路径：

1. **转成 EvalTask 直接跑**：写成 JSONL 任务集，`npm run eval -- --tasks <path> --mode live --k 3`。优点是判分逻辑与内部评测完全一致。
2. **外部评分脚本出分后导入**：把结果写进 `data/benchmark/external-results.json`（见 §4）。适用于基准自带评分器、无法嵌入 bro2 循环的情况。

无论哪条路径，都需要**与同期开源 harness 在同一任务、同一模型、同一预算下对照**，并给出多次重复的方差 / 置信区间。

---

## 4. 导入外部基准结果（严格校验）

### 4.1 唯一认可的输入通道

```
data/benchmark/external-results.json      ← 只认这一个文件，且必须通过校验
```

`data/benchmark-report.json` 是 bro2 自己生成的**内部产物**，手塞 `external` 字段不会被计入。校验器 `src/benchmark/external.ts` 与评分面 `scoring.ts`、阶梯 `ladder.ts` 同在写保护面内，RSI / meta 候选不得修改。

### 4.2 字段表

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `benchmark` | ✅ | 非空字符串，含基准名与版本 |
| `model` | ✅ | 非空字符串，含模型名与版本 |
| `date` | ✅ | `YYYY-MM-DD` 真实日历日期，**不得晚于今天** |
| `score` | ✅ | `[0,1]` 内有限数值（用小数，不是百分制） |
| `metric` | ✅ | 非空字符串，指标口径名 |
| `reproducibleCommand` | ✅ | 非空可执行命令；`N/A` / `TODO` / `见文档` 等占位符一律拒绝 |
| `harness` | — | 非空字符串 |
| `tasks` / `repeat` | — | 正整数 |
| `confidenceInterval` | — | `[lo,hi]`，两端 ∈ `[0,1]` 且 `lo ≤ hi` |
| `notes` | — | 字符串 |

**三条硬拒绝**：

1. **未知字段**：字段必须严格落在上表白名单内，夹带任何额外字段即拒；
2. **自带结论**：`verdict` / `proven` / `leading` / `winner` / `rank` / `claim` 等结论类字段不得由数据源携带 —— 结论只能由证据阶梯给出；
3. **格式不完整**：缺必填、类型错、越界、未来日期、非法 JSON、顶层不是 `{ results: [...] }`。

> **不要直接落盘任何示例数值。** [BENCHMARK.md §4](../BENCHMARK.md) 里的 JSON 只是格式示意，其中分数、日期、命令必须全部替换成你的真机实测值。往仓库里塞一份看似合法的假结果，正是本项目全程防范的 self-confirming loop。

### 4.3 查看校验结果

```bash
npm run benchmark                 # 重新生成报告
npm run external:check            # 38 项防伪造实证（只在临时目录写文件）
```

`data/benchmark-report.json` → `ladder.externalValidation` 会逐条给出：

```text
source / submitted / accepted / rejected[{index, reason}] / fileErrors / benchmarks[]
```

被拒记录**不会连坐**其它合法记录，但会完整留在 `rejected` 里供复核。命令行报告的「【外部证据校验】」段同样会打印每一条拒绝原因。

### 4.4 导入后会发生什么

| 变化 | 结果 |
| --- | --- |
| L4 状态 | `not-achieved` → **`partial`**（仅在至少 1 条记录通过校验时） |
| `leadership.verdict` | **仍是 `not-proven`**，程序绝不自动宣布领先 |
| `externalBenchmarksImported` | = 通过校验的条数（不是提交条数） |
| L4 缺口 | 明确写出仍需模型版本 / 评分脚本、同期 harness 对照、第三方独立复核 |

要从 `partial` 走到「已证明」，需要的是**外部对照数据与第三方复现**，不是再写一份文件。这一步必须由人显式给出结论。

---

## 5. 诚实边界（复述一遍，避免误读）

- **Mock 的 100% 不是能力**：确定性模式固定模型输出，测的是框架；真实能力只能由 `eval --mode live` 测量。轮 7 实测 `100% → 0.0%` 的落差正是这一条的实证。
- **单点真实分数不是外部比较证据**：0/12 只覆盖 1 个 0.5B CPU 模型 + 内部任务集，不能外推、不能升级 L4、不改 `verdict`。
- **`live:smoke` 不是真实分数**：进程外 HTTP 端点返回脚本化响应，只证明链路可用。
- **路线 B 不是 Ollama 二进制**：llama.cpp 提供等价契约；工具调用经 `chatml-function-calling` 协议适配，流式为 buffered-sse；CPU-only / 单模型 / 0.5B / 4 核配额，分数不可外推，也不改 `verdict`。
- **ablation 是内部对照**：任务集自建、样本 10 个、无置信区间，不能外推到通用任务分布。
- **格式可信 ≠ 结论成立**：校验器只判断外部结果「格式是否可信」，不判断分数是否真的胜过同期 harness。
- **沙箱是应用层路径白名单**，非 OS 级隔离；`--experimental-strip-types` 只擦除类型、不做类型检查。
- 真上生产的底座 Go / Rust 更稳，本项目定位是「可读、可改、与设计逐条对应」的内核。

---

## 6. 最小复现清单

```bash
# 沙箱内（无需任何外部资源）
npm test && npm run verify && npm run eval \
  && npm run evolve && npm run meta && npm run benchmark \
  && npm run external:check && npm run preflight:check && npm run live:smoke

# 沙箱内（路线 B：先按 docs/LOCAL-LLM.md 起本地真实推理服务）
npm run preflight && npm run eval:live        # 第一份真实分数

# 你的机器上（补齐外部证据）
npm run doctor
npm run preflight                       # ready=PASS 才继续
npm run eval:live                       # 第一份真实分数 → data/eval-live-report.json
# 切换 ≥3 个 provider 重跑，填对比矩阵
# 跑公开基准，把实测结果写入 data/benchmark/external-results.json
npm run benchmark                      # 看 ladder.externalValidation 与 L4
```

完整命令速查见 [docs/INDEX.md §3](./INDEX.md)；领先判据与可证伪条件见 [BENCHMARK.md](../BENCHMARK.md)。
