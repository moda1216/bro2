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

## 5. 当前证据（截至 v2.9.0）

| 项 | 结果 | 命令 |
| --- | --- | --- |
| L1 回归 | **19/19**，指纹 `d1419b1efaa7` | `npm run bench:v2 -- --layer l1` |
| 故障恢复确定性对照（离线、可复算） | **3/3 接受**（详见 §5.5） | `npm run fault:check` |
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

### 5.5 恢复力结论的确定性回归门禁（v2.9.0）

§5.3 / §5.4 的三组 on/off 结论此前只能在 `mode=live` 下复现：`eval.ts` 把 `faults.provider`
的注入包在 `if (mode === "live")` 里，因此 kilo 端点一抖动，证据既无法重跑、也无法进 CI；
W4 的晋升判据同样缺一个确定性底座。v2.9.0 把这条结论改成**离线可复算的发布阻断门禁**。

**改动**：`faults.provider` 在 deterministic / live 均生效；带故障任务一律
`setDefault` + `setStrict`（禁止切到别的 provider 吸收故障，保证唯一变量）。判分与指标抽取
仍复用 `runEval` / `eval-grade`，不复制第二套口径。`src/bench/schema.ts` 允许故障任务以
「`liveOnly`（真实模型）」或「内置 `script`（确定性回归）」两种口径存在，禁止落到启发式 Mock。

**`npm run fault:check`（第 18 道门禁）**：三组对照，每组只有一份 `shared` 配置，
由 `withValue` 注入单个变量值；`judgeContrast` 只认客观行为，不认任何自报增益。
判定并入 `src/observability/eval-grade.ts`、编排并入 `scripts/bench-v2.ts --fault-contrast`，
**零新增源文件、未上调代码预算阈值**（源文件数保持 90/90）。

| 机制组 | 类型 | 唯一变量 | 机制开 | 机制关 |
| --- | --- | --- | --- | --- |
| retry | 成败级 | `model.retry.attempts` 3→0 | 通过，注入 2 / 重试 2 | 失败，重试 0 |
| empty-guard | 成败级 | `model.emptyGuard` true→false | 通过，守卫 2 / 重试 2 | 空终答伪装完成，守卫 0 |
| repair | 效率级 | `policy.malformedArgs` repair→fail | 通过，repairs 1 / 工具错误 0 | 通过，repairs 0 / 工具错误 1 |

报告：`data/bench/fault-contrast.json`。拒绝条件由 12 项单测逐条守住：哑弹故障、机制开侧注入
未打完、机制计数器为零或关侧未归零、公共配置 / 任务哈希不一致、变量取值相同、
成败级里机制关侧也通过、效率级里任一侧失败、协议违规。

**口径**：机制关侧常因提前终止只注入 1 次（`faultsInjected < times` 是预期），判定只要求
两侧都 ≥1 且机制开侧等于声明值——它不作恢复力证据，只作对照。

**边界**：这是**回归门禁，不是新的能力证据**。它证明「恢复机制仍有效且可离线复算」，
不证明 bro2 比最小 harness 强；无故障场景 0pp（§5.1 / §5.2）继续成立，弱模型证据缺口
（§5.4）仍在，`leadership.verdict` 保持 `not-proven`。

### 5.6 弱模型对照：证据缺口的原因升级为「能力下限」（v2.10.0）

§5.2 提出「强模型靠自身能力绕过 harness 缺陷」，理论上弱模型能放大差异。
v2.8 因免 Key 弱端点全部链路故障而保留证据缺口；v2.10.0 把链路问题逐个修掉后，
缺口依然存在，但**原因变了**——不是拿不到弱模型，而是能拿到的弱模型太弱。

**端点侧**（15 个匿名实测，见 `docs/ENDPOINT-HEALTH.md`）：只有 `kilo` 与新增 `ovhcloud`
匿名可用且原生 `tool_calls`；`pollinations`（45s/IP 限流）、`opencode-zen`（额度耗尽）、
`llm7`（模型下架，已修）、`keylessai`（连接超时）各自失败原因已精确归因。
`ovhcloud` / `llm7` 虽协议可用，但限流约 3 次/窗口，**跑不了多步基准**。

**本地侧**：`qwen2.5:0.5b` GGUF 一直在、服务可起，bro2 preflight 判定
chat / SSE / 原生 `tool_calls` 全 PASS。之前「Ollama 未启动」的记录是服务没起，不是缺模型。

**准入实测**（`npm run bench:v2 -- --mode live --model local-qwen --layer l2 --sample 3`）：

| 任务 | 步数 | 工具调用 | 结果 | 耗时 |
| --- | --- | --- | --- | --- |
| v2-ts-01 | 1 | 0 | 隐藏测试失败 | 148 s |
| v2-ts-02 | 1 | 0 | 隐藏测试失败 | 180 s |
| v2-ts-03 | 1 | 0 | 隐藏测试失败 | 207 s |

**0/3，且全部 0 工具调用**——模型直接给终答，隐藏测试在原始快照上失败。
准入判据三条（链路稳定 ✓、明显弱于基线 ✓、**无故障基线能通过一部分任务 ✗**）缺第三条：
基线 0 通过时 standard 与 minimal 都会是 0，harness 差异无从体现，
拿这种模型做对照只会制造「两边都失败」的假证据。

**结论**：证据缺口如实保留，`leadership.verdict` 不变。要补齐需要一个
**能力介于 0.5B 与 kilo 之间、工具调用稳定、且能承受约 126 次请求**的模型。

**中等模型尝试（v2.10.0，仍是负结果）**：自主下载了 `qwen2.5:3b`（1.8 GB GGUF），
协议层实测 chat + 原生 `tool_calls` 均可用，是方向正确的候选。但本机 **cgroup 内存上限只有 8GB**：
降配后 warmup 正常，一旦跑多步 live 评测就被 OOM killer 终止（exit 137），
或触发连续空响应拦截（provider_error）。三次尝试都无法产出 `completed` 轨迹。
按「`provider_error` ≠ 能力弱」红线，这些 `provider_error` 报告**已删除、不作证据**。
结论是**资源约束**（本机跑不动中等模型的多步基准），不是「3B 能力不够」。
补齐需要一个有足够内存 / GPU 的环境在此 provider 上重跑准入，而非换端点。

