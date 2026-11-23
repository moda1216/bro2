# bro2 · 深度重写架构方案 v0.1 与风险清单

> 状态：**提案（proposed），未实现**。基于 [REWRITE-BRIEF.md](./REWRITE-BRIEF.md)。
> 原则：**深入而非更大**——复用现有 8 层架构，加厚验证/约束/可回滚骨架，不重造轮子、不放宽预算。
> 源码预算 16500/16500 已满，所有新增逻辑优先落在 `examples/` `data/` `docs/`（豁免目录），
> 必须进 `src/bin/scripts` 的部分走「先删后加、净增为零」。

---

## 1. 现状基线（不推倒重来）

bro2 已有可复用底座，重写是在其上深化：

| 现有层/模块 | 已具备 | 深化目标 |
| --- | --- | --- |
| `kernel/`（loop/runtime/session/trajectory/events/hooks） | Agent 状态机、轨迹日志 | 轨迹质量判据、完整事件流对外可见 |
| `models/`（hybrid/keyless/router/route-experience） | 多端点、学习路由、失败兜底 | 端点失效不污染结果、24G Mac 本地路径 |
| `rsi/` + `meta.ts` + `velocity.ts` | 有界自改进、冻结尺子、复利经验 | 扩展到「模型调优」这一新算子族 |
| `governance/`（approval/audit/guards/permissions） | 权限分级、审批、审计、脱敏 | 策略引擎外置到 agent 不可改面 + 红队 |
| `context/` `observability/` | 预算上下文、tracing/eval | 外部计量、白盒时间线 |
| `interfaces/`（api/cli）+ `web` | REST/SSE、7×24 UI | 统一白盒面板 + 审批闸门交互 |

**判断**：7 特性中 5 项有现成底座，真正缺口是 **#4 本地训练器调度** 和 **#5 统一白盒**，
外加横切的验证骨架强化。**因此方案主体是「加厚 + 接线 + 外置」，不是新建大模块。**

---

## 2. 目标架构：8 层不变，新增两个「横切环」

```
┌─────────────────────────────────────────────────────────────┐
│  L7 交互层   CLI / Web 白盒面板 / SSE 事件流 / 审批闸门 UI      │ ← #5 深化
├─────────────────────────────────────────────────────────────┤
│  L6 治理层   approval · permissions · guards · audit          │ ← #7 外置
├─────────────────────────────────────────────────────────────┤
│  L5 演进层   RSI · meta-RSI · velocity · experience ─┐        │ ← #3 深化
│                                                     ├─▶【环 A】│
│  L4 进化执行  local-trainer 调度 · shadow/A/B/canary ─┘        │ ← #4 新增(薄)
├─────────────────────────────────────────────────────────────┤
│  L3 模型层   router · hybrid · keyless · local(MLX/GGUF)      │ ← #1 深化
├─────────────────────────────────────────────────────────────┤
│  L2 认知层   plan · skills · preset · context/builder         │
│  L1 内核层   loop · session · trajectory · hooks              │
│  L0 工具层   files/code/system/cognition/orchestration       │ ← #2 复用
└─────────────────────────────────────────────────────────────┘
        ┌──────────────────────────┬──────────────────────────┐
        │ 【环 A】验证与证据环      │ 【环 B】能效与安全环      │
        │ 冻结集·独立判分·CI·      │ 外部计量·硬预算·策略引擎 │
        │ 内容寻址·红队·可回滚      │ ·拦截·审计（外置）        │
        │ 横切所有层，agent 不可改   │ 横切所有层，agent 不可改  │
        └──────────────────────────┴──────────────────────────┘
```

**两个横切环是本次「深入」的核心**：它们不属于任何单层，且必须位于 agent 可修改面之外
（写保护目录 / 独立进程 / CI 门禁），否则自进化会先腐蚀自己的裁判——这正是历史教训。

---

## 3. 分特性落地路径（每条 = 现状 → 深化动作 → 验收 → 落点目录）

