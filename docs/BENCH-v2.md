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
| **L3 长程压力层** | 20–40 步、需中途纠错 | 1（`ts-todo`，多约束 + 过时断言） | 隐藏测试 + 步数预算 |

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

L3 首个任务（`v2-l3-01`，要求同时完成过滤 / 稳定排序 / 持久化，并识别一条过时断言）：

| harness | 结果 | 步数 | 工具调用 |
| --- | --- | --- | --- |
| standard | 1/1 | 12 | 17 |
| minimal | 1/1 | 10 | 15 |

**仍然是 0pp，minimal 反而少 2 步。**

### 5.2 为什么连 L3 也测不出差异

`minimal` 预设里有 `shell`，而 shell 是图灵完备的：读写文件、跑测试、改权限都能做。
在「单仓库、单进程、无外部依赖」的场景里，工具层的精巧程度被 `shell` 抹平了。

harness 真正可能产生差异的地方，需要至少满足一条：

1. **上下文超窗**：材料大到必须压缩，且压缩策略影响正确性（当前 fixture 只有几十 KB）；
2. **故障恢复**：工具失败/审批拒绝/超时后能否重规划（当前任务几乎无故障）；
3. **多 Agent 协作**：子任务可并行且需要结果汇聚（当前任务都是单线程）；
4. **弱模型**：强模型靠自身能力就能绕过 harness 缺陷（kilo 一次过 17/18）。

第 4 条试过一次：`pollinations` 端点当前全部 `provider_error`（链路不可用，不是能力差异），
因此**没有拿到弱模型对照**。这条证据缺口必须如实保留。

### 5.3 故障注入：第一个能产生区分度的场景（v2.7.0）

任务不变、模型不变，只注入**确定性 provider 故障**（`faults.provider`），
唯一变量是 harness 的恢复机制：

| 任务 | 注入故障 | 机制开 | 机制关（唯一变量） | 结论 |
| --- | --- | --- | --- | --- |
| `v2-l3-f01`（新增 remove） | 429 ×2 | ✓ 通过，2 次路由重试（`v2-kilo-fault-retry.json`） | ✗ 第 1 步死于 provider_error（`v2-kilo-fault-noretry.json`） | **重试决定成败** |
| `v2-l3-f02`（新增 setPriority） | 500 ×3 | ✓ 通过，3 次路由重试 | ✗ 第 1 步死于 provider_error | **重试决定成败** |
| `v2-l3-f03`（新增 search） | 参数名拼写 ×1 | repair：✓ 3 步 / repairs=1 / 0 错误（`v2-kilo-fault-repair.json`） | fail：✓ 8 步 / 1 次工具错误 / repairs=0（`v2-kilo-fault-fail.json`） | **repair 省一步纠错回环，收益是效率不是通过率** |

证据文件：`data/bench/v2-kilo-fault-{retry,noretry,repair,fail}.json`（kilo，k=1，2026-11-09）。

**这是第一组正证据**：同模型、同任务、故障确定性注入且全部命中（`faultsInjected` = 声明值），
唯一变量是 harness 机制开关——瞬态故障下路由重试是从 0 到 1 的差异；
参数修复把「模型读错误 → 重写调用」的一次回环降为 0。

边界（不许外推）：

- 这只证明「**故障场景下恢复机制有价值**」，不改变无故障场景的 0pp 结论（§5.1/§5.2）；
- k=1，f03 的步数差在 fail 侧两次跑分为 4 步与 8 步，存在波动；
  机制性差异（repairs 1 vs 0、toolErrors 0 vs 1）才是稳定信号；
- 故障是注入的，v2.7.0 只覆盖「立刻报错」型（429/500/参数名拼写）；
  超时、半截响应、Retry-After 三类更脏的形态见 §5.4（v2.8.0）。

判定口径：

- 故障必须**全部实际注入**（报告里的 `faultsInjected` = 声明的 `times`），
  否则「恢复成功」不算数；
- 恢复力结论只看「同模型、同任务、唯一变量 = 机制开关」的对照组；
- 这证明的是「**瞬态故障下重试有价值**」，不是「bro2 全面更强」——
  无故障场景的 0pp 结论（§5.1/§5.2）继续成立。

### 5.4 脏故障形态、9 任务统计功效与弱模型证据缺口（v2.8.0）

把 §5.3 的「立刻报错」扩展为**真实端点更常见的四类脏故障**，并把故障任务从 3 个扩到 9 个
（`v2-l3-f01` ~ `f09`），让每个机制有 ≥2 个独立样本，降低单题波动（k=1 仍是硬约束）。