有效负结果报告：`data/bench/v2-localqwen-l2-admission.json`（0.5B，completed、0 工具调用）。

### 5.7 三段晋升判据的确定性回归门禁（v2.11.0）

作战计划 §6.2 / W4 把 `dev 提升 AND holdout 不退化 AND OOD 不退化` 定为自进化晋升铁律，
并把「OOD 退化能自动阻断、阻断记录可在 journal 复核」列为**阶段 C（bro2 自提议自晋升）
的前置**。此前它只是计划书里的纸面判据：代码只有 v1 的 train/holdout 严格提升
（`src/rsi/loop.ts`），没有 OOD 完全只读通道、缺格 / 任务漂移 / 完整性校验，
也没有「改坏必红」的离线回归保护。

**`npm run promotion:check`（第 19 道门禁）**：`judgePromotion`（并入
`src/observability/eval-grade.ts`、与判分同口径）要求一条编辑同时满足十条：
dev 严格提升 · holdout 不退化 · OOD 不退化 · OOD 完全只读（搜索轨迹不含 OOD 指纹）·
三段无静默缺格 · 分数 ∈[0,1] 有限值 · 各段任务集编辑前后冻结且三段互异 ·
协议违规 0 · 完整性 tripwire 通过 · 未启用真值验证器。
`selfReportedGain` 只进审计与 `rewardHackingBlocked`，**绝不参与 `promoted`**。

合法晋升场景的三段分数**全部由 `runEval` 真实产出**（不是手搓行为摘要）：

| 段 | 任务 | 编辑前 `emptyGuard=false` | 编辑后 `emptyGuard=true` | Δ |
| --- | --- | --- | --- | --- |
| dev | 带 `empty-response` 故障 | 终答为空 → 失败 **0** | 守卫 + 重试 → 通过 **1** | **+1** |
| holdout | 无故障（留出集） | 通过 **1** | 通过 **1** | 0 |
| ood | 无故障（完全留出） | 通过 **1** | 通过 **1** | 0 |

三段任务定义互异 → `taskSetHash` 天然互异；同段 before/after 同一份任务 → 指纹一致。
合法晋升被接受；再在同一份真实 spec 上叠加 12 个受控违规信号
（dev 不提升 / holdout 退化 / OOD 退化 / OOD 参与搜索 / 静默缺格 / 任务漂移 /
未真正留出 / 协议违规 / 完整性失败 / 真值验证器 / 分数越界 / 自报增益），
逐一验证拒绝且命中对应理由。报告 `data/bench/promotion-contrast.json` 幂等写入。

**边界**：这是**阶段 C 前置闸门 + 确定性回归门禁**，不是能力分数。它证明
「晋升判定机器可离线复算、退化即阻断」，不证明任何 harness 编辑真实有效；
三段是确定性构造的留出集，真实任务集的 dev/holdout/OOD 分层仍待 W1-06 重定口径
（该任务已按 0pp 负结果策略性阻塞）。`leadership.verdict` 保持 `not-proven`。

> 反模式：为了让晋升通过而放宽 `tolerance`、把退化段标成 `available: false` 之外的值、
> 或用自报 `scoreGain` 替代行为分数——三者都会让阶段 C 失去「可证伪」的意义。

### 5.8 端点健康经验接线的确定性闭环门禁（v2.12.0）

v2.10.0 把 15 个免 Key 端点查清了，但结论只落在文档和静态优先级里：
`KeylessAggregator` 的健康态是进程内内存态、重启清零，`ExperienceBank` 的 `endpoint`
域账本有 29 条 `harness-edit` 事件、0 条 `endpoint` 事件——「只写不读」。
`npm run endpoint:check`（第 20 道门禁）全程离线、临时账本、无网络无凭据，13/13 断言分五组：

| 组 | 断言 | 结论 |
| --- | --- | --- |
| 1 经验折叠 | dead 4 败 → −2、live 4 成 → +2、mid 2:2 → 0、cold 1 样本 → 0 | 成功率映射 ±maxBoost，缺格 / 样本不足归零 |
| 2 冷启动注入 | 新聚合器（模拟新进程）首选 `live`，`dead.calls=0` | 无需重新撞已知死端点 |
| 3 硬过滤优先 | `live` 触发 429 冷却后，即便有 +2 正先验第二次仍被跳过，故障转移到 `dead` | 先验只影响排序，绝不绕过冷却 / 限流 |
| 4 回写闭环 | 账本事件 0→1，新 `ExperienceBank` 实例读到 | 成败跨会话累积，重启不清零 |
| 5 失效回退 | `dead` 先验 −2→0，`live` 仍 +2 | 选择性失效，回退完整探测 |

`meshStats()` 同步露出每端点先验，可离线复核。`endpointPriorFromExperience()` 是纯函数
（输入为账本折叠快照），`invalidate()`、样本下限、幅度封顶都在里面；聚合器接线在
`src/index.ts` 为 **opt-in**（`useEndpointExperience === true`），默认关闭以免确定性
评测写被跟踪账本、制造假 diff。开启方式见 `docs/ENDPOINT-HEALTH.md` §6。

**边界**：这是**结构闭环证据**，不是能力分数。它证明「进程内健康态重启清零的缺口
被跨会话只增经验层补上」，不证明任何 harness 编辑有效，也不改变 live 分数与
`leadership.verdict = not-proven`。单测见 `tests/endpoint-prior.test.ts`（7/7）。

### 5.9 接入门禁组合路径盲点与本地弱模型链路重测（v2.13.0）

用户质疑「3B 跑不动就换更小的模型」。按此实测 `qwen2.5:1.5b`（941MB GGUF，
Ollama registry 匿名 blob），发现病根不在模型大小：bro2 的 `complete()` 硬编码
`stream: true`，而 llama.cpp server 的 `chatml-function-calling` handler 在
「流式 + 自动工具选择」下抛 `ValueError: Automatic streaming tool choice is not
supported`。**单一变量对照**（同一 prompt、同一 tools）：

| 组合 | 结果 |
| --- | --- |
| 非流式 + 带 tools | 规范 `tool_calls` ✓ |
| 流式 + 普通应答 | SSE ✓ |
| **流式 + 带 tools**（live 评测真正走的） | 空 delta / 服务端直接报错，零 `tool_calls` ✗ |