### #1 本地自治（24G Mac，免 key 非强依赖）
- 现状：`local-qwen*` 走 Ollama；`keyless`/`hybrid` 已有端点健康态。
- 深化：
  - 新增 24G Mac 的 **MLX / GGUF 量化推理适配器**（落 `examples/` 或独立 `tools/`，不入预算敏感目录）。
  - 端点失败 → 自动降级本地；降级事件写入证据环，**不写 reward**。
- 验收：断网 + 移除所有 key → 跑通既定任务集；端点 8/8 超时下零污染 trial。
- 落点：`examples/mac-local/`（新）、`src/models/hybrid.ts`（仅接线，净增为零）。

### #2 通用助手 + 置信度校准
- 现状：六类 builtins 工具齐备。
- 深化：让 agent 输出**校准置信度**，低置信度主动升级人工/换本地重试。
- 验收：真实任务分布上通过率与置信度双达标；低置信样本可追溯。
- 落点：`examples/`（评估脚本为主）。

### #3 轨迹飞轮（已有强底座，系统化）
- 现状：`kernel/trajectory.ts` + `rsi/experience.ts` + `compound.ts`，只增账本、指纹防记忆、OOD 失效。
- 深化：补 **轨迹质量判据**（可复现/正向 delta/非幸运路径）、脱敏、质量分级；失败轨迹同样留痕。
- 验收：每条入库轨迹可追溯来源与 delta；`data/rsi/experience.jsonl` 只增不删。
- 落点：`src/rsi/experience.ts`（深化，等量删减）、`data/rsi/`（账本）。

### #4 自进化训练器调度（最大缺口，做薄不做厚）
- 现状：RSI 只改 harness；无本地模型微调调度。
- 深化：
  - 薄调度器：接收经验池导出的训练样本 → 调用本地 LoRA/QLoRA 训练器 → 产出候选权重（hash 化）。
  - **上线闸门**（核心，必须外置）：`shadow → A/B → canary → rollback`，每步需冻结验证集前后对照 + 显著性检验。
- 验收：无对照的候选一律不晋升；回滚演练一键恢复到上一哈希。
- 落点：`examples/local-trainer/`（新，豁免）；闸门逻辑入证据环，agent 不可改。
- 诚实边界：训练带来的提升必须是 strict delta（同模型权重冻结对照才叫 harness Δ；改了权重就是新模型，须重新锚定）。

### #5 统一白盒面板 + 审批闸门
- 现状：REST/SSE + `data/rsi/watermark.html` 看板（分散）。
- 深化：单一时间线串联「任务执行 / 轨迹沉淀 / 模型进化 / harness 进化」；SSE 推事件；
  关键决策弹审批，用户可人机交互。
- 验收：外部观察者仅凭 UI 重建任意决策链；审批可拦截并留审计。
- 落点：`examples/` 静态面板 + `src/interfaces/api.ts`（SSE 事件补字段，净增为零）。

### #6 能效（外部计量）
- 现状：`context/budget.ts` + `governance/guards.ts` + `models/cache.ts`。
- 深化：计量由系统工具外部采集（powermetrics / 进程 RSS / token 计数），硬预算 + 自动降级。
- 验收：外部测量达标，非 agent 自报；超预算自动降级有日志。
- 落点：`examples/energy/`（新）。

### #7 安全（策略引擎外置）
- 现状：`governance/` 四件套已强。
- 深化：把「隐私 / 系统破坏 / 网络犯罪」的拦截规则移到 **agent 不可修改面**（写保护配置 +
  独立策略检查进程）；提示注入防御；红队测试常态化进 CI。
- 验收：第三方红队注入 / 提权测试通过；规则不在 agent 可写目录。
- 落点：`src/governance/permissions.ts`（深化）、`tests/` + CI（红队）。

---

## 4. 实施阶段（按依赖顺序，不可颠倒）

