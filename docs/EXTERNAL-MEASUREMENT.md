# bro2 · 走出去测量：k=3 硬化 + 跨模型复刻尝试（v2.28.0 / P0-04）

> **性质**：联网实验 + 自跑内部对照。**不产生榜单分数、不提升 L4、不改 `leadership.verdict`、不写 `data/benchmark/external-results.json`**。
> 配套产物：[`data/bench/external/`](../data/bench/external/) 下的 `UPSTREAM.json` / `tasks.jsonl` / `SHA256SUMS` / `external-measure-report.json` / `bro2-eval-report.json`。
> 可复现入口：[`examples/fetch-external-tasks.sh`](../examples/fetch-external-tasks.sh) · [`examples/tb-verifier.Dockerfile`](../examples/tb-verifier.Dockerfile) · [`examples/external-measure.ts`](../examples/external-measure.ts)。
> 本文是 [`CAPABILITY-POSITION.md`](./CAPABILITY-POSITION.md) §4「走上去量一次」的执行记录，不是它的翻案。

---

## 0. 一句话

bro2 从「**外部未测量**」走到「**在公开任务 + 公开评分器 + 真实模型端点上被判分**」，并在 v2.28.0 把 v2.27.0 的 **k=1 单发快照硬化为 k=3 通过率**，同时尝试第二个模型族（ovhcloud / gpt-oss-120b）做跨模型复刻。
条件一直都在，缺的是把它们接起来——不是「没 GPU / 没 Key / 没外部基准」，而是这三条通道从未被启用。

---

## 1. 被误判为「无条件」的三件事，实测全部具备

上一版诊断把「零 Key 沙箱只能做协议接入验证」写进诚实边界，这在**当时的接线状态**下是对的；但把「接不上」当成「没有」，是这轮要纠正的判断。逐一实测：

| 条件 | 上一版表述 | 本轮实测 | 复现命令 |
| --- | --- | --- | --- |
| 公开任务集 | 「需外部基准数据」（L4 gap 归因） | `git` 可直连 GitHub；按固定 commit 取到 Terminal-Bench `original-tasks` 的 instruction / 输入 / 官方解 / `tests/test_outputs.py`，Apache-2.0 | `sh examples/fetch-external-tasks.sh`（`SHA256SUMS` 校验） |
| 可工具调用的模型端点 | 「需 API Key」是 P0-02 硬门槛 | 项目内早有 `kilo` 免 Key 匿名端点，`npm run preflight` **PASS**：HTTP 200、SSE 流式、**原生 `tool_calls`** | `AGENTOS_LIVE_PROVIDER=kilo npm run preflight` |
| 公开评分器执行环境 | 「自建基准需 13 周依赖链」 | Docker 27.5.1 可用；`python:3.11-slim + pytest==8.3.3` 统一镜像，按上游硬编码的 `/app` 语义跑公开 pytest | `docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile` |

> **关键修正**：`CAPABILITY-POSITION.md §4.1` 说「第一组真实对照数必须有可工具调用的模型端点参与，这是硬门槛」。
> 本轮确认**该门槛在本沙箱内已满足**——门槛不是资源问题，是「没有去接」。
> 这不否定上一版的防自指纪律（确定性 mock 确实量不出 harness Δ），只是否定「因此做不了」的结论。

**不搬运 benchmark 数据**：`data/bench/external/upstream/` 已 gitignore，仓库只分发上游坐标（repo + 40 位 commit + 许可 + 检索日期）与逐文件 SHA256。上游 canary 语料、任务原文、评分器代码都不入库。

---

## 2. 测了什么：同一把尺子上的两个 arm

三个任务取自 `laude-institute/terminal-bench @ d28711d0`（`original-tasks`，均为 easy，verifier 只用 Python 标准库 + pytest）：

| 任务 | 产出物 | 评分器断言 |
| --- | --- | --- |
| `analyze-access-logs` | `report.txt` | 2000 条请求 / 273 个 IP / Top3 URL / 83 个 404，格式逐行校验 |
| `bank-trans-filter` | `data/output.json` | 模糊匹配公司名与账号（含 typo），9 行按日期升序，与 `EXPECTED` 全等 |
| `assign-seats` | `results.txt` | 解码 pickle/base64 偏好后求 CSP，答案集合 `alice, bob` / `alice, ethan` |

**严格共用的对照前提**（`Model + Harness = Agent`，只换 harness）：

