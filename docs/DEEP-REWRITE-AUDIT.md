# 深度重写 · 一手素材审计与可证伪方案

> 定位：以"更深入而非更大"为准绳，对照规格逐条核验，**先给方案与风险清单，再谈实现**。
> 本轮**未改任何运行时源码**，未产出任何能力分数，未写 `external-results.json`。
> 判定口径只有三态：**VERIFIED**（有一手可复跑证据）/ **PARTIAL**（机制在但未接活循环或环境受限）/ **NOT-PROVEN**（明确未达成）。不存在第四态"达成"。

---

## 0. 本轮实读的一手素材（设计依据）

只用下列本轮实际打开核验的**一手**文件；不引用 `REWRITE-*`、`CORE-REPORT` 等已消化文档作为判据。

| 类别 | 一手素材 | 本轮核验点 |
| --- | --- | --- |
| 判分器源码 | `src/observability/eval-grade.ts`（476 行） | `grade()` / `judgeContrast()` / `judgePromotion()` 真实判据、外部 oracle、自报增益隔离 |
| 原始评测结果 | `data/bench/external/tb21-full-results.jsonl`（9 行） | reward 分布、唯一通过任务、verifyNote/rc |
| 榜单锚点 | `data/bench/external/UPSTREAM.json`、`official-harness-audit.json`、`tb-leaderboard-snapshot.json` | 26.217% 聚合分口径、241/89/88 分母、`isStrictHarnessDelta=false` |
| 端点原始契约 | `data/bench/external/endpoint-scan-report.json` | 匿名免 key 状态、401 模型、身份匹配 |
| 真实硬件基准 | `data/local-llm-stats.json` | 唯一真实推理：qwen2.5:0.5b CPU，18 请求 / 2 tool_calls / 1316.8s |
| 真实用户日志 | `data/sessions/s_*.jsonl`（40+ 会话） | 任务分布（`sum([1,2,3])`→notes.md 等真实任务） |
| 失败记录 | `data/evolve/incidents.jsonl`、`data/plan/lessons.jsonl` | patch_blocked 提权、判据机器≠活循环等一手教训 |
| 治理源码 | `src/governance/{approval,audit,guards,permissions}.ts`、`src/kernel/loop.ts`、`src/context/builder.ts` | 审批/审计/权限真实实现；"inject" 实际语义 |
| 证据 JSON | `data/evidence/*.json`（9 份） | 各 verdict / honest.notProven / 数据来源 |

---

## 1. 判定口径

| 态 | 含义 | 允许的表述 |
| --- | --- | --- |
| **VERIFIED** | 有一手、外部可复跑证据支撑，且结论就是该验收项本身 | 可写"已验证"，附复跑命令 |
| **PARTIAL** | 机制/骨架存在，但未接进活循环、样本不足、或环境为仿真 | 只能写"机制就位，未接活循环 / 样本不足" |
| **NOT-PROVEN** | 明确未达成，或本环境根本无法验证 | 必须写"未达成 / 未证"，不得省略 |

---

## 2. 硬约束审计（6 条）