| 阶段 | 目标 | 出口条件 | 对应环 |
| --- | --- | --- | --- |
| P0 | 证据环与内容寻址地基：冻结集、独立判分、写保护面、只增账本规范 | 独立脚本可从原始数据重算曲线；红队基线建立 | 环 A/B |
| P1 | 本地自治加固：24G Mac MLX/GGUF 适配器 + 端点失效降级不污染 | 断网跑通 + 8/8 超时零污染 | #1 |
| P2 | 轨迹飞轮系统化：质量判据 + 脱敏 + 分级 | 轨迹可追溯 delta，失败留痕 | #3 |
| P3 | 训练器薄调度 + 上线闸门（shadow/A/B/canary/rollback） | 无对照不晋升 + 回滚演练通过 | #4 |
| P4 | 统一白盒面板 + 审批闸门 + 外部能效计量 | UI 可重建决策链；拦截可触发 | #5 #6 |
| P5 | 真实任务分布验证 + 独立第三方复核 | inter-rater 一致、统计显著 | 环 A |

> 顺序不可颠倒：没有 P0 的证据环，P3 的自进化就是在无裁判的情况下改自己——必翻车。

---

## 5. 风险清单（按严重度排序，含缓解与可证伪判据）

| # | 风险 | 严重度 | 触发条件 | 缓解 | 可证伪判据 |
| --- | --- | --- | --- | --- | --- |
| R1 | **自进化腐蚀裁判**（reward hacking / 自确认） | 极高 | 经验池或策略写回冻结判据/尺子 | 判据与尺子写保护、外置；只采信行为对比，不采信自报分 | 尝试改动判据的候选一律被 guard 拒绝（有红队用例） |
| R2 | **mock/失败降级污染成绩** | 极高 | provider 失败回退 mock 被当有效 trial | 失败即 error；防污染检测外置；落盘校验正常退出 | 注入端点故障 → 结果记 error 而非 reward |
| R3 | **上线模型无对照直接替换** | 极高 | 训练候选跳过 shadow/A/B | 闸门强制；无冻结集对照不得晋升 | 无对照候选被闸门拒绝（门禁用例） |
| R4 | **代码预算超支** | 高 | src/bin/scripts 净增 > 0 | 新增落豁免目录；确需入源码先删后加 | `npm run budget:check` 恒绿（16500/16500） |
| R5 | **CI 门禁被改动破坏** | 高 | 改 CLI/条件链致 preflight 卡死或超行 | 改动先本地 `project:status` 全绿再推 | 远程 `ci.yml` run success |
| R6 | **端点间歇失效误判为永久** | 中 | 8/8 超时就换端点丢锚点 | 健康与结果解耦；重试+退避；如实上报 | 区分「端点失效」与「数据污染」，二者不混报 |
| R7 | **24G Mac 本地模型能力不足** | 中 | 量化后小模型完不成复杂任务 | 本地优先 + 免 key 端点可选兜底；置信度低升级 | 真实任务分布上标注本地/云各自成功率 |
| R8 | **白盒≠正确**（展示漂亮但决策错） | 中 | UI 只做可视化不做可审计 | 每事件带来源与哈希，可独立重算 | 外部观察者能仅凭 UI + 原始数据复现结论 |
| R9 | **策略规则在 agent 可写面** | 极高 | 拦截规则放 src/ 被自进化改掉 | 规则写保护 + 独立进程；agent 无写权限 | 红队让 agent 尝试改规则 → 失败且留审计 |
| R10 | **能耗自报失真** | 低 | 用 agent 自报 token 冒充能耗 | 系统工具外部采集 | 自报值与外部测量偏差超阈值即告警 |

---

## 6. 明确不做（范围边界）

- 不放大模型规模、不引入付费 API 强依赖。
- 不在没有独立对照的情况下宣称「能力领先」或 L4 达成。
- 不把 mock / provider_error / 被中断 trial 计为有效成绩。
- 不为新功能放宽代码预算或削弱既有门禁。
- 不重写已工作的 8 层架构；只深化与接线。

---

## 7. 诚实边界

- 本方案是 v0.1 提案，所有能力状态 `planned`，零实现、零验证。
- 当前评测仍是 partial（9/267）、自跑非第三方、`verdict=not-proven`、`L4=not-achieved`；
  重写不改变这些事实，除非有独立复核证据。