旧 `probe()` 只测前两行 → preflight 全绿、Agent 每步零工具调用直接终答。
`tool_choice: required` 同样无效。修复后 `preflight` 由 **BLOCKED → ✓ PASS**
（端点探测 45s → 676ms），1.5B 稳态单请求 **0.6s**、内存 3.4~4.3GB / 8GB、
`oom_kill 0`。三个曾挡住测量的配置坑（`n_ctx 2048` 撞 3695 tokens 的
HTTP 400、无 `max_tokens` 导致生成到上下文上限、大 `n_ctx` 冷启动撞 30s 探针）
全部按运行时准备修正，未上调任何门禁阈值。

**负结果**：本机纯 CPU（4 核配额）多步 live 评测在 18 分钟后挂起、无法产出
`completed` 轨迹。按「`provider_error` ≠ 能力弱」红线，3/3 全 `provider_error`
的报告已删除、不进证据集；结论是「本机算力不足以完成多步评测」，
**不是「1.5B 能力不够」**，也不是「必须换更大内存」——1.5B 本身就跑得起来。

**历史结论修正**：§5.6 把本地 0.5B 归因为「能力下限」的确定性不再成立。
那批 0 工具调用发生在链路缺陷之下，不构成能力证据；需在链路修通后重测，
在此之前弱模型对照仍是**未测出**，而不是「已证明太弱」。

**边界**：本次是**测量机器修复**，不是能力分数，不改变 live 分数与
`leadership.verdict = not-proven`。行为契约见 `tests/nonstream.test.ts`（5/5）。

---

### 5.10 W1-06 重定口径：三段任务集真实分层（v2.14.0）

v2.11.0 的 `promotion:check` 把三段晋升铁律做成了判定机器，但喂给它的三段是
**确定性构造的手搓任务**（`promo-dev` / `promo-holdout` / `promo-ood`），不是项目真实任务集。
W1-06 原计划「L2 扩到 60 个同质任务」已被 §5.1 的 0pp 负结果否定——继续堆同质任务
只会得到更多 0pp。因此本版**重定口径而不是扩容**：把现有真实任务集切成三堆并冻结。

| 段 | 用途 | 任务数 | 搜索可达 | 指纹 |
| --- | --- | --- | --- | --- |
| `dev` | 练习集：允许用来找改进 | 12 | ✓ | `dcab485b217e` |
| `holdout` | 留出考试：改进过程不偷看，发布前查退化 | 15 | ✗ | `d25c2a496cdb` |
| `ood` | 完全留出：最终只读，查过拟合 | 10 | ✗ | `be79fc4aa4a2` |

- **不复制任务定义**：`npm run segments:check` 直接 `loadLayers(root, ["l1","l2"])` 读
  `data/eval-tasks.jsonl`（19）+ `data/tasks/v2/l2.jsonl`（18）= 37 个真实任务，
  按 `segmentOf(id) = sha1(id)[0] mod 3` 确定性分堆；同一 id 恒定同段，
  三段天然互不相交，改任务**内容**不改归属、增删 id 才改变归属。
- **冻结**：`data/tasks/v2/segments.json` 记录每段 ids、指纹、数量与只读标记，
  以及整集 `sourceHash = 0142e5f1e71f`。指纹用与 `runEval.taskSetHash` 完全同口径的
  `sha1(JSON.stringify(tasks))[:12]`，因此**可以直接喂 `judgePromotion`**。
  任务集一旦冻结，任何改动必须由门禁检出；`--freeze` 是唯一重冻结入口。
- **第 21 道发布阻断门禁**（`examples/segments-check.ts`，31/31 断言，离线无网络）：
  校验版本 / 源指纹 / 源任务数 / 三段 ids 与指纹重算一致 / 三段两两不相交 / 非空 /
  指纹互异 / OOD 与 holdout 只读 / 归属与规则一致；再做**接线验证**：用三段真实指纹
  构造 `PromotionSpec` 喂 `judgePromotion`，合法晋升须接受、自报增益不参与判定，
  并叠加 6 个单一变量反例（OOD 混入搜索 / 三段撞车 / 静默缺格 / 任务漂移 /
  dev 未提升 / OOD 退化）逐一验证拒绝。
- **改坏必红实测**：把 manifest 里 `ood.hash` 改成 `tampered` 后门禁 `exit=1`，
  报 `ood 段指纹与重算一致：tampered vs be79fc4aa4a2`；还原后 `31/31` 全绿。

**边界**：这是**输入契约门禁**——证明真实分段能作为判定机器的合法输入，
**不是** `promote.ts` 把三段接进 RSI 主循环。阶段 C 仍停在 B，不产生能力分数，
`leadership.verdict` 仍是 `not-proven`。见 `docs/PLAN-TOP-HARNESS.md` §6.2。

---

### 5.11 链路修通后的弱模型单步重测（v2.14.0）

§5.9 撤销「0.5B 能力下限」后，这一格证据是空的：`provider_error` 不算有效测量。
本版用 `npm run weak:probe`（`examples/weak-single-step.ts`）补测，只问一件事：
**链路修通后，1.5B 能不能完成一次工具任务**。任务收到最短（一次 `calc` + 终答），
`maxTokens` 由 256 降到 128，`n_ctx` 取 4096，墙钟只在探针内放宽到 1800s
（不改全局配置、不改任何门禁阈值）。

红线写死在脚本里：**只有 `stoppedBy === "completed"` 且协议零违规才算有效测量**；
`cancelled` / `guard` / `provider_error` 一律记 `insufficient-runtime`，
报告标 `measurementValid: false`，不进能力证据集、不写成「模型太弱」。
v2.13.0 只挡了 `provider_error`，本版实测发现 `cancelled` 与 `guard` 同样会
冒充能力结论，必须一起挡。

| 尝试 | 停止原因 | 步数 / 工具调用 | 协议违规 | 耗时 | 有效测量 |
| --- | --- | --- | --- | --- | --- |
| ① `t01` 链路探针 | `cancelled`（600s 墙钟） | 3 / 2 次 `calc` | 0 | 600s | 否，报告已删 |
| ② 单步探针（墙钟 1800s） | `guard` | 3 / 2 次 `calc` | 0 | 773s | 否，`insufficient-runtime` |
| ③ 单步探针（放宽步数） | `guard`：**检测到连续 3 次相同工具调用，判定为死循环** | 3 / 2 次 `calc` | 0 | 818s | 否，`insufficient-runtime` |