| # | 硬约束 | 判定 | 一手依据 / 反例 |
| --- | --- | --- | --- |
| H1 | 24G Mac 可自主运行；MLX/llama.cpp/GGUF；端点失效降级到本地而非停摆 | **PARTIAL** | `mac-local-plan.json` 11/11 是**预算公式**（7B Q4≈5.97G fits / 32B F16≈66.57G not-fits），真机 tokens/s、峰值内存、MLX 推理均未测。唯一真实推理是 `local-llm-stats.json` 的 qwen2.5:0.5b **CPU**（非 Apple Silicon）。降级链路仅有 `failover-proof.json` 的进程内仿真。 |
| H2 | 冻结权重、harness 可演进；strict delta | **NOT-PROVEN** | `official-harness-audit.json`: `isStrictHarnessDelta=false`，`kind=non-strict-positioning-reference`。26.217% 是 gpt-oss-120b 聚合分、无逐任务明细；bro2 6 个 SOUND 任务仅 1 个落在 89 题集（`soundInPinned21=1`），分母不同源。 |
| H3 | config/harness/提示/数据/评测集 content-addressed 且可回滚 | **PARTIAL** | `content-manifest.json` 覆盖冻结面（eval/loop/events/guards/permissions/policy/repair/runtime）+ 只增账本 + 配置，篡改测试 rc=1。但账本增长会漂移，`content:verify` 仅信息项；提示文本与评测集未逐项纳入哈希。 |
| H4 | 不改冻结基准、不写伪造结果、mock/失败不计有效成绩 | **VERIFIED（机制层）/ PARTIAL（全链路）** | `eval-grade.ts` L393-400 自报增益只进审计不进 promoted；L211-214 协议违规零容忍；`tb21-batch.py` 对 mock/provider_error 判 error 不计 reward。但 `failover-proof.json` 的 `p1Finding` 自认：原判据只匹配终答中文标记、provider 层 `provider=mock` 泄漏未被 `tb21-batch.py` 捕获——**冻结脚本本身未回填该判据**。 |
| H5 | 离线、本地优先、数据不出本机 | **PARTIAL** | 端点为可选增强（keyless/hybrid 路由存在），默认可用离线账本。但真实评测全程走 ovhcloud/kilo 远端端点，数据出本机；真正"断网+无 key 跑通完整任务集"未做（`failover-proof` 只证错误分类闸门）。 |
| H6 | 深入而非更大：加厚验证/约束/可回滚骨架 | **VERIFIED（意图）/ PARTIAL（结果）** | 源码预算恒为 16500/16500，P0–P5 全部落 `examples/` 豁免目录、源码净增 0。但 `lessons.jsonl` 一手教训反复指出"判据机器就位≠接进活循环"——骨架厚了，闭环仍停在 B。 |

---

## 3. 能力需求逐条审计（7 条）

### 需求 1 · 本地自治
> 验收：断网 + 无 key 环境下跑通完整任务集。

- **判定：NOT-PROVEN**
- 一手反证：`failover-proof.json` honest 明确 `notProven: ["真机 Ollama/MLX 断网能力", "89×3 全量任务通过率"]`；场景 C 的"断网闭环"是 OpenAI 兼容协议仿真，不是真机 Ollama/MLX。
- 唯一真实推理是 0.5B CPU 模型（`local-llm-stats.json`），与"24G Mac 跑可用的本地模型"差距一个数量级。
- `adapter.ts` 证明的是预算公式自洽，不是"跑通"。

### 需求 2 · 通用助手
> 验收：真实使用日志采样任务分布上通过率与置信度双达标。

- **判定：NOT-PROVEN**
- 真实日志存在（`data/sessions/`，如 `sum([1,2,3])`→notes.md），但**未做分布采样评测**，更无"通过率+置信度双达标"的数字。
- 唯一可对照的公开基准 89×3 只完成 **9/267**，reward `{0:8, 1:1}`，唯一通过是 `constraints-scheduling`。按 `third-party-review.json`，n=9 时任何通过率的置信区间都宽到无意义，**不得宣称达标**。

### 需求 3 · 轨迹与反馈飞轮
> 验收：每条入库轨迹可追溯到来源与产生的 delta。

- **判定：PARTIAL**
- `trajectory-flywheel.json` 8/8 做了分级/脱敏/失败留痕，读真实账本（experience 29 条 / velocity 14 条），`provider=mock` 判据已回填证据环。
- 缺口：delta 用**全局 IPA 代理**，不是逐条轨迹的因果 delta；`lessons.jsonl` 一手教训指出"账本里 29 条全是 harness-edit、0 条 endpoint"，轨迹来源维度单一。"每条可追溯到产生的 delta"在逐条因果层面未证。

### 需求 4 · 自进化训练
> 验收：每次部署有冻结验证集的前后对照与显著性检验。