- 「深入而非更大」的操作化定义：**骨架更厚（验证/约束/可回滚）、源码不增、能力靠接线与深化**。

---

## 8. 下一步

1. ~~评审方案与风险清单~~（已确认：接受预算满额先删后加、P0 优先）。
2. ~~从 P0 开工~~（已完成，见 §9）。
3. 每一阶段出口条件未达成则不进入下一阶段，并如实记录未达成项。

---

## 9. P0 实施记录（v2.36.0 · 已完成）

> 出口条件：独立脚本可从原始数据重算曲线 + 红队基线建立。两项均已达成并接入发布门禁。

### 9.1 三个外置工具（均在 `examples/`，源码零增）

| 脚本 | npm 命令 | 职责 | 验证结果 |
| --- | --- | --- | --- |
| `examples/evidence-recompute.ts` | `evidence:recompute` | 不 import 运行时尺子，独立重声明冻结常量与 IPA 公式，从 `velocity.jsonl` 重算曲线并与 `watermark.json` 交叉对照 | 独立趋势=运行时趋势；字段 **8/8**、逐点 **14/14** 一致 → `independent-agrees-with-runtime` |
| `examples/content-address.ts` | `content:address` / `content:verify` | 对冻结面 21 + 账本 4 + 配置 1 共 26 文件生成 SHA256 manifest；`--verify` 检测篡改漂移 | 正常校验通过；篡改注入测试检出 1 处漂移（rc=1） |
| `examples/redteam-baseline.ts` | `redteam:baseline` | 用真实治理模块跑路径逃逸/高危命令/密钥脱敏/权限越级/尺子完整性 5 类对抗 | **13/13** 用例通过 → `baseline-green` |

### 9.2 关键设计落实

- **裁判外置**：独立重算与内容寻址清单都不 import 运行时尺子/写保护模块，避免自进化改裁判放行自己（对应 R1/R9）。
- **inter-rater**：曲线可信 = 独立实现与运行时一致；分歧即 FAIL（可证伪）。
- **门禁接线**：`evidence`、`redteam` 作为第 25、26 道阻断门禁接入 `project:status`；`content:verify` 因账本增长会漂移，仅作独立命令不作门禁。
- **预算守恒**：`project-status.ts` 加 2 门禁行的同时压缩 2 行注释，源码净增 **0**，维持 16500/16500。

### 9.3 验证证据

- `npm run budget:check`：16500/16500 通过。
- `npm run project:status`：**26/26 阻断门禁 + 2/2 信息项**，EXIT=0。
- 报告落盘：`data/evidence/{recompute-report,content-manifest,redteam-baseline}.json`。

### 9.4 诚实边界

- 三工具证明的是「运行时水位可被独立复核」「已知攻击被拦截」「文件未被篡改」，**不是**能力分数或「领先」证据。
- 红队是已知攻击模式的基线，不证明未知攻击不可绕过；需定期补用例。
- 内容寻址对账本漂移的语义=「提示核对 git 只增历史」，而非「账本不得增长」。
- `verdict=not-proven`、`L4=not-achieved` 不变。

### 9.5 下一步（P1）

见 §9.6——已完成，入口条件由 P0 满足。

---

## 9.6 P1 实施记录（本地自治加固 · 已完成）

> 出口条件：**断网跑通 + 8/8 超时零污染**。两项均已由外置脚本实证，接入第 27、28 道发布门禁。

### 9.6.1 两个外置工具（均在 `examples/mac-local/`，源码零增）

| 脚本 | npm 命令 | 职责 | 验证结果 |
| --- | --- | --- | --- |
| `examples/mac-local/adapter.ts` | `mac:local` | 24G 统一内存第一性原理预算（权重=params×bits/8，KV=2·layers·ctx·kv_heads·head_dim·2B）+ MLX/GGUF 两条可复制启动配置 + 断网/无key 契约校验 | 预算 **11/11**：7B Q4_K_M=5.97G fits，32B Q4=21.97G / F16=66.57G **not-fits**（可证伪自检成立）→ `contract-green` |
| `examples/mac-local/failover-proof.ts` | `failover:proof` | A strict 8/8 超时零污染；B non-strict 可证伪对照；C 断网本地闭环；D 证据环防污染判定 | **4/4**：A 8/8 error+0 reward；B 降级到 mock 但被证据环拦截；C completed+原生 tool_calls；D 6 类判定自洽 → `zero-pollution-proven` |