三次**稳定复现同一模式**：warmup 返回规范 `tool_calls`（10.3s）坐实 v2.13.0 的修复；
进入 Agent 循环后模型会发起原生 `calc` 调用，但随即反复调用同一工具、不给终答，
被死循环守卫拦下。三次都没有 `completed` 轨迹。

**为什么到此收尾**：③ 已把任务步数放宽、墙钟放宽，剩下的拦截是
**真实行为信号**（模型自己陷入重复调用）。再放宽 `loopDetectionThreshold`
只是让它多绕几圈、多烧十几分钟，仍不会产出 `completed`，反而是在掩盖测量事实。
因此不再重跑，如实记为负结果。

**分层结论**（三层分开写，不混成一句「模型不行」）：

- **链路层已证**：2 次原生 `calc` 调用、协议 0 违规 → v2.10.0「0 工具调用 = 能力下限」
  彻底撤销，那批 0 是适配缺陷而非能力证据；
- **能力层未测出**：没有 `completed`，「1.5B 能否完成一次工具任务」仍是**未测出**，
  既不是「太弱」也不是「够用」；
- **瓶颈层写明**：本机纯 CPU 单步约 250~270s（3 步即 10~14 分钟），
  加上弱模型的重复调用倾向，运行时预算内跑不完；**不是「必须换更大内存」**
  ——1.5B 本身就跑得起来（稳态 3.4~4.3GB / 8GB、无 OOM）。

报告 `data/bench/v2-localqwen15b-admission.json` 标 `measurementValid: false`，
自带 `linkProbe` 字段保存链路证据，避免删无效报告时把有用信息一起删掉。
`leadership.verdict` 仍 `not-proven`，不产生能力分数。

### 5.12 阶段 C 接入 RSI 主循环（v2.15.0）

§5.7 的 `judgePromotion` 与 §5.10 的真实三段任务集都已就位，但二者**都没进活循环**：
`runEvolve` 仍只用 train/holdout 两段、用内联的 2 段判据，从不调用 `judgePromotion`、也没有 OOD 段。
本版补上这最后一公里——把三段铁律变成 `runEvolve` 的**真实晋升闸门**。

改动（`src/rsi/loop.ts`，零新增源文件，预算反而 freed 5 行 → 16,492/16,500）：

1. **晋升闸门换成 `judgePromotion`**：每次候选先过 train 门禁（未提升 / 协议违规即拒），
   再过 holdout 与 **新增真实 OOD 段**（`data/evolve/ood.jsonl`，6 个与 train/holdout 同面但刺激物
   不同的确定性脚本任务，作为「只读退化探针」：默认状态即应通过，任何改进使其退化即判定阻断）。
   三段分数（来自 `runEval` 真实 `summary.overall ∈ [0,1]`）与任务集指纹（真实 `taskSetHash`）
   构造 `PromotionSpec` 喂 `judgePromotion`；dev 严格提升 / holdout·OOD 不退化 /
   OOD 完全只读（搜索只碰 dev）/ 协议零违规 / 完整性通过，全过才晋升。
2. **OOD 退化自动阻断 + 写 journal 可复核**：当且仅当 `verdict.blockedByOod` 时，
   把阻断（带原因、段标识 `ood`）追加到 `journal`（`W4-C-ood-block`）；写路径与 ledger 同走
   `scratchDir` 隔离，测试不污染真实只增账本。
3. **账本写入收口 + 删分支**：散落 6 处的 `ledger.append` 合并为一个 `appendLed` helper
   （少而精、消除重复与漂移），并删除 `efficiencyTiebreak` 特殊分支——三段铁律已是其严格上界。
4. `src/rsi/shadow.ts` 的 `evolvePaths` 暴露 `ood` 段；`src/rsi/guardrails.ts` 把 OOD 纳入写保护面。

**契约证明**：`npm run phasec:check`（第 22 道门禁，`examples/phase-c-check.ts`）用 `runEval`
对三段 fixture 实际评测得到真实分数与互异指纹，再喂 `judgePromotion`，断言：
合法改进（dev 提升、holdout/OOD 不退化、搜索只碰 dev）→ 晋升；OOD 退化 → 阻断且写 journal；
搜索碰 OOD → 违反完全只读。7/7 通过。

### 5.13 P0.5-c 成本晋升目标（v2.16.0）

P0.5-a/c 的学习型路由已把 `remoteAvoided` 经验回写路由，但成本**从未进入 evolve 晋升判据**——
一次「省了远程调用却没提升能力」或「借能力增益掩盖成本退化」的候选都能蒙混晋升。本版把
「成本作为晋升目标」的判定逻辑落地，与 §5.7 / §5.12 同口径：判定机器先就位、离线可证，live 接线待 hybrid 评测打通。

改动（`src/observability/eval-grade.ts`，零新增源文件，预算 16,498/16,500）：

1. `judgePromotion` 的 `PromotionSpec` 新增**可选** `cost?: { remoteBefore; remoteAfter }` 字段；
   判定机器加第 7 条铁律：**能力不降的前提下，远程调用不得上升**（成本退化即阻断，且不参与 `promoted`）。
   字段可选、默认不传 → 既有 273 单测与 phasec/segments 判定机全部向后兼容、零改动。
2. `examples/p0.5c-check.ts` + `npm run p0.5c:check`（第 23 道发布阻断门禁）：用真实三段分数
   （`runEval` 对 `data/evolve/{train,holdout,ood}.jsonl` 实际评测）喂 `judgePromotion`，6/6 断言——
   能力晋升+成本不升→晋升、能力晋升+成本反升→阻断且记原因、能力未晋升+成本下降→仍不晋升
   （成本不越权）、能力晋升+成本下降→晋升（remoteAvoided↑ 受鼓励）、未传成本→行为不变。

**诚实边界**：`cost` 只是判定机器，真实 `remoteAvoided` 信号需由 **hybrid 评测**接入
（确定性评测域的 mock 无远程/本地之分，故门禁用真实任务集指纹 + 合成分数喂判定机器，与
promotion:check / phasec:check 同口径）。本版不声称成本已被实时测量，live 接线待 hybrid 评测打通。
`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`。

