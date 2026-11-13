# bro2 · 轨迹层面能力画像：bro2 vs 公开 agent 轨迹数据（策略 B，v2.30.0）

> **性质**：联网实验 + 自跑内部轨迹采集 + 公开轨迹统计对照。**不构成榜单分数、不提升 L4、不改 `leadership.verdict`、不写 `data/benchmark/external-results.json`**。
> 配套产物：[`data/bench/external/tb-leaderboard-compare-report.json`](../data/bench/external/tb-leaderboard-compare-report.json)（含 bro2 每题 `traj` 指标）、[`data/bench/external/tb-leaderboard-compare-kilo.json`](../data/bench/external/tb-leaderboard-compare-kilo.json)。
> 本文件是 [`CAPABILITY-POSITION.md`](./CAPABILITY-POSITION.md) §4「走上去量一次」的**策略 B 执行记录**：用户方向是「不等第三方来填对照槽，直接抓其他 agent 的轨迹数据，靠轨迹差异判断 bro2 的能力」。

---

## 0. 一句话

用户给的两条路线里，A 是「找第三方已有公开成绩的任务集给 bro2 跑、直接对公开数字」（见 [`EXTERNAL-MEASUREMENT.md`](./EXTERNAL-MEASUREMENT.md) 与 `tb-leaderboard-compare` 报告）；本文件走 **B：轨迹层面能力画像**——把 bro2 在真实公开任务上的**步数 / 工具调用 / 停止行为 / 成功率**与公开 agent 轨迹统计对照，绕开「必须等第三方把我的输出拉去复跑」的死结。

结论先说：bro2 在 Terminal-Bench 样本上的轨迹画像暴露了一个**真实、可证伪的 harness 行为缺陷**——对解不出的任务不会优雅停手，而是空转多轮工具调用（失败题的工具调用数反而高于通过题）。这是能力/行为层面的有效信号，不是分数表演。

---

## 1. 为什么轨迹层面能独立提供信号

公开能力分数（pass@1）回答「做没做对」，但**不回答「怎么做、做得有多费、失败时长什么样」**。轨迹层面至少多给四件事：

| 维度 | 它揭示的 harness/agent 性质 | 分数看不出 |
| --- | --- | --- |
| 步数（steps） | 计划粒度、是否一次想清楚 | 同样 pass 可能是 4 步也可能是 40 步 |
| 工具调用数（tool calls） | 探索/试错强度、是否陷入重复 | pass 背后是精准还是穷举 |
| 停止行为（completed / guard / provider_error） | 是否有「验证—停手」闭环、是否会空转 | 分数掩盖了空转与超时 |
| 成功率 × 轨迹成本 | 单位成本的真实产出 | 高分可能来自无限重试 |

公开基准里这条轴是显式存在的：SWE-bench 各榜单把 **Avg. $ Trajs / Trajs**（每实例平均轨迹数）作为一级指标列出；第三方轨迹数据集（如 Toolathlon-Trajectories：17 个模型 × 3 次运行、5000+ 条真实工具调用轨迹）更是直接把「轨迹」当分析对象。

---

## 2. 可引用的公开轨迹参考点（截至 2026-11-12）

> 诚实说明：本沙箱 **HuggingFace 不可达（HTTP=000 超时）**，因此无法下载 Toolathlon-Trajectories 等轨迹数据集做逐条对齐。下面只用**公开榜单已发布的聚合统计**作参照轴，不做逐轨迹比对。

- **SWE-bench（mini-SWE-agent 口径）公开榜单**报告每实例平均轨迹成本 `Avg. $ Trajs`，头部 agent 约 `$0.07–$0.75`/已解实例（Claude/Gemini/GLM/GPT 系列），隐含每题多次轨迹尝试。
- 一份 2025 年 SWE-Agent 评测给出**每题轨迹数（Trajectories/Task）**的横向数据：SWE-Agent 2025 ≈ **20**、o1-preview ≈ **15**、Claude 3.5 ≈ **10**、GPT-4o ≈ **5**（5 seeds、每题 20 trajectories 设定下测得的通过率与效率）。
- 这些数字说明：**强 agent 的典型轨迹特征是「少量但高命中」或「多轨迹但受控重试」**，而不是「无终止条件的长链试错」。