### 9.6.2 关键设计落实

- **可证伪性而非恒真**：预算模型必须判出「32B 装不下 24G」，否则自检失败（防止一个永远说 yes 的假预算）；故障注入必须显示「关掉 strict 就会污染」，否则 strict 闸门是哑弹（B 场景）。两条都是「证明机制真的动了」而非摆设。
- **两条后端路径具体化**：MLX（`mlx_lm.server`，Apple Silicon 原生）与 GGUF（`llama_cpp.server`，Metal），各自含启动命令 + provider 配置片段；强制注入两条项目一手教训——`n_ctx≥4096`（system+tools≈3700 tokens）、llama.cpp function-calling 必须 `stream:false`（stream:true 抛 ValueError）。
- **防污染判定加宽（P1 实测发现）**：`tb21-batch.py` 原只匹配 agent 终答里的中文标记「离线 Mock 模型驱动」，但该标记仅在 loop 写出终答时才出现；泄漏最早发生在 provider 单步响应处。证据环加宽为优先认机器可读的 `provider=mock` 字段。**本版不改评测脚本**（避免动冻结流程），建议 P2 回填。
- **失效与污染分离（R6）**：端点失效=`provider_error`（基础设施问题），数据污染=`mock 计分`（诚实红线），二者分开记录、互不混报。
- **预算守恒**：两门禁接入 `project:status` 的同时压缩 2 行注释，源码净增 **0**，维持 16500/16500。

### 9.6.3 验证证据

- `npm run budget:check`：16500/16500 通过。
- `npm run project:status`：**28/28 阻断门禁 + 2/2 信息项**，EXIT=0。
- 报告落盘：`data/evidence/{mac-local-plan,failover-proof}.json`。

### 9.6.4 诚实边界

- 两工具证明的是「预算可复算 + 配置自洽 + 断网链路可跑通 + 错误分类与计分闸门正确」，**不是**能力分数或「断网能完成 89 题」的证据。
- C 场景是 OpenAI 兼容协议仿真（本沙箱无 Ollama/GPU/Apple Silicon），非真机能力证明。
- **未测实测缺口**（REWRITE-BRIEF §3 一手素材）：具体 Mac 型号上 MLX/llama.cpp 的 tokens/s、峰值内存、量化精度损失——须真机执行生成命令后回填。
- 红队/证据环仍是已知模式基线；`verdict=not-proven`、`L4=not-achieved` 不变。

### 9.6.5 下一步（P2）

轨迹飞轮系统化：质量判据（可复现/正向 delta/非幸运路径）+ 脱敏 + 分级 + 失败留痕，并回填 P1 发现的 `provider=mock` 判据到 batch 判定入口。

---

## 9.7 P2 实施记录（轨迹飞轮系统化 · 已完成）

> 出口条件：**轨迹可追溯 delta，失败留痕**。均由外置脚本实证，接入第 29 道发布门禁。

- **工具**：`examples/trajectory-flywheel.ts`（`npm run flywheel:check`），读真实 `data/rsi/experience.jsonl`(29条) 与 `velocity.jsonl`(14条)，调真实 `ExperienceBank`/`Trajectory`/`redact`/`behavioralContrast`。
- **三维分级**：可复现（净成功且未失效）+ 正向 delta（全局 IPA 代理）+ 非幸运路径（≥2 次成功）→ gold/silver/bronze/rejected。`globalIPA` 与分级分布落 `data/evidence/trajectory-flywheel.json`。
- **失败留痕**：验证 seq 连续无缺口、全部 failure 事件带 signature/prescription/source 可追溯（失败同样入库）。
- **判据回填**：P1 发现的 `provider=mock` 机器字段优先判据已固化，6 类响应逐一验证。本版**不改冻结的 tb21-batch.py**，仅提供可引用判据（避免动冻结流程）。
- **可证伪发现（重要）**：初版把「单次成功 + 全局正 IPA」误判为 silver——非幸运路径被正向水位掩盖，分级退化成恒真。已要求 gold/silver 均满足 nonLucky 后修正。这是可证伪对照抓出的真实缺陷，非走过场。
- **诚实边界**：分级是经验质量启发式审查，非能力分数；逐条因果 delta 无 signature 维度真值，以全局 IPA 代理并标注。`verdict=not-proven`、`L4=not-achieved` 不变。