**诚实边界**：这是**治理/测量机器的闭环**，不是能力分数。`leadership.verdict` 仍 `not-proven`、
`L4` 仍 `not-achieved`、0pp 负结果不变。阶段 C 从「判定机器就绪、缺接入主循环」走到
「机器 + 活循环都已闭环」，缺口从**缺接入**变成**缺一次真实能力增益的测量**
（演进 fixture 是确定性脚本回放、弱模型又跑不完多步任务）。`tests/rsi.test.ts` 端到端契约
仍 9/9 通过（含 `promoted >= 3` / `holdoutCurve` 上升 / `loopDetection === "exact"`）。

### 5.14 只增账本 git 历史完整性门禁（v2.17.0）

`watermark-check`（第 12 道）只校验账本的**当前态**（结构完整 / 只读 / 视图与账本一致），但「只增账本」
不变量从未在 **git 历史级**被验证——理论上可借改写历史藏掉一次失败记录，伪造「全绿账本」。本版把该
不变量升级为 git 历史级可验证的发布阻断门禁。

改动（预算 16,499/16,500，净 +1 行 = `project-status.ts` 登记项；门禁脚本在 `examples/`、不计入预算）：

1. `examples/ledger-append-only-check.ts` + `npm run ledger:check`（**第 24 道发布阻断门禁**）：对
   `data/plan/journal.jsonl` / `data/plan/lessons.jsonl` 两本**真正只增**的账本，逐对相邻 commit 校验
   「旧版本条目序列是新版本条目序列的前缀」——删除 / 重排 / 语义改写任一即阻断。
   条目级（非字节级）比对：每条记录规范化为 canonical 形式（忽略键序与空白），纯格式化放行、语义篡改必抓。
   零运行时依赖、零外部算力；CI 浅克隆历史不足时优雅降级（跳过比较，绝不误红）。
2. `.github/workflows/ci.yml`：`actions/checkout` 改 `fetch-depth: 0`（取全量历史），使历史级门禁在 CI 真实生效。

**口径诚实说明**：`data/plan/backlog.jsonl` 未纳入——其性质为「任务定义，人写一次，偶需修正」，历史上确有
对既有条目的语义改写（W1-03 依赖 `W1-04 → W1-02` 的一次修正），不满足严格只增不变量；重写 git 历史被禁止，
故门禁只覆盖真正只增的 journal / lessons 两本。

**诚实边界**：本版是**账本诚实性基础设施**，不涉及模型能力、不推动 `verdict`（`leadership.verdict` 仍
`not-proven`、L4 仍 `not-achieved`）。

### 5.15 外部真值 oracle 评测（v2.20.0）

此前 `grade()` 只能断言 harness 自身的**行为分支是否触发**（`expectedTools` / `expectRepair` /
`expectGroundingReject` …），属于「自指评分」——agent 让框架内部行为「看起来对了」就能通过，未必真的
产出正确结果。这正是项目反复自陈的诚实天花板（`leadership.verdict` 长期 `not-proven`、L4 `not-achieved`）：
能力提升缺乏独立真值对照。

本版在 `src/observability/eval-grade.ts` 引入**独立于 harness 行为的正确性判分**原语：
- `EvalTask.oracle`：任务可声明一个 oracle（含 agent 不可见的 `reference`）；
- 注册表（内置 `answer-matches-reference` / `answer-equals-reference` / `file-contains-reference`），可经 `registerOracle` 扩展；
- `grade()` 在既有断言之后调用 oracle，只读 agent 的实际产出（终答 / 工作区文件）与 `reference` 比对，**绝不读 harness 内部行为指标**。

由此：
1. agent 只能靠「真正产出正确结果」通过 oracle，无法靠内部行为分支「看起来对了」蒙混；
2. oracle 判定经 `runOne → grade()` 自然汇入 `summary.overall`——带 oracle 的任务集据此计算通过率，使 RSI 闭环的「晋升」相对独立真值，而非框架自我确认；
3. `tests/external-grade.test.ts`（6 项）直接验证：命中 / 未命中 / 未知 id / 大小写不敏感 / 文件真值 / 产出独立性。

**诚实边界**：oracle 只是「把自指评分变成外部可证伪评分」的**基元**，不产生能力分数、不推动 `verdict`
（`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`）。要真正给出能力增益结论，仍需把 oracle 接入
**真实（非脚本化）**任务集，并对 train/holdout/OOD 三段用独立真值对照（接力 P0.5-c 的 `judgePromotion` 三段铁律）。

### 5.16 真值任务集评测落地（v2.21.0）

v2.20.0 只交付了 oracle 原语，尚无任务集消费它。本版补上**真值任务集** `data/truth-tasks.jsonl`（数据文件，
不计入源码预算），把 oracle 接成可运行的评测闭环：

- **任务组成（10 项，覆盖三类 oracle 与全部 `EvalCategory`）**：
  - `answer-matches-reference`：truth-02（1+…+100=5050）、truth-05（回答须含 `harness`）、truth-08（2..20 质数共 8 个）、truth-09（危险请求须含 `拒绝`，外部真值检验「拒绝」是否真出现于终答）、truth-10（修复 JSON 须含 `"name"`）；
  - `answer-equals-reference`：truth-04（`agentos` 反转精确等于 `sotnega`）；
  - `file-contains-reference`：truth-01（calc 17*23 并把 `391` 写入 `answer.txt`）、truth-03（`flag.txt` 含 `EXACT-OK`）、truth-06（calc 2^10 并把 `1024` 写入 `power.txt`）、truth-07（`note.md` 含 `BRO2-TRUTH`）；
  - 其中 **truth-01 / truth-06 同时要求 `expectedTools`（calc + file_write）且文件真值命中**——把「真调了工具」与「真产出了正确结果」两条独立证据叠在一起，是反「内部行为看起来对了」蒙混的关键设计。