> 跨基准家族警告：上述是 **SWE-bench（软件工程）** 轨迹统计，bro2 本批测的是 **Terminal-Bench（终端/bash）** 任务，题类不同、绝对数不可直接相减。本文件只取「轨迹效率/停止行为」这一**跨族可比的行为轴**，不把两个基准的分数混为一谈。

---

## 3. bro2 实测轨迹画像（Terminal-Bench 样本，kilo 主端点，K=1，4 题）

来源：`tb-leaderboard-compare-kilo.json → providers_detail[0].perTask[].traj`。每题 1 次 trial，公开 verifier 判定。

| 任务 | 结果 | 步数 | 工具调用 | 停止原因 |
| --- | --- | --- | --- | --- |
| `tb-analyze-access-logs` | ✅ pass | 10 | 9 | completed |
| `tb-constraints-scheduling` | ✅ pass | 4 | 5 | completed |
| `tb-bank-trans-filter` | ❌ fail | 7 | 14 | guard ≠ completed |
| `tb-assign-seats` | ❌ fail | 12 | 11 | guard ≠ completed |
| **合计** | **2/4 (0.50)** | **均值 8.25** | **均值 9.75** | — |

聚合：`passRate=0.50`，`avgSteps≈8.25`，`avgToolCalls≈9.75`。

---

## 4. 从轨迹差异读出的 broker 行为结论

对照 §2 的公开参照（强 agent 少而准 / 受控重试），bro2 本批轨迹呈现一个**明确、可证伪的 harness 行为特征**：

1. **失败题工具调用数高于通过题**：`bank-trans-filter` 14 次、`assign-seats` 11 次，均多于通过题的 9 / 5 次。即 bro2 对**解不出的题不会优雅停手**，而是继续多轮工具调用，最终撞上 `guard ≠ completed`（12 步/工具调用上限）才终止。
2. **无「验证—停手」闭环的证据**：通过题也是靠把事做对才停，而非「先自检再停」；失败题则空转到预算上限。公开强 agent 的常见行为是「写一段→跑测试→根据反馈收敛」，bro2 这里缺少把 verifier 信号接回决策的早期终止。
3. **这是 harness/行为层信号，不是纯模型信号**：同一 kilo 匿名弱模型下，bro2 仍能 2/4 通过（含 `constraints-scheduling` 仅 4 步/5 工具的干净解法），说明模型本身够用，瓶颈在「何时停、怎么从失败反馈里退出」。

> 这条结论**不依赖第三方复核**、也不声称 bro2「更强/更弱」——它只是把 bro2 的轨迹行为摆到公开轨迹参照轴上，指出一个具体的、可在后续 harness 迭代里消解的改进点（P1 紧窗口压缩 / 早停与自检回路）。

### 4.1 后续修正（v2.31.0，只增不抹）