## 9.8 P3 实施记录（训练器薄调度 + 上线闸门 · 已完成）

> 出口条件：**无对照不晋升 + 回滚演练通过**。接入第 30 道发布门禁。

- **工具**：`examples/local-trainer/promotion-gate.ts`（`npm run promotion:gate`），7/7 绿。
- **薄调度**：只读导出经验池成功样本 → hash 化（不编码答案/id）→ 确定性派生候选权重 hash + 训练命令契约。本沙箱无 GPU/LoRA，**不执行训练、不产出假权重/假分数**。
- **上线闸门**：`shadow → A/B → canary → promoted` 状态机，仅采信冻结验证集前后对照 + 显著性，`scoreGain` 只进审计不进判定。无对照 / holdout·OOD 退化 / 不显著一律 rejected。
- **可证伪**：F1 无对照必拒、F2 自报提升无对照（reward hacking）必拒、F3 退化必拒、F4 回滚精确恢复到上一 hash。正例三级晋升链走通。
- **诚实边界**：权重改动即新模型须重新锚定，训练提升不得伪装成 harness Δ；显著性由 P5 外部统计器提供，不自造 p 值。`verdict=not-proven`、`L4=not-achieved` 不变。

## 9.9 P4 实施记录（统一白盒面板 + 审批闸门 + 外部能效 · 已完成）

> 出口条件：**UI 可重建决策链；拦截可触发**。接入第 31 道发布门禁。

- **工具**：`examples/whitebox-panel.ts`（`npm run whitebox:panel`），6/6 绿；产物 `data/evidence/whitebox-panel.json` + `docs/WHITEBOX-PANEL.html`（自包含静态面板，数字读自 evidence JSON）。
- **单一时间线**：真实 `EventBus` + Event 协议把「任务执行 / 轨迹沉淀 / 模型进化 / harness 进化」四 lane 串成一条带 seq/ts 的链。
- **可重建（R8）**：外部观察者仅凭导出事件流独立重建决策链；F1 篡改 payload 后重建必须检出不一致（防「展示漂亮但决策错」）。
- **审批闸门**：真实 `ApprovalManager`（autoApprove=false）发起→resolve(deny)，F2 验证 deny 生效且留 ApprovalRequest/ApprovalResolved 审计事件；审计密钥经 `redact` 脱敏。
- **外部能效（R10）**：真实进程 RSS + 系统侧 token 计数（外部采集）对比 agent 自报；F3 自报偏低超阈值触发告警。
- **诚实边界**：RSS 为真实测量，token 计数为外部采集仿真（本沙箱无 powermetrics/Apple Silicon）；SSE 实时推送、真机能耗未测。`verdict=not-proven`、`L4=not-achieved` 不变。

## 9.10 P5 实施记录（统计骨架 + 第三方复核 · 已完成）

> 出口条件：**inter-rater 一致、统计显著**。统计骨架达成；**显著性与第三方复核如实未达成**。接入第 32 道发布门禁。