#### 新增故障形态与对应机制

| 故障 kind | 真实形态 | 为什么脏 | 兜住的 harness 机制 | 消融开关 |
| --- | --- | --- | --- | --- |
| `timeout` | 端点挂起后 ETIMEDOUT | 不立刻报错，先 stall | 路由重试（瞬态判定覆盖超时） | `--no-retry` |
| `retry-after` | 429 带 Retry-After | 服务端指定等待时长 | 路由退避**尊重**指示值而非盲目指数 | `--no-retry` |
| `empty-response` | 200 但半截/空响应 | **不抛错**，绕过所有 catch 型重试 | 新增「空响应守卫」主动转错误再重试 | `--no-empty-guard` |
| `malformed-args` | 参数名拼错 | 命中 repair 分支 | `malformedArgs=repair` | `--policy` |

防拖慢：timeout 短 stall（默认 120ms，上限 1s）、retry-after 等待上限 1s；
真实挂起是「等」，harness 要判的是**错误分类与重试**，不是等待时长。

#### 三组 on/off 对照（kilo，k=1，2026-11-09）

| 机制组 | 任务 | 机制开 | 机制关 | 稳定信号 |
| --- | --- | --- | --- | --- |
| 路由重试 | f01/f02/f04/f05/f07（429/500/timeout/retry-after） | **5/5** | **0/5**，全部第 1 步 `provider_error` | 10 次注入 → 10 次 `providerRetries`，全恢复 |
| 空响应守卫 | f06/f09（empty-response ×2/×1） | **2/2**，`emptyGuardHits` 2/1 | **0/2**，静默空终答（`stoppedBy=completed` 但 answer 空） | 守卫计数 3 次，`faultsInjected` = 声明值 |
| repair 策略 | f03/f08（参数名拼写 ×1） | 2/2，repairs 2/1，0 工具错误 | 2/2，工具错误 1/0 | **效率级**：步数方向不一致（f08 开 5 步 vs 关 3 步），不能当「更快」证据 |

证据文件：`data/bench/v2-kilo-{retry9,guard9,repair9}-{on,off}.json`。
**结论**：新增两类「机制开/关决定成败」的脏故障（timeout/retry-after 走重试，
empty-response 走守卫），且半截响应的「静默成功」正是 catch 型重试的盲区——
不开守卫时它会伪装成 `completed`，比 `provider_error` 更危险。

#### 弱模型对照：证据缺口（负结果，必须保留）

§5.2 指出「强模型靠自身能力绕过 harness 缺陷」，理论上弱模型能放大差异。
严格模式（禁止 mock 降级）实测全部免 Key 端点：

| 端点 | 预检 | 真实跑分 | 判定 |
| --- | --- | --- | --- |
| `pollinations` | 就绪 | `provider_error` 收尾、工具错误率 3，retry on/off 均 0/1 | **链路抖动**，非能力弱 |
| `opencode-zen` / `llm7` | 未就绪 | 拒绝运行（SSE / 原生 tool_calls 缺失） | 链路故障 |
| `keylessai` | 未就绪 | 拒绝运行（连接失败） | 链路故障 |
| 本地 `qwen2.5:0.5b` | — | Ollama 未启动 | 不可用 |

`run` 命令里 llm7/opencode-zen 曾输出「离线 Mock 模型驱动」——那正是 **静默降级到 Mock**，
严格模式已把它挡掉。**「预检就绪」≠「能跑分」，「provider_error」≠「能力弱」。**
当前环境**拿不到可信的弱模型对照**，`leadership.verdict` 仍为 `not-proven`。
补齐条件：一个链路稳定、能力明显低于 kilo 的真实端点；在此之前不写任何「弱模型下增益更大」的结论。

#### 诚实边界（累计）

- 全部为 kilo 单模型、k=1；9 任务样本仍不足以支撑统计显著性检验；
- repair 组步数方向不一致，只有 `repairs`/`toolErrors` 是稳定机制计数；
- 注入故障仍是「可控」的：半截响应只模拟「整段为空」，未覆盖「返回半句文本 + 截断的 tool_call JSON」；
- 这三类脏故障证明的是「**对应恢复机制有价值**」，不改变无故障场景 0pp（§5.1/§5.2）。

**所以当前唯一诚实的结论是**：在可用模型（kilo）与现有场景下，
「bro2 比最小 harness 强」**未被证实**；`leadership.verdict = not-proven` 不因任何分数改变。

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