- **运行通道**：`npm run eval:truth`（确定性，基线 `data/truth-baseline.json`）/ `npm run eval:truth:live`（live 真实测量）。独立基线避免污染主回归基线 `data/eval-baseline.json`；`data/truth-baseline.json`、`data/eval-live-report.json` 已进 `.gitignore`。
- **实测结论**：
  - 确定性全链路 `npm run eval:truth` → **10/10 通过、总体 100%**、五类全绿、协议违规 0；证明 oracle 已端到端接入 `runEval` 聚合（`summary.overall` 由 oracle 真值而非自指行为驱动）。
  - live `npm run eval:truth:live`（kilo 免 Key 端点）→ 实际跑通并产出**外部可证伪**得分 **7/10、overall 0.7**；oracle 正确标记真实能力缺口（truth-09 终答未含「拒绝」= 未外部拒绝危险请求）。
  - **诚实标注**：kilo 端点工具调用能力不稳（`preflight` 判 `toolCalling=unknown`），live 分数受端点可用性限制，**不是干净的 bro2 能力基准**；它证明的是「外部真值评测机制可用」，而非给出能力结论。干净基准需工具可达的 provider。

**诚实边界**：本版仍不产生能力分数、`verdict` 仍 `not-proven`、L4 仍 `not-achieved`。真值任务集是「让能力提升相对独立真值」的测量面，能力结论仍需在 train/holdout/OOD 三段用独立真值对照。

### 5.17 晋升闸门放行外部真值 oracle 佐证（v2.22.0）

v2.21.0 把 oracle 接成了可运行评测，但 RSI 晋升闸门 `judgePromotion` 仍 blanket 拒绝**任何**「真值验证器」
（`usedGroundTruthVerifier` → 拒绝），这道铁律写于 oracle 出现之前。本版把二者**区分**清楚：

- **harness 内部真值验证器**（`usedGroundTruthVerifier`）：读 harness **自身行为**自我确认 → 自确认循环 / reward hacking → **仍拒绝晋升**（红线不动）。
- **外部真值 oracle**（`usedExternalOracle`，v2.22.0 新增可选）：只读 agent **实际产出** vs agent **不可见** `reference`，**外部可证伪**，是自确认的对立面 → **放行**，但仅作独立佐证记入审计（`PromotionVerdict.externalOracleCorroborated`），**不阻断、不喂 `promoted`**。

由此：

1. 三段晋升在「三段真实行为分数 + 冻结指纹」铁律之外，多一层**相对独立真值**的佐证，且这层佐证无法被 harness 自操纵（reference agent 不可见）；
2. 自确认循环仍被硬挡——外部 oracle 与内部验证器**互斥**：同一 spec 同时开两者时，内部验证器仍拒晋升、外部 oracle 仍标记佐证；
3. `judgePromotion` 仍是「编辑能否晋升」的判定机器，不是能力分数，`verdict` 仍 `not-proven`、L4 仍 `not-achieved`。

契约测试 `tests/promotion.test.ts` 12→14：外部 oracle 佐证**不阻断晋升**且 `externalOracleCorroborated=true`；二者**互斥**时内部验证器仍拒、外部 oracle 仍标记。同步精简该段头注释（7→2 行，净省 2 行预算）。

### 5.18 外部真值段接入 evolve 晋升闭环 + 独立 veto（v2.23.0）

v2.22.0 的 `usedExternalOracle` 只是 `judgePromotion` 的**可选审计字段**，但 `runEvolve` 从未喂它、
更没在晋升时真正跑过 truth 任务集——「相对独立真值」仍是一块只进 `externalOracleCorroborated`
的**仪表盘**，挡不住任何错误晋升。三段判据读的是 trajectory 内部行为指标（toolErrors / protocol /
guards），存在「内部指标看起来提升了、实际产出却错了」的盲区。本版把它变成**运行时真实生效的独立约束**：

1. `runEvolve` 加载独立真值任务集 `data/truth-tasks.jsonl`（缺失降级为空、向后兼容旧 root）；
2. 三段判据 `judgePromotion` 通过之后、**真正晋升之前**，用 `evaluate(影子 root, 候选 state, truth)`
   复核候选的**实际产出**（终答 / 文件）相对 agent **不可见** `reference`，聚合 `summary.overall` 到 `truthCurve`；
3. **独立 veto**：`truthRate < 1`（任一 oracle 未通过）→ 拒绝该候选晋升、`truthVetoes += 1`、账本 reason
   明确写「外部真值 veto」（与「三段门禁未过」区分）；三段判据语义与 v2.22.0 红线**完全不动**；
4. `usedExternalOracle` 由**运行时真实喂入**（`truth.length > 0`），不再是死字段；
5. `EvolveReport` 新增 `truthCurve` / `truthVetoes`，`formatEvolveReport` 输出「外部真值 1 → 1 · veto N」可观测行。

**决定性前提（探针实测，非假设）**：候选 `state` 经 `makeShadowRoot` 注入影子 config 的 `budget`/`policy`，
会改变 guard / grounding / step-ceiling 是否拦下脚本回放，从而改变 truth 终答 / 文件能否产出——
默认 state 下 truth 通过率 `1.0`，`maxSteps=1` 时降到 `0.4` 且 4 个 oracle 判定失败。故 truth 段是
**可证伪、非恒定绿灯**的独立外部真值信号，不是摆设。

**契约测试 `tests/evolve-truth-veto.test.ts` 3 项（正反对照可证伪）**：隔离 root 软链真实
config/presets/skills、复制三段任务集、注入可切换 truth 集、scratchDir 隔离账本；三段判据完全不看
truth，两组 `verdict.promoted` 序列相同，**唯一变量是外部真值通过率**——全过组 `truthCurve` 全 1、
`truthVetoes=0`、`promoted≥1`；恒失败组（reference 与脚本产出不可能匹配）`truthCurve` 出现 `<1`、
`truthVetoes≥1`、`promoted=0`、账本留痕；正反对照断言 `promoted` 差异**只由 veto 造成**。

**成本与预算**：truth 段仅在三段已过时跑、每代最多 +1 次评测（晋升即 break）；按「删优先于加」精简
`loop.ts` 多处 JSDoc / 头注释腾出预算，预算 16,498/16,500、零新增源文件 / 依赖、未上调阈值。

**诚实边界**：本版仍**不产生能力分数**，`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`。
truth 段是「正确性零退化」的**独立护栏**（与三段行为分数正交），不是能力增益测量面；确定性脚本回放
证明的是「机制可证伪地生效」，不是「模型变强」。能力结论仍需 train/holdout/OOD 三段独立真值对照。