- **工具**：`examples/third-party-review.ts`（`npm run thirdparty:review`），4/4 绿。
- **inter-rater**：`Cohen's kappa` 衡量 verifier 判定（verifyNote rc=0）与落盘 reward 一致性；F1 全一致 kappa=1、F2 全相反 kappa<0 验证边界（防恒真正例）。
- **配对显著性**：`McNemar 精确二项检验`用于配对二分类，p 值可复算；即使 p<0.05，样本不足也不宣称显著。
- **功效审计（核心诚实）**：真实评测仅 **9/267（partial）**，远小于检出中等效应所需 n≈64/组；F3 强制判「功效不足，不得宣称显著」。
- **诚实边界**：无独立第三方标注，verifier 与 reward 非真正独立评分者，kappa 仅作一致性体检；不宣称显著性/榜单分数/能力领先/L4。`verdict=not-proven`、`L4=not-achieved` 不变。

## 9.11 重写阶段总览

| 阶段 | 出口条件 | 外置工具 | 门禁 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | 独立重算 + 红队基线 | evidence-recompute / content-address / redteam-baseline | 25–26 | ✅ 达成 |
| P1 | 断网跑通 + 8/8 零污染 | mac-local/adapter / failover-proof | 27–28 | ✅ 机制达成（真机实测缺口待回填） |
| P2 | 轨迹可追溯 delta + 失败留痕 | trajectory-flywheel | 29 | ✅ 达成（delta 为代理） |
| P3 | 无对照不晋升 + 回滚 | local-trainer/promotion-gate | 30 | ✅ 闸门达成（真实训练未测） |
| P4 | 决策链可重建 + 拦截可触发 | whitebox-panel | 31 | ✅ 达成（真机能耗/SSE 未测） |
| P5 | inter-rater 一致 + 统计显著 | third-party-review | 32 | ⚠️ 骨架达成；**显著性/第三方复核未达成（n=9/267）** |

> 全阶段恪守「深入而非更大」：源码净增 0（16500/16500），新增逻辑全部落 `examples/`/`data/`/`docs/` 豁免目录，门禁接线等量压缩注释抵消。
> 所有阶段均不产出能力分数；`verdict=not-proven`、`L4=not-achieved` 不因重写改变。P5 的统计显著与第三方复核是真实未完成项，须待 89×3 全量完成 + 独立标注后方可评估。

---

## 9.12 外部调度迁移（89×3 真实评测的常驻化 · 决策记录）

### 问题（二次实证）

沙箱内后台 supervisor 两次随会话休眠被回收：心跳停在启动后约 8 分钟，`break-filter-js-from-html-r3` 容器 `Exited (255)`，进度始终 9/267。根因不是进程崩溃（supervisor 自愈循环可处理），而是**承载进程的整个沙箱被冻结**——任何沙箱内后台任务在会话结束时必然死亡。此前"三层机制对抗会话重置"的判断过于乐观，此处更正。

### 决策：迁移到 GitHub Actions cron

用户选择「上外部调度器真常驻」。落地为 `.github/workflows/bench-external.yml`：

- **调度**：`schedule` cron `17 */6 * * *`（每 6h）+ `workflow_dispatch`（手动，可传 `limit`）。
- **单次预算**：`--limit 6`（ovhcloud 2 req/min 下约 3-4h），`timeout-minutes: 350` 留余量，`concurrency: external-bench` 防并发重复计分。
- **跨会话持久化**：结果 `tb21-full-results.jsonl` + 心跳 commit 回 `main`——GitHub 仓库是跨会话唯一事实源，替代易失的沙箱文件系统。
- **诚实红线不变**：不写 external-results.json、不改评分器/源码/verdict；mock/provider_error 仍判 error 不计分；心跳 `verdict=not-proven`。
- **预检**：每轮先探 ovhcloud 端点（HTTP 200 + model=gpt-oss-120b 身份核实），不可用则告警、整批 error 不计分。

### 诚实边界

- 外部调度的常驻性依赖 GitHub Actions 服务可用性；免费公开仓库有 cron 调度延迟（高峰可能延后数十分钟），非精确实时。
- 全量 267 trial 在 2 req/min 下仍需累计 100+ 小时，跨数十个 cron 周期；`verdict=not-proven`、`L4=not-achieved` 在 267/267 由独立复核前不变。
- `examples/tb21-supervisor.sh` 保留为「单会话内手动批量续跑」的补充工具，主路径已是 GitHub Actions。