- **判定：PARTIAL（闸门骨架）/ NOT-PROVEN（真实训练与部署）**
- `eval-grade.ts` 的 `judgePromotion()` 判据完整（三段 dev/holdout/OOD、哈希冻结、OOD 只读、自报增益隔离），`promotion-gate.json` 7/7 验证了闸门。
- 一手反证：`lessons.jsonl` 明确记录"runEvolve 仍用内联 2 段判据、从没调用 judgePromotion、也没有 OOD 段——阶段 C 停在 B"。本沙箱无 GPU/LoRA，未执行真实训练。
- 显著性检验：`third-party-review.json` `sufficient=false`（n=9 vs 需 64/组），未达成。

### 需求 5 · 白盒交互
> 验收：外部观察者可仅凭界面重建决策链。

- **判定：PARTIAL**
- `whitebox-panel.json` 6/6：真实 EventBus 把四 lane 串成时间线，外部观察者重建一致，篡改 payload 可检出。
- 缺口：面板是静态 HTML（`WHITEBOX-PANEL.html`），SSE 实时推送 `notProven`；"仅凭界面"的真人可用性未经第三方测试。

### 需求 6 · 能效
> 验收：系统工具独立测量达标，超预算自动降级。

- **判定：NOT-PROVEN（能效）/ PARTIAL（token/内存）**
- **关键反证**：`whitebox-panel.json` energy 段 `externalTokens=4200, selfReportedTokens=1500, deviation=0.643, alert=true` 是**为演示告警构造的数字**；honest 明写"token 计数为外部采集仿真（本沙箱无 powermetrics/Apple Silicon）"。`rssMB=78.3` 是真实进程 RSS，但这是**唯一**真实的系统测量。
- 无能耗计（powermetrics/RAPL）、无 "超预算自动降级" 的真机触发证据。

### 需求 7 · 安全与自主
> 验收：第三方红队注入/提权测试通过；99%+ 无人化；提示注入防御。

- **判定：PARTIAL（应用层）/ NOT-PROVEN（第三方与提示注入）**
- `redteam-baseline.json` 13/13 是应用层治理拦截（路径逃逸/高危命令/脱敏/越权/尺子完整性），honest 明写"不是 OS 级沙箱，也不是完整渗透测试…证明已知攻击模式被拦截，不证明未知攻击不可绕过"。无第三方红队。
- **关键发现**：`loop.ts` / `builder.ts` 中全部 "inject" 命中（`extraInject`、`buildMemoryInjection`、`上下文注入`）都是**系统向自身 prompt 注入预算预警/记忆**，不是"防御外部提示注入"。本轮源码核验未发现独立的提示注入检测器。99% 无人化无度量。

---

## 4. 独立验证清单审计（7 条，缺一不可）

| # | 验证项 | 判定 | 一手依据 |
| --- | --- | --- | --- |
| V1 | 公开冻结基准上开源可复跑评测 | **PARTIAL** | `tb21-batch.py` 可复跑、逐 trial 原子落盘，但 9/267，且分母与榜单不同源（H2）。 |
| V2 | 独立判分器重判一致性 | **PARTIAL** | `recompute-report.json` 8/8 独立重算一致，但对象是**水位账本**而非**agent 产出判分**；`harbor-verify` 仅验证容器判分器可执行，非第三方重判。 |
| V3 | 客观指标 + 统计显著性 | **NOT-PROVEN** | `third-party-review.json`: actualN=9, required=64, sufficient=false。kappa/p 值只是可复算原语，一致性体检非显著性结论。 |
| V4 | 测试集隔离与哈希冻结 | **PARTIAL** | `content-manifest.json` 哈希冻结冻结面；`judgePromotion` 校验三段指纹互异 + OOD 只读。但真实评测集 `tasks.jsonl` 与 89 题集非同源。 |
| V5 | 进化曲线由独立脚本从原始数据重算 | **VERIFIED（机制）** | `evidence-recompute.ts` 不 import 运行时模块，从原始 JSONL 重算，8/8 + 逐点 14/14 一致。 |
| V6 | 第三方可审计 + 红队报告 | **NOT-PROVEN** | 全部 evidence 为自跑；`third-party-review.json` honest `noThirdParty`；红队是自测基线非第三方。 |
| V7 | 能耗/内存由系统工具外部测量 | **PARTIAL（内存）/ NOT-PROVEN（能耗）** | 仅 `rssMB=78.3` 真实；能耗为仿真（见需求 6）。 |