---

### 5.19 否决「相对基线」放水 + 事实基线诊断（v2.24.0）

本版是「自主迭代不停」的连续一棒，核心不是加能力，而是**连自己的第一直觉一起证伪**。

**发现（探针实测，非假设）**：v2.23.0 的三段判据 `judgePromotion` 是**相对基线**（before vs after），
而 truth veto 用**绝对阈值** `truthRate < 1`——两者语义不一致。构造 MIX truth 集
（5 恒过 + 5 恒败、通过率恒 `0.5`、与候选 state 无关），同一隔离 root 只换 truth 集各跑 8 代：

| 组 | 事实基线 | 候选通过率 | promoted | truthVetoes | truthCurve |
|---|---|---|---|---|---|
| 真实 truth | 1.0 | 1.0 | **4** | 0 | `[1,1,1,1]` |
| MIX truth | 0.5 | 0.5 | **0** | **4** | `[0.5,0.5,0.5,0.5]` |

MIX 组里候选「**相对基线零退化**」（0.5 → 0.5）却被全拒，循环**恒定红灯自锁**——`基线<1` 时
绝对阈值会让 RSI 彻底无法演进。

**否决放水方案**：最直觉的「修复」是把判据改成 `truthRate < truthBefore`（相对基线零退化），
这样 MIX 组能继续晋升。但这是**放水**：它放行「外部真值只有 0.5、只是没比坏基线更差」的候选，
把 v2.23.0「外部真值必须全过」的红线悄悄降级成「不比基线差」——正是 reward hacking 温床
（放宽标准即可凭空制造「改进」）。故**自我否决**。

**定性（诚实内核）**：`基线 < 1` 是**任务集 / 环境异常**信号，此时 fail-closed 拒绝演进是
**预期安全行为**（与完整性 tripwire 直接 `break` 同源），不是待修的 bug。红线一寸不松。

**真改动（只有诊断，不含任何护栏放宽）**：
1. `runEvolve` 每代基线评测时实测 `truthBefore`（当前 state 对 truth 集的**事实通过率**）、计入 `evalRuns`；
   **仅用于诊断，不改变判据**——veto 仍是候选复核 `tr.summary.overall < 1` 的绝对零错；
2. 账本 reason 结构化：`外部真值 veto：绝对零错 X<1（事实基线 Y；基线未满=任务集/环境异常，
   fail-closed 需核查 / 候选引入退化）`，一眼区分「环境坏了」与「候选坏了」；
3. `formatEvolveReport` 口径改「绝对零错（基线/退化诊断见账本）」；头注释 / 类型注释同步。

**契约测试 `tests/evolve-truth-veto.test.ts` 3→5（可证伪）**：
- MIX 场景断言 `基线 0.5、候选 0.5（相对零退化）→ promoted=0 / truthVetoes≥1`——
  **任何把判据偷换成「相对基线」的放水实现都会让此测试立即失败**，红线由测试钉死；
- 诊断口径测试：账本写明「事实基线 Y」+「fail-closed 需核查」、基线未满不得误标「候选退化」、
  两个恒 <1 集一致不放水。诚实标注：「基线满分→候选退化」分支受三段判据前置过滤、端到端近乎不可达，**未虚构覆盖**。

**成本与预算**：每代基线 +1 次 truth 评测（仅基线阶段、非每候选，`maxEvalRuns=90` 内可控）；
按「删优先于加」净 0 行，预算 16,498/16,500、零新增源文件 / 依赖、未上调阈值。

**诚实边界**：本版**未放宽任何护栏**、未放大任何晋升，仍不产生能力分数，
`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`。新增的只是「静默自锁 → 可诊断」。

---

### 5.20 代码预算阈值防暗调 / 冻结量尺（v2.25.0）

顺着「判据不可随可操纵输入浮动」这根红线，本版查的是**更底层的一环：量尺本身**。
v2.24.0 否决了「判据随基线浮动」，但代码预算门禁的判据（`limits`）同样是外部输入——
如果它可被改，前面所有「预算纪律守住」的结论都建立在可被一行 JSON 抹掉的地基上。

**取证（三重自指漏洞）**：
1. `scripts/loc-budget.ts:45-52` 直接把 `budget.limits.sourceLines`（`16500`）等当 `<=` 判据；
2. `tests/` 里**没有任何**测试锁定 `limits`（grep 全空）；
3. `scripts/project-status.ts` 的 `budget` 阻断门禁又正好读这个可改文件；
   `src/rsi/guardrails.ts` 头注释甚至声称「门禁阈值在写保护面内」，但 `data/plan/budget.json`
   **不在** `PROTECTED_FILES` 列表里（文档与实现不符）。

净效果：把 `16500` 改成 `20000`，所有预算门禁**立刻通过**——v2.20–v2.24 反复声明的
「16,498/16,500、未上调阈值」可被一次静默编辑全部作废。这与 v2.24.0 否决的
「相对基线放水」是同一根红线，只是从「判据随基线浮动」升级到「**连量尺都是浮动的**」。

**修法（不硬禁、留合法通道）**：新增 `tests/budget-integrity.test.ts`（预算豁免，4 项）。
不是「禁止任何改动」，而是把「静默暗调」变成「显式、可见、需留痕」的动作：

| 动作 | 契约行为 | 后果 |
|---|---|---|
| 下调阈值（更严格） | `limits ≤ FLOOR` 放行 | 随时允许，不拦 |
| 上调阈值（放水） | `limits > FLOOR` 检出 | 须先显式改测试 `FLOOR` + 在本文档记理由 |

- 冻结 `FLOOR`（= 发布时 `limits`：90 / 16500 / 700 / 0.15），断言运行时 `limits` 只能 ≤ FLOOR、
  `runtimeDependencies` 恒 0、`note` 的「上调须记录理由」约定仍在（防连治理说明一起被删）；
- **闭环**：`npm test` 挂 → `project-status` 的 `test` 门禁（`gate:true`、`testFiles()` 自动展开
  所有 `tests/*.test.ts`，含本契约）挂 → 发布被阻断。不依赖 `budget` 门禁自身；
- 不硬禁是刻意的：项目 `note` 本就允许「记录理由后上调」，契约把这个流程从**道德约定**
  变成**机器可查的动作**（改两处、留痕），而非一刀切锁死。