| 维度 | bro2 arm | minimal arm |
| --- | --- | --- |
| 模型 / 端点 | `kilo-auto/free` @ `api.kilo.ai` | 同左（同一份 `agentos.config.json` 配置） |
| 任务 / 输入文件 | 同一 3 题、同一上游输入 | 同左 |
| 最大模型调用数 | 12 | 12 |
| 评分器 | 上游公开 `test_outputs.py`，同一 Docker 镜像、同一 `/app` 挂载语义 | 同左 |
| 路径适配说明 | 同一段显式标注的 `[harness adapter]` 文本 | 同左 |
| harness | 完整：治理 / 上下文 / 工具调度 / 轨迹 / 预算 / RSI | **单 `shell` 工具 + 线性历史**，无治理层 |

- bro2 走 `runEval({ mode: "live", strict: true })`，**禁止降级到 Mock**，用 `prepareWorkspace` 铺公开输入、`verifyWorkspace` 跑公开 verifier；
- minimal 直接调 `OpenAICompatProvider.complete()`，只给一个 `shell` 工具，是 mini-swe-agent 式的最小 scaffold；
- **评分器 agent 不可见**：verifier 只在独立 Docker 容器里执行，不进工作区、不进 prompt；
- **指令不篡改**：`parseInstruction()` 从上游 `task.yaml` 原样提取 `instruction: |-` 块；`/app/...` → 相对路径的适配单独标注为「环境说明，非公开任务原文」，两个 arm 完全一致。

主指标是**公开 verifier 判定**（`verifierPassed`），不是自建 `expectedAnswer` 断言。bro2 的 `EvalReport` 另存供复核，其 `evalOk` 还包含框架层的「终答非空 / 协议违规」断言，两者在报告里分开记录。

---

## 3. 防「空转仪表盘」：评分器先过双向反证

在放模型进来之前，每个评分器必须通过两项反证，否则整个测量直接中止、不出报告：

1. **空工作区** → 必须 **fail**（证明评分器不是恒真）；
2. **上游官方 `solution.sh`** → 必须 **pass**（证明评分器接线与 `/app` 语义正确）；
3. 评分器文件 SHA256 必须与 `SHA256SUMS` / `tasks.jsonl` 一致（证明没被本地改过）。

三项任务的实测结果全部 `sound=true`（`external-measure-report.json → verifierSanity`）。这一步是上一版「确定性 mock 回放量不出 Δ」教训的直接落地：**先证明尺子会动，再谈分数**。

---

## 4. 结果（2026-11-11 实测，k=3，双端点）

评分器三项 `sound=true` 后，真实模型在每个端点各跑两个 arm、每题重复 **3 次**（共 9 次/arm）。主指标取公开 verifier 判定，按**通过率**而非单发通过报告：

**端点 kilo（kilo-auto/free，主端点，k=3）**

| 任务 | bro2 (通过/9) | minimal (通过/9) | Δ |
| --- | --- | --- | --- |
| `analyze-access-logs` | 3/3 | 2/3 | +1 |
| `bank-trans-filter` | 3/3 | 0/3 | **+3** |
| `assign-seats` | 0/3 | 0/3 | 0 |
| **合计** | **6/9（0.67）** | **2/9（0.22）** | **+4** |

**端点 ovhcloud（gpt-oss-120b，跨模型 holdout 尝试，k=3）**

| 任务 | bro2 (通过/9) | minimal (通过/9) | Δ |
| --- | --- | --- | --- |
| `analyze-access-logs` | 0/3 | 0/3 | 0 |
| `bank-trans-filter` | 1/3 | 0/3 | +1 |
| `assign-seats` | 0/3 | 0/3 | 0 |
| **合计** | **1/9（0.11）** | **0/9（0.00）** | **+1** |

关键读数：

- 这是 `kilo-auto/free` 与 `ovhcloud/gpt-oss-120b` 真实模型 + 上游公开 pytest 的端到端判分，**不是 mock 脚本回放**；bro2 侧 `strict=true` 禁止降级到 Mock。
- **k=3 把 v2.27.0 的「2/3 vs 1/3、Δ=+1」单发快照，升级为可辩护的通过率**：bro2 0.67 vs minimal 0.22，Δ=+4（约 +0.44 通过率差）。单发「通过」常含运气（v2.27.0 里 `bank-trans-filter` 单发算 pass，k=3 下它多次命中 12 步上限 `guard ≠ completed`），重复后信号反而更稳、更强。
- **`bank-trans-filter` 是 harness 增益最干净的证据**：bro2 3/3 vs minimal 0/3。该任务需模糊匹配公司名/账号（含 typo）并按日期排序——minimal 的「单 shell 工具 + 线性历史」几乎从不出正确 JSON，bro2 的完整 harness（上下文/工具调度/治理）稳定产出。
- **`assign-seats` 双方 0/3 是真实能力缺口**，不是 harness 问题：公开「解码 pickle/base64 偏好 + CSP」对当前模型+harness 组合仍过难，bro2 反复多写错误邻居对。结果**不是「bro2 全胜」**。
- **ovhcloud 段整体被 `provider_error` 拖垮**（agent 几乎没产出文件，verifier 报 `FileNotFoundError`），是**无效对照**而非「Δ 消失」——两个端点的 Δ 都 ≥ 0，但未触发 [`CAPABILITY-POSITION.md §4.2`](./CAPABILITY-POSITION.md) 的降级（降级条件是 Δ≤0 或 holdout 模型上 Δ 消失；这里 holdout 端点本身驱动失败，复刻**未完成**）。
- 报告同时记录 bro2 的 `evalOk`（含框架层「终答非空 / 协议违规」断言）与纯 `verifierPassed`，未用自建断言替代公开评分。