> 本节保留上面的历史结论原文，但**其实证推断已被逐轨迹诊断证伪**，修正见 [`BUDGET-ADVISORY-EXPERIMENT.md`](./BUDGET-ADVISORY-EXPERIMENT.md) §2。要点：
>
> 1. 「失败题工具调用更多 = 空转不肯停」是聚合指标的误读——`bank-trans-filter` 的 14 次工具调用来自 7 步里每步并行 2 个工具，真实停因是 **`guard(kind=tokens)`：`超过 token 预算 60000`**，模型当时已正确完成读 CSV/检索/计划、正准备写产出文件。
> 2. 「缺把 verifier 信号接回决策」在本测量框架下不成立——公开 pytest 判分在 Docker 里事后执行，bro2 本就看不到它。真正的缺口是**预算将尽时没有任何收尾提示**，导致已完成的推理来不及落盘。
> 3. 另一道失败题 `tb-assign-seats` 复跑时是 `completed` 且真写了 `results.txt`，但答案多写 2 行（**模型约束求解不全**）——属模型能力，不是 harness 行为缺陷，不该靠 harness 硬凑。
> 4. **同一题两次 K=1 跑机理完全不同**（9 工具错误撞 guard vs 0 错误正常完成），说明免费匿名端点噪声极大，v2.30.0 的 K=1 读数**不能作为调参依据**。
>
> 因此 §7「把失败题空转做成可证伪的 harness 改进实验」这一下一步，已按修正后的机理（预算软预警，而非早停）在 v2.31.0 执行并留痕：**预注册 A/B 判据未全成立（行为判据 P2 不成立），如实发布负结果、机制默认关闭**，详见 [`BUDGET-ADVISORY-EXPERIMENT.md`](./BUDGET-ADVISORY-EXPERIMENT.md) §5。

---

## 5. 诚实边界

- **bro2 自跑、非第三方复核、仅内部轨迹采集**；轨迹数字来自 bro2 自己的 `EvalReport`，不是外部 agent 的轨迹对齐。
- **HuggingFace 不可达**，无法下载 Toolathlon-Trajectories 等公开轨迹数据集做逐条比对；本节只用公开榜单的聚合轨迹统计作参照轴。
- 样本极小（**4 题、每题 K=1**）、任务来自 `original-tasks` **非官方 core / 非榜单口径**；Terminal-Bench 与 SWE-bench 是**不同基准家族**，绝对轨迹数不可直接相减，只比「轨迹效率/停止行为」这一跨族行为轴。
- 结果是 **Model + Harness 端到端产物**：既不证明模型能力，也不证明 harness 的通用增益；不对 bro2 做能力位次断言。
- **未写 `data/benchmark/external-results.json`**，**不改 L4 / `leadership.verdict`**。
- 同模型隔离锚点（ovhcloud / gpt-oss-120b）因端点限流（`provider_error` 频发，首调即失败）在本沙箱**无法取得有效数据**，故本批轨迹画像仅基于 kilo 主端点（positioning-only）。

---

## 6. 复现

```bash
# 取公开任务（固定 commit + SHA256 校验）
sh examples/fetch-external-tasks.sh
# 构建固定评分器镜像
docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile
# 跑 bro2 完整 harness（kilo 主端点），每题轨迹指标落进报告 perTask[].traj
EXT_K=1 EXT_PROVIDERS=kilo AGENTOS_LIVE_PROVIDER=kilo \
  node --experimental-strip-types --no-warnings examples/tb-leaderboard-compare.ts
# 抽取轨迹指标
node --experimental-strip-types --no-warnings -e "const r=JSON.parse(require('fs').readFileSync('data/bench/external/tb-leaderboard-compare-kilo.json','utf8')); for(const t of r.providers_detail[0].perTask) console.log(t.taskId, JSON.stringify(t.traj));"
```

---

## 7. 下一步（不是本轮成果）

- **接一个能在完整 harness 下稳定驱动工具调用的第二端点**，把 §5 的同模型隔离锚点（ovhcloud/gpt-oss-120b，公开榜 26.217%）做成有效 harness-Δ 样本。
- **扩 Terminal-Bench 样本并提升 K**（当前 4 题/K=1）；同时把 verifier 镜像按需扩展（gcc 等）以纳入 `circuit-fibsqrt` 这类需编译的任务——但须守住「统一离线、可复现」前提。
- **把 §4 的「失败题空转」行为点做成可证伪的 harness 改进实验**：加入「verifier 信号回灌 + 早停」后，在同一框架下复测，看失败题的工具调用中位数是否下降、通过率是否持平/上升。