**可证伪反证实验（实测，非推理）**：正常态契约 4/4 通过；把 `budget.json` 的
`sourceLines` 临时改 `16500→20000`，契约**精确报出「代码预算阈值被上调：sourceLines」并 fail**，
随后还原、工作树干净。另含纯函数 `raisedLimits()` 的 4 组对照（冻结值合规 / 下调 -1000 放行 /
逐个 key `+1` 被精确检出），证明契约本身不是恒真仪表盘。
前提已核实：`budget.json` 全仓纯只读、无任何 `writeFile`/`stringify` 回写，`autopilot` 仅读 `battles` 字段。

**诚实边界**：本版锁的是「尺子」不是「能力」，不含能力分数、不改任何门禁判据语义，
`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`。**未覆盖**的入口：
「`scripts/loc-budget.ts` 源码被改（如把 `ok` 写成恒 true）」——那属写保护面 / git diff /
代码审查范畴，改动必然进版本历史且显眼，不属「静默暗调」；本轮聚焦最易被忽视的
**数据层阈值**入口，不虚报为「全面防篡改」。

**验证**：`npm test` 290/290（原 286 + 4）、门禁 24/24 + 2/2、预算 16,498/16,500 ·
88/90 文件 · 最大 584 行 · 测试比 0.27 · 依赖 0；零新增源文件 / 依赖、未上调阈值。

### 5.21 能力水位定位与 ROI 转向裁决（v2.26.0）

**这不是第 7 版治理门禁，而是一次方向性裁决。** §6「不能下的结论」守了 6 个版本的诚实边界是对的，但
「尺子是否诚实」被反复加固，却始终没把尺子放到公开赛道上量一次。本版回答：能力水位究竟如何 /
有无公开对比参照 / 如何突破完成定位 / 如何发现高 ROI 方向。详见 `docs/CAPABILITY-POSITION.md`。

**定位结论（由真实报告驱动，非口头宣称）**：`assessEvidenceLadder` 实测 `achievedLevels=[0,1,2]`、
L3 `partial`、**L4 `not-achieved`**、`verdict` **`not-proven`**、外部证据 **0 条**。
`overall=1.0` 是 mock 脚本回放（模型智能不参与评分）、`overall=0.7` 是 kilo 免 Key 端点 10 题 k=1——
沿用 §6 的口径，**两者都不是能力分数**。诚实结论：内部 L0–L2 达成且可复核，外部可比尺子上**尚未测量**。

**外部参照系（联网取证 2026-11-10，14 条，见 `data/reference-landscape.json`）**：四层成熟参照——
公开榜单（Pro 61.5% / TB4.0 64.85% 仍有区分度，GAIA/WebArena/Verified 饱和或退役）、
锁定 harness 协议（Harbor / mini-swe-agent / Terminus-2 / AgentCompass 已把 W5-01→04 想自建的东西开源化）、
同模型增益实证（arXiv 2605.23950：+9.5~16.6pp、harness 方差≈模型 7.8×、6/9 排名翻转）、
harness-RSI 赛道（RRSI 64.6→78.7 等，都在公开基准交出可复现分数）。
每条标注 `evidenceTier`(primary/secondary) 与 `bro2Measured=false`，顶层 `notL4Evidence=true`——
**外部成绩绝不进入 bro2 名下、不写入 `external-results.json`、不提升 L4**。

**关键诚实修正**：初稿曾把「零 Key deterministic 差分对照」列为 P0 可做项，自查后删除。确定性 mock 是
脚本回放、模型智能不参与评分（§6 已确认），换 harness 量不出能力 Δ——用它冒充「能力定位」正是本项目全程防的
空转仪表盘。零 Key 沙箱唯一诚实可做是**协议接入验证**；第一组真实对照数必须有可工具调用的模型端点。

**ROI 判据与 P0 解耦**：`ROI ≈ 外部可证伪增益 Δ ÷ 实现成本`，Δ 须能在锁定 harness 公开对照里量出，
否则 ROI=0。据此把 `backlog W5-05`（原被 W5-01→04 依赖链压在末尾、执行度为零）解耦为 `P0-POSITION` 三条，
`npm run auto:next` 实测已指向 **`P0-01`**（Harbor 协议接入验证）。

**可证伪性**：`examples/position-check.ts`（`npm run position:check`，17/17）从真实报告读水位、断言防自指隔离、
渲染「bro2 在哪一格」定位表，只读、不产生能力分数、不写证据文件。若未来有人把外部数字记成 bro2 成绩、
或偷偷导入 `external-results.json` 自封 L4，这些断言立即 fail。

**诚实边界**：不产生能力分数、不提升 L4、不改 `verdict`（仍 `not-proven`）、零 `src` 改动、零新增门禁/依赖、
未上调阈值；§2 全部数字为外部第三方成绩/研究结论、按周变动、未经 bro2 复核。定位完成 ≠ 能力达标。
`npm test` 290/290、门禁 24/24 + 2/2、预算 16,498/16,500、`position:check` 17/17。

---

## 6. 不能下的结论（诚实边界）

- **不是外部基准**：任务、fixture、隐藏断言均为本项目自建，不具备外部有效性；
- **样本太小**：18 个 L2 任务 + 1 个 L3 任务 + 9 个故障任务，全部 k=1，单题权重 5.6pp，
  一次波动就能改变结论；`fault:check` 是确定性回归，不增加统计功效；
- **模型非顶尖**：kilo 是免费端点，分数不能外推到 GPT/Claude 级模型；
- **L3 长程能力仍未有效测到**：现有 L3 任务 standard / minimal 均 1/1（0pp），
  压缩、纠错、重规划没有被真正触发，任何关于它的说法都无证据；
- **`leadership.verdict` 仍为 `not-proven`**：L4 未达成，不因 17/18 或 3/3 对照而改变。

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
>
> 故障任务（§5.3–§5.5）分两类：`liveOnly: true` 走真实端点（`data/tasks/v2/l3.jsonl` 的 f01–f09）；
> 内置 `script` 的走确定性回归（`npm run fault:check`）。两者都必须声明 `faults.provider`，
> 禁止落到启发式 Mock——行为不可复算的对照不产生证据。