---

## 5. 诚实边界（与报告 `honest` 字段逐条对应）

- **bro2 自跑、非第三方复核、仅内部对照**，不构成公开榜单成绩；
- `k=3`、3 个 easy 任务、免费匿名端点 `kilo-auto/free`（能力与限流不稳定）；第二个端点 `ovhcloud/gpt-oss-120b` 作为跨模型 holdout 尝试，但被 `provider_error` 拖垮、未构成有效对照；
- 任务取自 `original-tasks`，**非官方 core 子集、非榜单口径**，不能与 Terminal-Bench 榜单数字并列；
- 结果是 **Model + Harness 端到端产物**：既不证明模型能力，也不证明 harness 的通用增益；
- **未写 `data/benchmark/external-results.json`**（报告记录该文件前后指纹），**不改 L4 / `leadership.verdict`**（仍 `not-achieved` / `not-proven`）；
- minimal arm 是自实现的最小 scaffold，**不是** `mini-swe-agent` / `Terminus-2`，因此**不等于** Harbor 锁定 harness 的第三方可复核对照；
- 若 **Δ ≤ 0**，或换 holdout 模型后 Δ 消失，按 [`CAPABILITY-POSITION.md §4.2`](./CAPABILITY-POSITION.md) 降级定位为「可验证 RSI 研究台」，停止在能力比较上投入。

---

## 6. 对定位与 ROI 的实际改变

| 之前 | 之后 |
| --- | --- |
| L4 `not-achieved`、外部证据 0 条、`not-measured` | L4 **仍** `not-achieved`、外部证据 **仍** 0 条，但**有了第一组在公开任务 + 公开评分器 + 真实模型下的自跑测量**（k=1 → k=3 硬化） |
| 「同模型对照」被依赖链压在末尾、执行度零 | 有了一条可立即复跑的命令，和一把**能判通过也能判失败**的公开尺子 |
| 单发 2/3 vs 1/3、Δ=+1（33pp/题，无统计意义） | **k=3 通过率 0.67 vs 0.22、Δ=+4**，单发运气被消解，`bank-trans-filter` 暴露为 harness 增益最干净的证据 |
| 任何 harness 改动的 Δ 都不可测 | 建立了「同模型 / 同任务 / 同预算 / 同评分器 / k≥3」的对照框架，后续 Context 紧窗口压缩（P1）等改动可在同一框架下量 Δ |
| 改进方向靠外部文献推断 | 有了内部可证伪增益的测量端点，`ROI ≈ 外部可证伪增益 Δ ÷ 实现成本` 的分母分子都落到了可执行实验上 |

**仍未完成的**：`P0-01` Harbor 装载 bro2 为自定义 agent、与 `mini-swe-agent`/`Terminus-2` 的第三方可复核对照、**跨 holdout 模型的有效复测**（ovhcloud 被 `provider_error` 拖垮，需换一个能在完整 harness 下稳定驱动工具调用的第二端点）、扩任务集（仍为 3 个 easy）、长程任务子集。这些是下一步，不是本轮成果。

---

## 7. 复现命令

```bash
# 1) 取公开任务（固定 commit + SHA256 校验；无需 Key / GPU）
sh examples/fetch-external-tasks.sh

# 2) 构建固定评分器镜像（python:3.11-slim + pytest==8.3.3）
docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile

# 3) 端点门禁（应 PASS，且 toolCalling=native）
AGENTOS_LIVE_PROVIDER=kilo npm run preflight

# 4) 跑测量（评分器健全性 → bro2 live → minimal 基线 → 报告）
AGENTOS_LIVE_PROVIDER=kilo npm run external:measure

# 5) 离线契约复核
node --experimental-strip-types --no-warnings --test tests/external-measure.test.ts
```

产物：`data/bench/external/external-measure-report.json`（对照与诚实声明）、`bro2-eval-report.json`（bro2 完整评测明细）。