---

## 5. 五个结构性发现（比单个缺口更重要）

1. **strict delta 从未成立**。可归因的 harness-Δ 需要同任务/同模型/同评分器只变 harness；现状是分母不同源 + 聚合分无明细。`official-harness-audit.json` 已判定关闭"补公开数据"这条路。仓库内 `bro2 vs minimal` 受控对照是唯一现成的严格载体，但需 89 题全量跑完才够统计功效。

2. **"绿"多数是自证**。P0–P5 的 evidence 全部由 agent 自己写的脚本、喂自己产生的数据得出；`recompute` / `whitebox` / `failover` 的诚实字段都标 `not-proven`。它们证明的是**闸门逻辑正确**，不是**系统能力达标**。把 32/32 门禁全绿等同于"验证完成"是范畴错误。

3. **能效证据里唯一的真实数字是 RSS**。其余是构造的演示值。按你的验收口径，能效项应判 NOT-PROVEN。

4. **提示注入防御名存实亡**。源码中的 "inject" 全是系统自身注入。这是安全需求里最该补、也最容易被"有关键字"蒙混过去的一项。

5. **骨架厚了、闭环没接**。这是 `lessons.jsonl` 十条一手教训里的高频主题：判据机器就位 ≠ 接进活循环；有底座 ≠ 接上闭环；分开测都过 ≠ 生产路径能跑。深度重写的真正战场在这里，不在新增工具。

---

## 6. 可证伪架构方案（深入而非更大）

> 原则：**先接线、后新增**；每条方案都必须能被一个"改坏就变红"的测试证伪；全部落 `examples/` 豁免目录，源码净增 0；不修改冻结判分器与评测集。

### F1 · 把 strict delta 从"位次参照"升级为可归因（对应 H2 / 需求 2）
- **现状**：`isStrictHarnessDelta=false`。
- **改法**：启用仓库内已有的 `bro2 vs minimal` 同任务/同模型/同评分器受控对照，但把样本从玩具任务换成 89 题全量中已 sanity-sound 的任务，3 repeats；用 `judgeContrast` 而非聚合位次。
- **可证伪验收**：若 on/off 两侧 sharedHash 或 taskHash 不一致、`faultsInjected` 为哑弹、或 off 侧也完成，闸门必须返回 `accepted=false`。
- **失败模式**：样本仍不足 → 如实输出"功效不足"，不宣称 Δ。
- **落点**：`examples/` 新增受控对照 runner；不改 `eval-grade.ts`。

### F2 · 独立重判升级为"对 agent 产出判分"（对应 V2）
- **现状**：`recompute` 重算的是水位账本，不是 agent 终答/工作区文件。
- **改法**：用 `grade()` 的 oracle 只读 agent 产出这一性质，写一个不 import `eval-grade.ts` 的独立判分器，对 `tb21-full-results.jsonl` 每条的 workspace 快照重判，比对 reward。
- **可证伪验收**：故意篡改一条 reward，独立判分必须检出不一致；一致率必须逐条列出而非只给总数。
- **落点**：`examples/independent-grader.ts`。

### F3 · 能效：用真系统计数器替换仿真（对应需求 6 / V7）
- **现状**：`externalTokens=4200` 是构造值。
- **改法**：Linux 侧用 `/proc/<pid>/status` VmRSS + cgroup CPU 时间；token 从端点原始 usage 字段读取（若端点不返回则标记 `unmeasured`，禁止仿真填充）。能耗若无 RAPL/powermetrics 则明确写 `NOT-PROVEN` 而非造数。
- **可证伪验收**：拔掉 usage 字段后脚本必须输出 `unmeasured` 而非沿用 4200；VmRSS 必须随构造的内存分配单调变化。
- **落点**：`examples/energy-meter.ts`，覆盖 `whitebox-panel.json` 的仿真字段。

