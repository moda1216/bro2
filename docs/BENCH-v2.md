# BENCH-v2 · 分层任务集与判定口径

> 这份文档只回答四个问题：**测什么、怎么判、怎么复现、哪些结论不能下**。
> 所有数字都必须能用本文命令重跑出来；跑不出来的一律标「无证据」。

---

## 1. 为什么要有 v2

v1 的 19 个任务平均 2.7 步就结束，压缩、纠错、重规划这些 harness 核心机制根本触发不到。
v2 的目标不是「更难的问题」，而是**让 harness 的差异可被测出**：

| 层 | 用途 | 规模（当前） | 判定方式 |
| --- | --- | --- | --- |
| **L1 回归层** | 协议 / 治理 / 恢复不回归 | 19（沿用 v1，单一事实源） | 脚本化，overall 必须 1.0 |
| **L2 真实工程层** | 真实仓库上的缺陷修复与功能新增 | 18（3 仓库 × 6） | 隐藏测试通过 + 终答非空 + 协议零违规 |
| **L3 长程压力层** | 20–40 步、需中途纠错 | 0（未建立） | 隐藏测试 + 步数预算 |

L1 不复制成 v2 文件：`loader.ts` 直接读 `data/eval-tasks.jsonl` 并幂等升格，避免两份事实源漂移。
L2 是 v2 原生格式，任务本身是数据，不计入代码预算。

---

## 2. 一个任务必须满足的三个条件

任务不是「写个 prompt」就算数。`scripts/task-check.ts` 对每个 L2 任务做双态校验：

1. **原始快照必须失败** —— 否则不修也能过，等于白送分；
2. **应用参考解后必须通过** —— 否则谁也做不出来，等于不可解；
3. **参考解不下发** —— 它只存在任务 JSON，`toEvalTask()` 会剥离，工作区里看不到。

```bash
npm run task:check -- --layer l2          # 18/18 才算任务集有效
```

隐藏断言以**内联 shell 命令**存在任务里，不落盘到工作区：

- 落盘就可能被 `file_list` / `search_files` 读到，隐藏性失效；
- 内联命令随任务 JSON 走，没有清理负担。

判定顺序：模型跑完 → `verifyWorkspace` 在隔离工作区执行隐藏命令 → 任一失败即该任务不通过，
原因带命令与输出尾部写进报告。

---

## 3. 两种模式，两套语义

| | deterministic | live |
| --- | --- | --- |
| 模型 | 脚本化 Mock | 真实 provider（先过 `live-gate`） |
| 用途 | 框架回归（L1） | 能力测量（L2） |
| 门禁 | 默认阈值（overall ≥ 0.85 等） | **只断言协议零违规** |
| 跳过规则 | `liveOnly` 任务不跑 | `deterministicOnly` 任务不跑 |

live 分数是**测量**，不是发布门禁——把 17/18 当成「必须 18/18 才能发版」会让团队开始挑任务。
反之，deterministic 模式下全层都是 live 任务时，阈值按「未测」处理并显式打印，绝不把「没测」算成「通过」。

---

## 4. 复现

```bash
# L1 回归（离线、秒级）
npm run bench:v2 -- --layer l1

# L2 任务有效性（离线，双态校准）
npm run task:check -- --layer l2

# L2 真实能力（需网络；provider 必须过预检）
npm run bench:v2 -- --layer l2 --mode live --model kilo --save data/bench/l2.json

# 同模型换 harness：唯一变量是对照组
npm run bench:v2 -- --layer l2 --mode live --model kilo --preset minimal
```

参数：`--sample N`（前 N 个任务，可复现）、`--repeat k`、`--only <id>`、`--json`。
live 报告默认落 `data/bench/v2-<provider>-<时间戳>.json`，含逐任务 `reasons`，可直接审计。

报告里的 `taskSetHash` 与装载器 `hash` 同口径（`sha1(JSON.stringify(tasks))` 前 12 位）。
指纹不一致时禁止跨报告比较——这是「改用例后分数变了」的唯一防线。

---

## 5. 当前证据（截至 v2.5.0）

| 项 | 结果 | 命令 |
| --- | --- | --- |
| L1 回归 | **19/19**，指纹 `d1419b1efaa7` | `npm run bench:v2 -- --layer l1` |
| L2 任务有效性 | **18/18 双态成立** | `npm run task:check -- --layer l2` |
| L2 live（kilo，standard，k=1） | **17/18（94.4%）**，平均 7.39 步 / 12.06 次工具 | `--mode live --model kilo` |
| L2 live（kilo，minimal，k=1） | **17/18（94.4%）**，平均 6.94 步 / 9.72 次工具 | `--preset minimal` |

失败案例：`v2-js-03`（新增 `applyCoupon`，含越界 `RangeError`）。
standard 在 15 步触发死循环 Guard；minimal 在 7 步写完但隐藏断言未过。
同一任务两种失败方式，都**不回填、不重跑刷分**。

### 5.1 负结果：这批任务没有区分度（0pp）

同模型、同任务、只换 harness：

| harness | 通过率 | 平均步数 | 平均工具调用 |
| --- | --- | --- | --- |
| bro2 standard | 17/18（94.4%） | 7.39 | 12.06 |
| minimal（shell + 文件读写 + calc） | 17/18（94.4%） | 6.94 | 9.72 |

**差距 0pp，成本反而高 24%。** 这不是「bro2 没价值」，而是「这 18 个任务测不出 harness 差异」：

- 任务都是**单文件、局部修改**，`shell` + `file_write` 足够完成；
- 可见测试直接指明行为，不需要 `repo_map` 定位、不需要 `diagnostics` 回环；
- 平均 7 步，远未触发上下文压缩、纠错重规划、审批治理。

**结论**：L2 单点任务只能验证「管线可用」，不能证明「harness 更强」。
区分度必须来自 **L3 长程 / 多约束 / 需要诊断回环**的任务（W1-07）。
在此之前，任何「bro2 比最小 harness 强 X%」的说法都**没有证据**。

---

## 6. 不能下的结论（诚实边界）

- **不是外部基准**：任务、fixture、隐藏断言均为本项目自建，不具备外部有效性；
- **样本太小**：18 个任务、k=1，单题权重 5.6pp，一次波动就能改变结论；
- **模型非顶尖**：kilo 是免费端点，分数不能外推到 GPT/Claude 级模型；
- **L3 为空**：长程压缩与纠错能力**没有测过**，任何关于它的说法都无证据；
- **`leadership.verdict` 仍为 `not-proven`**：L4 未达成，不因 17/18 而改变。

---

## 7. 新增一个 L2 任务的步骤

1. 选一个 fixture 仓库（`data/fixtures/repos/<name>`），确认缺陷/需求真实且可验证；
2. 写 `hiddenTests`：**必须能在原始快照上失败**，且只测目标行为（不误伤其他缺陷）；
3. 写 `reference`：`find/replace` 或 `append`，能精确落到源码；
4. 加进 `data/tasks/v2/l2.jsonl`，`liveOnly: true`，`repo` 指向 fixture；
5. `npm run task:check -- --layer l2` 全绿；
6. 若要扩 fixture：先改代码，再 `npm run fixture:check -- --update` 更新内容指纹；
7. `npm test` + `npm run project:status` 全绿后提交。

> 反模式：为了让分数好看而降低隐藏断言强度、或把 `sample: true` 的任务算进通过率。
> 前者是自欺，后者是虚报——两者都会让这套基准失去意义。