### F4 · 提示注入防御真实化（对应需求 7）
- **现状**：无独立检测器；"inject" 全是自身注入。
- **改法**：在工具结果/文件读取/网页内容进入 `context/builder.ts` 前，加一层不可信内容隔离（明确标记为 data 而非 instruction）+ 指令几何检测（角色越权、隐藏指令、编码载荷），命中走 `ApprovalManager` 升级授权并留审计。
- **可证伪验收**：注入经典 payload（"ignore previous instructions"、"system:" 伪装、base64 指令）必须被拦；正常任务文本不得误报；每次拦截有 audit 事件。
- **落点**：`examples/prompt-injection-redteam.ts` 先做红队基线（证明当前会中招），再给隔离方案；不改冻结源码。

### F5 · 把闸门接进活循环（对应需求 3/4，最高优先）
- **现状**：`lessons.jsonl` 明确 `judgePromotion` 从没被调用、runEvolve 用内联 2 段。
- **改法**：不动冻结 `eval-grade.ts`，在 evolve 的外置编排层把 `judgePromotion` 接入真实三段结果；把 29 条 harness-edit 之外的 endpoint 轨迹补进账本，让"delta 来源"维度非零。
- **可证伪验收**：构造一次 OOD 退化，晋升必须被阻断；构造 `selfReportedGain>0` 但行为未过，必须标记 rewardHacking。
- **落点**：`examples/evolve-live-gate.ts`。

### F6 · provider=mock 判据回填（对应 H4）
- **现状**：`tb21-batch.py` 只匹配终答中文标记，漏 provider 层机器字段。
- **改法**：不改冻结脚本本体，在其外层 wrapper 的日志判定中优先认 `provider=mock` 字段（P1 已验证 6 类）。
- **可证伪验收**：注入一个只在 provider 层泄漏的 trial，必须判 error 不计 reward。
- **落点**：`examples/tb21-batch-guard.py`，作为 wrapper 而非改原脚本。

### F7 · 真实用户日志分布采样（对应需求 2）
- **现状**：有 40+ 会话日志但未做分布采样评测。
- **改法**：从 `data/sessions/` 抽取任务类型分布，构造代表性子集，跑通率 + Wilson 置信区间，样本不足则明确"不可判定"。
- **可证伪验收**：置信区间宽度必须随 n 增大而收窄；n=9 时必须输出"不足以判定双达标"。
- **落点**：`examples/user-distribution-eval.ts`。

---

## 7. 风险清单

| ID | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 端点 2 req/min 限流 + 沙箱休眠，89×3 需 100+ 小时 | 全量不可得，V3 显著性永远不达标 | GitHub Actions cron（已建），或接受"功效不足"诚实标注 |
| R2 | 分母不同源（241/89/88，soundInPinned21=1） | strict delta 不可归因 | F1 受控对照；禁止用位次冒充 Δ |
| R3 | 聚合分无逐任务明细 | 无法与榜单逐题对齐 | 不写 external-results.json；只做定位参照 |
| R4 | evidence 全为自跑自证 | "绿"被误读为能力达标 | 每份报告强制 honest.notProven；V2 独立判分 |
| R5 | 能效仿真值冒充外部测量 | 验收造假 | F3 真计数器；无测量写 NOT-PROVEN |
| R6 | 提示注入防御缺失 | 安全需求落空 | F4 红队基线 + 不可信内容隔离 |
| R7 | 判据机器未接活循环 | 骨架厚但无效 | F5 接线；以账本事件分布验证非零 |
| R8 | provider=mock 泄漏漏判 | 数据污染混入成绩 | F6 wrapper 判据；H4 全链路 |
| R9 | 真机（Apple Silicon/GPU/powermetrics）本环境不可得 | 本地自治/能效无法真证 | 明确 PARTIAL，交付契约 + 复跑步骤，人工回填 |
| R10 | 账本增长导致内容哈希漂移 | content:verify 只能做信息项 | 冻结面与只增账本分离；提交前 pin 快照 |
| R11 | 源码预算 16500/16500 满额 | 任何源码改动需等量删减 | 全部新逻辑落 examples/；净增 0 |
| R12 | 第三方复核缺位 | V6 不可达 | 公开 evidence + 判据供外部审计；不自称第三方 |

---

## 8. 诚实边界与未达成项总表

**未达成（NOT-PROVEN）**：本地自治真机跑通、通用助手双达标、自进化真实训练与显著性、能效真机测量、第三方红队与提示注入防御、strict delta 归因、统计显著性、第三方复核、能耗外部测量。

**部分达成（PARTIAL）**：content-addressed 回滚、轨迹飞轮、白盒重建、闸门骨架、离线优先、深层意图。

**已验证（VERIFIED，且仅限所述范围）**：冻结判分器的自报隔离与协议零容忍机制、进化曲线独立重算的一致性、源码净增 0 的预算守恒。

**恒定边界**：所有阶段 `verdict=not-proven`、`L4=not-achieved` 不因本审计改变。本审计**不构成能力水位提升**，不产出任何榜单分数，不写 `external-results.json`。

---

## 9. 实施顺序建议（Gate A 已交付 → Gate B 待授权）

1. **先做 F4 / F5 / F6**（安全缺口 + 接线 + 防污染）——这三项是"深入"的核心，且能立即被证伪。
2. **再做 F3 / F2**（真测量 + 独立判分）——把自证换成可外部核对。
3. **F1 / F7 依赖全量数据**——受端点限流约束，先建可复跑骨架，样本随 cron 累积，达 n≥64 前不宣称显著性。
4. **真机项（H1/需求 6 的 Apple Silicon/MLX/powermetrics）**——本沙箱无硬件，交付契约与复跑步骤，标注待人工回填。

> 以上为方案。是否进入实现（Gate B），以及优先做哪几项，等你确认后再动。

---

## 10. Gate B 实现记录（按建议顺序 · 已完成）

> 用户确认"按建议顺序进入实现"。本节记录本轮落地，所有产物落 `examples/` 豁免目录，
> 源码净增 0（16500/16500），全部接入 `project:status` 阻断门禁（现 38/38）。

### 10.1 F4 提示注入防御（`inject:defense`，6/6 green）
- 产物：`examples/prompt-injection-redteam.ts` → `data/evidence/prompt-injection-redteam.json`。
- 结构性主防线：不可信内容（工具结果/文件）包成 `<untrusted>` 数据块，定界符转义使数据无法冒充指令（D 对照验证逃逸被转义）。
- 纵深检测：7 类指令几何（忽略前文/角色伪装/模板标记/指令定界符/越权动词/提示泄漏/任务替换）+ base64 载荷解码再检。
- 真实治理接线：`PermissionPolicy`（danger→Ask）+ `ApprovalManager`(autoApprove=false) 升级授权，`onRequest→resolve(deny)` 模拟人工拒绝，留 `approval.request/approval.resolved` 审计；展示文本经 `redact`。
- 可证伪：A 注入必拦 / B 正常零误报 / C deny 生效阻断执行 / C2 审计留痕 / D 逃逸转义 / S1 脱敏。
- **实测发现**：D1 payload 同时含 `rm -rf /`，`PermissionPolicy` 高危命令检测与几何检测形成双重防线。

### 10.2 F5 judgePromotion 接线（`promotion:live`，7/7 green）
- 产物：`examples/evolve-live-gate.ts` → `data/evidence/evolve-live-gate.json`。
- 直接 import 真实 `judgePromotion`，喂真实三段账本 SHA256（train/holdout/ood 互异）。
- 可证伪：正例晋升 / OOD 退化阻断 / reward-hacking 标记 / 静默缺格拒绝 / 任务漂移拒绝 / OOD 污染拒绝 / 三段不互异拒绝。
- **诚实边界**：这是"判据接线验证器"，证明判据可用且可证伪；真正把 `runEvolve` 内联判据替换为调用 `judgePromotion` 需改 `src`（受预算约束，未做，留给授权）。

### 10.3 F6 provider=mock 判据回填（`guard:backfill`，8/8 green）
- 产物：`examples/tb21-batch-guard.py` → `data/evidence/tb21-batch-guard.json`。
- 判据优先级：机器字段（`provider=mock` / `"provider":"mock"`）> provider_error > 旧中文终答标记。
- 可证伪：A 组仅机器字段泄漏（旧判据盲区）必拦 / B 旧标记兼容 / C provider_error / D 干净零误报。
- **诚实边界**：wrapper/判据库形式，未改冻结的 `tb21-batch.py` 本体；回填路径是评测流水线判定前调用 `is_polluted()`。

### 10.4 F3 真系统计数器（`energy:meter`，8/8 green）
- 产物：`examples/energy-meter.ts` → `data/evidence/energy-meter.json`。
- 真实数据源（本环境已探测可用）：`/proc/self/status` VmRSS、`/sys/fs/cgroup/cpu.stat` usage_usec、`memory.current`。
- 可证伪：VmRSS 有限正数 / 分配后单调不减 / cgroup CPU 忙等后单调增 / **无 usage 字段标 unmeasured（不造数）** / 有 usage 采信 / 一致不误报告警 / 真偏差告警。
- 实测快照：RSS≈125MB、cgroupMem≈1798MB、cpu≈1.4e8μs。替换 whitebox 的构造值 4200/1500。

### 10.5 F2 独立判分（`grade:independent`，5/5 green）
- 产物：`examples/independent-grader.ts` → `data/evidence/independent-grader.json`。
- 不 import `eval-grade.ts`（源码级独立），从官方 verifier rc 独立推导 reward（rc=0→1），与落盘逐条比对：9/9 一致。
- 可证伪：逐条一致率列出 / 篡改一条必检出 / 口径边界可复算 / **产出重判数据可得性审计** / 不 import 判分器。
- **一手缺口暴露**：结果行无 workspace 快照、无终答文本 → "对 agent 产出真正重判"物理不可做，如实判 not-proven，不伪造 workspace 充数。要让 V2 成立，评测流水线需逐 trial 留存 workspace 与终答 hash。

### 10.6 真机项流程闭环（`hw:runbook`，4/4 process-closed-not-executed）
- 产物：`examples/mac-local/real-hardware-runbook.ts` → `docs/MAC-REAL-HARDWARE-RUNBOOK.md` + `examples/mac-local/real-hardware-verify.sh` + `data/evidence/mac-real-readiness.json`。
- 固化 6 个真机待回填字段（断网任务集通过率 / MLX tokens/s / 峰值统一内存 / 每任务能耗 / 量化损失 / 原生 tool_calls）+ 判据 + 测量工具 + 阈值。
- 脚本含断网确认 + 无 key + 系统测量 + unmeasured 四要素；与 adapter 推荐配置（7B Q4 5.97G / stream:false / n_ctx≥4096）对齐。
- **诚实边界**：本沙箱无 Apple Silicon/MLX/powermetrics，只证"流程闭环完整"，不证任何真机能力；真机能力须在 Mac 上按 runbook 执行并独立复核后回填。

### 10.7 GitHub 定时评测核实（用户问询）
- 事实：`bench-external.yml` state=active、cron `17 */6 * * *` 正确，但 **run 历史 = 0，从未触发**；手动 dispatch 返回 403（PAT 无 Actions 写权限）。
- 判断：配置在、未被证实能跑。非代码可在此修复（GitHub 侧调度 + PAT 权限）。下次自动机会北京时间 14:17；网页手动触发入口：`https://github.com/moda1216/bro2/actions/workflows/bench-external.yml`。F1/F7 依赖的全量样本因此仍未累积（维持 9/267）。

### 10.8 本轮验证与边界
- 新工具 6 个全绿（6+7+8+8+5+4=38 项可证伪对照）+ 真机流程自检 4/4。
- `project:status` **38/38 阻断门禁 + 2/2 信息项**；预算 16500/16500 净增 0。
- **F1/F7 未实现**（依赖全量样本，cron 未触发，维持 9/267 partial）。
- **恒定边界不变**：`verdict=not-proven`、`L4=not-achieved`；本轮是"加厚验证/约束/闭环"，不是能力水位提升；不写 external-results.json、不改冻结判分器与评测集。
