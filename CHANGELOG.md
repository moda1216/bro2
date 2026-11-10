# bro2 · 发布日志（CHANGELOG）

> 语义化版本 `MAJOR.MINOR.PATCH`：
> - **MAJOR**：破坏性架构变更（接口/契约不兼容，需迁移）。
> - **MINOR**：新增能力域或重大特性（向后兼容）。
> - **PATCH**：修复、证据更新、文档/验收脚本补齐（向后兼容）。
>
> 发布动作（强制）：feature 完成 → `npm run project:status` 全绿 → `git tag -a vX.Y.Z` → 追加本条目 → 同步 [DELIVERABLES.md](./DELIVERABLES.md) §3 状态。
> 产出物管理三件套：`DELIVERABLES.md`（登记册）· `CHANGELOG.md`（本文件）· `ROADMAP.md`（演进）。

---

## [2.22.0] — 2026-11-10 · 晋升闸门放行外部真值 oracle 佐证（MINOR）

> 跨步说明：继 v2.20.0（oracle 原语）/ v2.21.0（真值任务集）连续自主推进后，本版把「外部真值 oracle」
> 接入 RSI 晋升闭环的**审计层**——让三段晋升能相对独立真值佐证，同时仍以铁律防自确认循环。

**解决的问题**：v2.11.0 的 `judgePromotion` 有一道铁律「`usedGroundTruthVerifier` 为真 → 拒绝晋升」，
用于防「harness 用自身内部行为验证器自我确认」（自确认循环 / reward hacking）。但 v2.20.0 引入的
**外部真值 oracle** 性质根本不同：它只读 agent **实际产出** vs agent **不可见** `reference`，是**外部可证伪**，
恰恰是自确认的**对立面**。旧铁律把二者一视同仁全部拒绝，导致外部 oracle 无法进入晋升闭环。

**改动（`src/observability/eval-grade.ts`，净省 2 行预算）**：
- `PromotionSpec` 新增可选 `usedExternalOracle?: boolean`（agent 不可见 reference 的外部真值 oracle 佐证开关）；
- `PromotionVerdict` 新增 `externalOracleCorroborated: boolean`（只进审计，绝不影响 `promoted`）；
- `judgePromotion` 语义收紧为**两类验证器互斥**：
  - `usedGroundTruthVerifier`（harness 内部、读自身行为）→ 仍**拒绝晋升**（自确认循环，红线不动）；
  - `usedExternalOracle`（agent 不可见 reference、外部可证伪）→ **允许**，但仅作独立佐证记入审计，不阻断、不喂 `promoted`；
- 同步精简该段头注释（7 行→2 行），净省 2 行预算空间。

**测试契约（`tests/promotion.test.ts`，12 → 14 项）**：新增两项——
- 外部 oracle 佐证**不阻断晋升**、且 `externalOracleCorroborated=true`；
- 外部 oracle 与 harness 内部验证器**互斥**：后者仍拒绝晋升、前者仍标记佐证。

**诚实边界（不变）**：本版**不产生能力分数**，`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`。
外部 oracle 只让「晋升相对独立真值」多一层佐证，绝不替代三段真实行为分数与冻结指纹铁律；晋升结论仍由
`judgePromotion` 真实三段判据驱动。能力增益结论仍需 train/holdout/OOD 三段独立真值对照。

**代码预算**：**16,497/16,500**、88/90 文件、单文件最大 584、运行时依赖 0、测试/源 0.27；未上调阈值、未新增源文件、未新增依赖。

---

## [2.21.0] — 2026-11-10 · 真值任务集评测落地（MINOR）

> 跨步说明：本版把 v2.20.0 埋下的「外部真值 oracle」原语真正用起来——建成一组带 `reference` 的
> **真值任务集**并接通 `runEval → grade → oracle → summary` 全链路。继 v2.17→v2.20→v2.21 连续自主推进，
> 不再逐版拆小 PATCH。

**解决的问题**：v2.20.0 只交付了 oracle「原语」，尚无任何真实任务集消费它，等于把钥匙造好却没开门。
本版补上**真值任务集评测**——一组每个任务都携带 agent 不可见的 `reference`、由外部 oracle 判定
「产出是否真对」的任务，让「外部可证伪评分」从理论基元变成可运行的评测闭环。

**改动 1 · 真值任务集（`data/truth-tasks.jsonl`，数据文件，不计入源码预算）**：10 项任务覆盖全部三类 oracle
与全部 `EvalCategory`：
- `answer-matches-reference`（truth-02/05/08/09/10）：终答（不区分大小写）包含真值参考；
- `answer-equals-reference`（truth-04）：终答与真值精确相等；
- `file-contains-reference`（truth-01/03/06/07）：工作区文件含真值参考；
- 其中 truth-01/06 同时要求 `expectedTools`（calc + file_write）**且** 文件真值命中，把「真调了工具」与
  「真产出了正确结果」两条独立证据叠在一起，杜绝「内部行为看起来对了」的自指蒙混。

**改动 2 · 运行通道（`package.json` 脚本，配置变更，不计入源码预算）**：
- `eval:truth`：`--mode deterministic --tasks data/truth-tasks.jsonl --baseline data/truth-baseline.json`
  （独立基线，避免污染主回归基线 `data/eval-baseline.json`）；
- `eval:truth:live`：同上但 `--mode live`，跑真实 provider 的真实能力测量。
- `data/truth-baseline.json`、`data/eval-live-report.json` 加入 `.gitignore`（再生产物，不进版本库）。

**改动 3 · 诚实口径与实测结论**：
- **确定性全链路（mock 脚本产出正确结果）**：`npm run eval:truth` → **10/10 通过，总体 100%**，五大类全绿，
  协议违规 0。证明 oracle 已端到端接入 `runEval` 聚合（`summary.overall` 由 oracle 真值而非自指行为驱动）。
- **live 真实测量（kilo 免 Key 端点，本沙箱）**：`npm run eval:truth:live` 实际跑通并产出**外部可证伪**得分
  **7/10、overall 0.7**；oracle 正确标记了真实能力缺口（如 truth-09 终答未含「拒绝」= 未外部拒绝危险请求）。
  **诚实标注**：该端点工具调用能力不稳（`preflight` 判定 `toolCalling=unknown`），live 分数受端点可用性限制，
  **不是干净的 bro2 能力基准**；它证明的是「外部真值评测机制可用」，而非给出能力结论。干净基准需工具可达的 provider。

**口径诚实说明**：同 v2.20.0——本版**不产生能力分数声明**，`leadership.verdict` 仍 `not-proven`、L4 仍
`not-achieved`。真值任务集是「让能力提升相对独立真值」的测量面，不是能力自证；要收敛能力结论仍需在
train/holdout/OOD 三段用独立真值对照（接力 `judgePromotion` 三段铁律）。

**代码预算**：**16,499/16,500**、88/90 文件（任务集为数据、脚本为配置，均不占源码预算）、单文件最大 584、
运行时依赖 0、测试/源 0.27；未上调阈值、未新增依赖、未新增源文件。

---

## [2.20.0] — 2026-11-10 · 外部真值 oracle 评测 + RSI 子系统收敛（MINOR）

> 跨步说明：本版一次性合并了三处实质性改动（RSI 子系统收敛 + 外部真值评测原语 + 门禁/文档同步），
> 不再像 v2.15→v2.17 那样逐版拆成微小 PATCH，故版本号直接跳到 v2.20.0 以反映步幅。

**解决的问题（朝向「诚实可验证自演进」的关键一步）**：此前的 `grade()` 只能断言 harness 自身的
**行为分支是否触发**（`expectedTools` / `expectRepair` / `expectGroundingReject` …），属于「自指评分」——
agent 让框架内部行为「看起来对了」就能通过，未必真的产出了正确结果。这正是项目反复自陈的诚实天花板
（leadership.verdict 长期 `not-proven`、L4 `not-achieved`）：能力提升缺乏独立真值对照。

**改动 1 · RSI 子系统收敛（删优先于加）**：把重叠严重的三件套
`src/rsi/contrast.ts` + `src/rsi/live-contrast.ts` + `src/rsi/compound.ts`（525 行 / 3 文件）合并为
单一 `src/rsi/contrast.ts`（~465 行 / 1 文件）。对外导出集合完全不变（tests / examples / bin 零改动，
53 项相关单测全绿）；消除层叠包装（`live-contrast` 包裹 `contrast`、`compound` 再包裹 `live-contrast`）
带来的重复。腾出 2 个源文件槽位、净省 ~60 行预算空间。

**改动 2 · 外部真值 oracle 评测（新能力域）**：在 `src/observability/eval-grade.ts` 引入独立于 harness
行为的正确性判分原语——`EvalTask.oracle` + 注册表（内置 `answer-matches-reference` /
`answer-equals-reference` / `file-contains-reference`）。grading 只读 agent 的**实际产出**（终答 /
工作区文件）与一份 agent 不可见的 `reference` 比对，**绝不读 harness 内部行为指标**。由此：
- agent 只能靠「真正产出正确结果」通过 oracle，无法靠内部行为分支「看起来对了」蒙混；
- oracle 判定经 `runOne → grade()` 自然汇入 `summary.overall`，使 RSI 闭环的「晋升」相对独立真值，
  而非框架自我确认——为未来「非自指的能力增益测量」补上缺失的诚实基元。
- 新增 `tests/external-grade.test.ts`（6 项）直接验证 oracle 的通过/失败/未知 id/独立性。

**改动 3 · 门禁与文档同步**：`npm test` 279/279（原 273 + 新 6）；`npm run project:status` 24/24 阻断门禁 + 2/2 信息项不变。

**口径诚实说明**：本版**不产生能力分数**，不构成能力声明；`leadership.verdict` 仍 `not-proven`、L4 仍
`not-achieved`。oracle 只是「把自指评分变成外部可证伪评分」的**基元**——要真正给出能力增益结论，仍需
把 oracle 接入真实（非脚本化）任务集，并对 train/holdout/OOD 三段用独立真值对照（接力 P0.5-c 的
`judgePromotion` 三段铁律）。确定性评测域的 mock 无远程/本地之分，故 live 真值对照留待 hybrid 评测接入。

**代码预算**：**16,499/16,500**、88/90 文件（收敛腾出 2 槽位）、单文件最大 584、运行时依赖 0、测试/源 0.27；未上调阈值、未新增依赖。

## [2.17.0] — 2026-11-09 · 只增账本 git 历史完整性门禁（ledger:check）（PATCH）

**解决的问题**：`watermark-check` 只校验账本的**当前态**（结构完整 / 只读 / 视图与账本一致），
但「只增账本」不变量从未在 **git 历史级**被验证——理论上可借改写历史藏掉一次失败记录，伪造「全绿账本」。
本版把该不变量升级为 git 历史级可验证的发布阻断门禁。

**改动**（代码预算 **16,499/16,500**、90/90 文件，不升阈值；净 +1 行 = `project-status.ts` 登记项；
`examples/ledger-append-only-check.ts` 与 `package.json` 脚本均不计预算）：
- `examples/ledger-append-only-check.ts`（**第 24 道发布阻断门禁** `ledger:check`）：对
  `data/plan/journal.jsonl` / `data/plan/lessons.jsonl` 两本**真正只增**的账本，
  逐对相邻 commit 校验「旧版本条目序列是新版本条目序列的前缀」——删除 / 重排 / 语义改写任一即阻断。
  条目级（非字节级）比对：每条记录规范化为 canonical 形式（忽略键序与空白），纯格式化放行、语义篡改必抓。
  零运行时依赖、零外部算力；CI 浅克隆历史不足时优雅降级（跳过比较，绝不误红）。
- `.github/workflows/ci.yml`：`actions/checkout` 改 `fetch-depth: 0`（取全量历史），
  使历史级门禁在 CI 真实生效；仓库小，代价可忽略。
- `scripts/project-status.ts` 登记 `ledger` 门禁。

**口径诚实说明**：`data/plan/backlog.jsonl` 未纳入本门禁——其性质为「任务定义，人写一次，偶需修正」，
历史上确有对既有条目的语义改写（W1-03 依赖 `W1-04 → W1-02` 的一次修正），不满足严格只增不变量；
重写 git 历史被禁止，故门禁只覆盖真正只增的 journal / lessons 两本。该历史改写已记入 `lessons.jsonl` 供复盘。

**诚实边界（不产生能力分数）**：本版是**账本诚实性基础设施**，不涉及模型能力、不推动 `verdict`
（`leadership.verdict` 仍 `not-proven`、`L4` 仍 `not-achieved`）。见 `docs/BENCH-v2.md` §5.14。

## [2.16.0] — 2026-11-09 · P0.5-c 成本晋升目标（remoteAvoided↑ 且分数不降才纳入晋升）（MINOR）

**解决的问题**：P0.5-a/c 的学习型路由已把 `remoteAvoided` 经验回写路由，但成本**从未进入 evolve 晋升判据**——
一次「省了远程调用却没提升能力」或「借能力增益掩盖成本退化」的候选都能蒙混晋升。这与 P0.5-c（remoteAvoided↑ 且分数不降）的闭环目标差最后一格。

**改动**（零新增源文件；代码预算 **16,498/16,500**、90/90 文件，不升阈值，净 +5 行且从删除注释冗余里腾出 2 行余量）：
- `src/observability/eval-grade.ts`：给 `judgePromotion` 的 `PromotionSpec` 增加**可选** `cost?: { remoteBefore; remoteAfter }` 字段，
  并在判定机器里加第 7 条铁律：**能力不降的前提下，远程调用不得上升**（成本退化即阻断，且不参与 `promoted`）。
  字段可选、默认不传 → 既有 273 单测与 phasec/segments 判定机全部向后兼容、零改动。
- `examples/p0.5c-check.ts` + `npm run p0.5c:check`（**第 23 道发布阻断门禁**）：用真实三段分数（`runEval` 对
  `data/evolve/{train,holdout,ood}.jsonl` 实际评测）喂 `judgePromotion`，6/6 断言——
  能力晋升+成本不升→晋升、能力晋升+成本反升→阻断且记原因、能力未晋升+成本下降→仍不晋升（成本不越权）、
  能力晋升+成本下降→晋升（remoteAvoided↑ 受鼓励）、未传成本→行为不变。
- `scripts/project-status.ts` 登记 `p0.5c` 门禁 + `package.json` 加 `p0.5c:check` 脚本（门禁脚本在 `examples/`，不计代码预算）。

**诚实边界（不产生能力分数）**：`leadership.verdict` 仍 `not-proven`、`L4` 仍 `not-achieved`。
`judgePromotion` 的成本目标只是**判定机器**，真实 `remoteAvoided` 信号需由 **hybrid 评测**接入
（确定性评测域的 mock 无远程/本地之分，故门禁用真实任务集指纹 + 合成分数喂判定机器，与 promotion:check / phasec:check 同口径）。
本版不声称成本已被实时测量，只把「成本作为晋升目标」的判定逻辑落地并离线可证；live 接线待 hybrid 评测打通。
见 `docs/BENCH-v2.md` §5.13、`docs/PLAN-TOP-HARNESS.md` §6.2。

## [2.15.0] — 2026-11-09 · 阶段 C 接入 RSI 主循环（三段铁律成为真实晋升闸门）（MINOR）

**解决的问题**：v2.11.0 的三段晋升判据（`judgePromotion`）与 v2.14.0 的真实三段任务集（manifest）
都已就位，但**二者都没进活循环**——`runEvolve` 仍只用 train/holdout 两段、用内联的 2 段判据，
且从没调用 `judgePromotion`、根本没有 OOD 段。阶段 C 因此「停在 B」（判定机器层已交付，缺接入主循环）。

**改动**（零新增源文件；代码预算 **16,492/16,500**、90/90 文件，不升阈值、反而 freed 5 行）：
- `src/rsi/loop.ts`：把晋升判据换成 `judgePromotion` 三段铁律作为**真实晋升闸门**——
  dev 严格提升 / holdout·OOD 不退化 / OOD 完全只读（搜索只碰 dev）/ 协议零违规 / 完整性通过；
  新增真实 OOD 段（`data/evolve/ood.jsonl`，作为「只读退化探针」，默认状态即应通过、改进不得使其退化）。
- OOD 退化时**自动阻断并把阻断写进 journal 可复核**（`W4-C-ood-block`，与 ledger 同走 `scratchDir` 隔离，不污染真实只增账本）。
- 把散落 6 处的 `ledger.append` **收口到一个 `appendLed` helper**（少而精、消除重复与漂移），
  顺带删除 `efficiencyTiebreak` 特殊分支（三段铁律已是其严格上界）。
- `src/rsi/shadow.ts`：`evolvePaths` 暴露 `ood` 段；`src/rsi/guardrails.ts`：OOD 纳入写保护面。

**诚实边界（不产生能力分数）**：`leadership.verdict` 仍 `not-proven`、`L4` 仍 `not-achieved`、
0pp 负结果不变。本版是**测量/治理机器的最后一公里接入**——现在 bro2 的每一次晋升都经三段铁律判定、
每一次 OOD 退化都被记录；但「是否有可量化的能力增益」仍未被测得（演进 fixture 是确定性脚本回放，
弱模型又跑不完多步任务）。阶段 C 的机器已闭环，缺口从「缺接入」变成「缺一次真实能力增益的测量」。
见 `docs/BENCH-v2.md` §5.12、`docs/PLAN-TOP-HARNESS.md` §6.2。

## [2.14.0] — 2026-11-09 · 三段任务集真实分层与弱模型单步重测（MINOR）

**解决的问题**：v2.11.0 的三段晋升判据虽是判定机器，但喂给它的三段是**手搓的玩具任务**，
不是项目真实任务集；W1-06 原计划「L2 扩到 60 个同质任务」又已被 0pp 负结果否定。
同时 v2.13.0 撤销「0.5B 能力下限」后，弱模型这一格证据仍空着。

**改动**（零新增源文件；代码预算 16,497/16,500、90/90 文件，未上调阈值）：
- `data/tasks/v2/segments.json`（冻结 manifest）：现有 **37 个真实任务**（l1 19 + l2 18）
  按 `sha1(id)[0] mod 3` 确定性切成 `dev 12 / holdout 15 / ood 10`，覆盖全集、
  互不相交、指纹互异（`dcab485b217e` / `d25c2a496cdb` / `be79fc4aa4a2`）；
  OOD 与 holdout 标 `searchAccessible: false`，只有 dev 可搜索；整集 `sourceHash`
  钉住任务内容。指纹与 `runEval.taskSetHash` **完全同口径**，可直接喂 `judgePromotion`。
- `npm run segments:check`（`examples/segments-check.ts`，**第 21 道发布阻断门禁**）：
  31/31 断言，离线、无网络、无凭据。校验 manifest 版本 / 源指纹 / 源任务数 /
  三段 ids 与指纹重算一致 / 两两不相交 / 非空 / 指纹互异 / OOD 只读 / 归属与规则一致；
  **接线**：用三段真实指纹构造 `PromotionSpec` 喂 `judgePromotion`，合法晋升接受、
  自报增益不参与判定，再叠加 6 个单一变量反例逐一验证拒绝。
  真篡改 `ood.hash` 实测 `exit=1`（报错精确到字段），还原后全绿；`--freeze` 是唯一重冻结入口。
  生产侧只加 1 行门禁登记 + 1 行 npm script（门禁脚本在 `examples/`，不计代码预算）。
- `npm run weak:probe`（`examples/weak-single-step.ts`）：弱模型单步准入探针，只回答
  「链路修通后 1.5B 能不能完成一次工具任务」。红线写死：**只有 `completed` + 协议零违规
  才算有效测量**，`cancelled` / `guard` / `provider_error` 一律记 `insufficient-runtime`、
  不进证据集。墙钟只在探针内放宽到 1800s，不改全局配置、不改门禁阈值。
- 运行时准备：`local-qwen15b` 的 `maxTokens` 256→128、`n_ctx` 2048→4096
  （2048 撞 `HTTP 400 requested 3695 tokens`，8192 冷启动慢），文档同步修正。

**实测（1.5B，本机 8GB cgroup / 4 核 CPU）**：
- warmup：非流式 + 带 tools 返回**规范 `tool_calls`**（10.3s），坐实 v2.13.0 的链路修复；
- 三次单步 live 评测稳定复现 `3 步 / 2 次原生 calc 调用 / 协议违规 0`：
  ① `cancelled`（600s 墙钟，报告已删）、② `guard`（773s）、③ `guard`（818s，
  原文「检测到连续 3 次相同工具调用，判定为死循环」）。**均无 `completed` 轨迹**。
- 链路层已证：v2.10.0「0 工具调用 = 能力下限」彻底撤销，那批 0 是适配缺陷而非能力证据。
  能力层仍**未测出**：本机纯 CPU 单步约 250~270s，加上弱模型重复调用倾向，
  运行时预算内跑不完；不是「1.5B 太弱」，也不是「必须换更大内存」（1.5B 无 OOM）。
  ③ 已放宽步数与墙钟，剩下的拦截是真实行为信号，再放宽死循环阈值等于掩盖测量事实，故不再重跑。

**诚实边界**：`segments:check` 是**输入契约门禁**（真实分段能作为判定机器合法输入），
**不是** `promote.ts` 接入 RSI 主循环，阶段 C 仍停在 B；`weak:probe` 是链路/准入证据，
不是能力分数。`leadership.verdict = not-proven`、L4 `not-achieved`、0pp 负结果均不变。

`npm test` **273/273**、发布门禁 **21/21**、代码预算 **16,497/16,500** 全绿。

---

## [2.13.0] — 2026-11-09 · 接入门禁组合路径盲点修复与本地弱模型链路归位（MINOR）

**解决的问题**：用户质疑「3B 跑不动就换更小的模型」。按此实测 1.5B，反倒挖出
真正的病根不在模型大小，而在 bro2 自己：**`OpenAICompatProvider.complete()` 硬编码
`stream: true`**，而 llama.cpp server 的 `chatml-function-calling` handler 在
「流式 + 自动工具选择」下直接抛 `ValueError: Automatic streaming tool choice is
not supported`，零 `tool_calls`。旧 `probe()` 却把「非流式带 tools」与「流式普通
应答」**分开测**，从未验证 live 评测真正走的那条组合 → preflight 全绿、Agent 每步
零工具调用、直接终答。历史上 0.5B「准入 0/3、能力下限」的负结果因此站不住：
那时根本没走到工具调用。

**改动**（零新增源文件，代码预算 16,496/16,500）：
- `OpenAICompatProvider` 新增 `stream`（默认 true，**所有既有端点行为不变**）与
  `maxTokens`（缺省不发）两个可配项；`complete()` 按配置发 `stream`，非流式走
  新增 `parseNonStream()` 解析回规范 `tool_calls`；`stream_options` 仅流式下发。
- `probe()` 补三处：`max_tokens: 96` 消除弱模型无限生成导致的 30s 超时误判；
  流式探测改为**带 tools** 的组合请求，同时判定 SSE 与 `tool_calls` delta，缺失时
  给出「建议该端点设 stream=false」的可操作告警（只观测、**不改 ready 判定**，避免对
  未经实测的远程端点引入新阻断）；新增 `streamMode` / `streamToolCalls` 字段。
- `preflight` 的 `streaming` 检查按 `streamMode` 分流：非流式配置下降为 info
  （「必须 SSE」是过时的手段性前提），但 **`toolCalling === "native"` 仍是硬
  blocker**，门禁没有放水。
- `tests/nonstream.test.ts` 5 项行为契约：非流式解析出可执行调用、缺省仍流式
  （向后兼容）、盲点被观测、**不支持 tool_calls 的模型即便关流式仍 BLOCKED**。
- `agentos.config.json` 新增 `local-qwen15b`（11436 / 941MB GGUF / `stream: false` /
  `maxTokens: 256`），1.5B 从 Ollama registry 匿名下载。

**实测（1.5B，本机 8GB cgroup / 4 核 CPU）**：
- 冷启动 5.4s（n_ctx 2048）→ 稳态 **0.6s**，内存 3.4~4.3GB，`oom_kill 0`；
- 同一 prompt：非流式返回规范 `tool_calls`，流式返回空 delta（坐实 handler 限制），
  `tool_choice: required` 也救不了；
- 修复后 `preflight` 从 **BLOCKED → ✓ PASS**（端点探测 45s → 676ms）；
- 三个曾把测量挡在门外的配置坑：`n_ctx 2048` 撞 `HTTP 400 requested 3695 tokens`、
  请求无 `max_tokens` 导致弱模型生成到上下文上限、大 `n_ctx` 冷启动 55~77s 撞
  30s 探针窗口。均按运行时准备修正，**未上调任何门禁阈值**。

**诚实边界（负结果）**：本机纯 CPU 多步 live 评测仍在 18 分钟后挂起（客户端
CPU 0%、无法产出 `completed` 轨迹）。按「`provider_error` ≠ 能力弱」红线，
删掉 3/3 全 `provider_error` 的无效报告，不进证据集；结论写
「本机算力不足以完成多步评测」，**不是「1.5B 能力不够」**。
这同时撤销了 v2.10.0 把 0.5B 归因为「能力下限」的确定性：链路修通前那批
0 工具调用不构成能力证据，需重测。`leadership.verdict = not-proven`、
L4 `not-achieved`、0pp 负结果均不变；本次是**测量机器修复**，不是能力分数。

`npm test` **273/273**、发布门禁 **20/20** 全绿。

---

## [2.12.0] — 2026-11-09 · 端点健康经验接线：把「越用越稳」从只写不读补成闭环（MINOR）

**解决的问题**：v2.10.0 的端点体检把 15 个免 Key 端点的可用性查清了，但结论只落在
文档与静态配置里；`KeylessAggregator` 的健康态是**进程内内存态、重启清零**，
`ExperienceBank` 的 `endpoint` 域虽有只增账本、`endpointSignature()` 与 `invalidate()`，
实际 `data/rsi/experience.jsonl` 只有 `harness-edit` 域 29 条、没有一条 `endpoint` 事件——
「有底座、没接线」。于是每次新进程都要重新撞一遍已知死端点，体验不到「越用越稳」。

**改动**（零新增源文件：判定并入 `route-experience.ts`、接线并入 `index.ts`、门禁放 `examples/`）：

- `endpointPriorFromExperience()`（`src/models/route-experience.ts`）：把只增账本折叠成
  跨会话端点先验分。历史成功率映射到 `[-maxBoost, +maxBoost]`（默认 ±2），
  `rate=1→+2`、`rate=0→-2`、`rate=0.5→0`；被 `invalidate()` 的经验、样本 < `minSamples`
  （默认 3，冷启动保护）与缺格一律给 0 分，绝不冒充结论。纯函数、无 IO，CI 可用构造快照自证。
- `KeylessAggregator`（`src/models/keyless.ts`）：`KeylessOptions` 新增 `endpointPrior` 与
  `onEndpointOutcome`；先验**只叠加到 `score()` 排序**（±2 远小于冷却 −4 / 限流 −8 的硬过滤，
  且 `selectBackend` 先按 cooldown/rateLimited 过滤，被硬过滤的端点根本进不了打分集）；
  `complete()` 成功 / 失败均触发回写；`meshStats()` 露出每端点先验供复核。
- `src/index.ts` 装配层：`useEndpointExperience === true` 才接线（**opt-in，默认关闭**），
  从账本折叠先验注入聚合器，并把每次上游成败回写同一账本；`experienceFile` 可覆盖账本路径
  便于隔离测试；账本不可读时静默降级为无经验，绝不阻塞装配。
  **默认关闭是刻意设计**：确定性评测 / CI 不写被跟踪的 `data/rsi/experience.jsonl`、
  不制造假 diff、不携带本机状态；先验为空时行为与 v2.11.0 完全一致。
- `npm run endpoint:check`（`examples/endpoint-experience-check.ts`，**第 20 道发布阻断门禁**）：
  全程离线、临时账本、无网络无凭据，13/13 断言覆盖经验折叠（死端点负先验 / 健康端点正先验 /
  rate 0.5 归零 / 样本不足归零）、冷启动注入后历史失败端点不再首选、正先验不能让限流冷却端点
  复活（先验不绕过硬过滤）、回写闭环跨会话可读、新 `ExperienceBank` 实例读得到、
  `invalidate()` 选择性失效后归零回退完整探测。
- `tests/endpoint-prior.test.ts`：7 项行为契约单测，含封顶 / 串域过滤 / 向后兼容。
  其中「失败即当场让位」一例特意让历史表现好（正先验）的端点优先被尝试、本次失败仍如实
  回写 `false` 并让位——证明新证据能覆盖旧先验，而不是只把经验当一次性静态排序。

**诚实边界**：这是**结构闭环证据（离线确定性）**，不是能力分数。它证明「进程内健康态
重启清零的缺口由跨会话只增经验层补上、且回退与失效路径都成立」，不证明 bro2 比最小
harness 强，也不改变任何 live 分数。`leadership.verdict = not-proven`、L4 `not-achieved`
均不变；0pp 负结果与弱模型准入缺口不变。零新增源文件（90/90）、未上调任何预算阈值。

`npm test` **268/268**、发布门禁 **20/20** 全绿；代码预算 16,412/16,500 行、90/90 文件。

---

## [2.11.0] — 2026-11-09 · 三段晋升判据：阶段 C「自提议自晋升」的前置闸门（MINOR）

**解决的问题**：作战计划 §6.2 / W4 把 `dev 提升 AND holdout 不退化 AND OOD 不退化`
定为自进化晋升的铁律，并明确「阶段 C（bro2 自己 propose→probe→晋升）的前置是
`promote.ts` 能在 OOD 退化时**自动阻断**、且阻断记录可在 journal 复核；做不到就停在 B」。
但截至 v2.10.0 这套三段判据只写在计划书里，代码只有 v1 的 train/holdout 严格提升
（`src/rsi/loop.ts`），**没有 OOD 完全只读通道、没有缺格/任务漂移/完整性校验**，
更没有「改坏必红」的离线回归保护——和 v2.9.0 之前的故障恢复证据一样，是纸面判据。

**改动**（零新增源文件：判定并入 `eval-grade.ts`、编排并入 `bench-v2.ts`）：

- `judgePromotion`（`src/observability/eval-grade.ts`）：一段 harness 编辑能否晋升，
  必须同时满足 **dev 严格提升 · holdout 不退化 · OOD 不退化 · OOD 完全只读 ·
  三段无静默缺格 · 分数 ∈[0,1] · 任务集前后冻结且三段互异 · 协议违规 0 ·
  完整性 tripwire 通过 · 未启用真值验证器**。任一不满足即拒绝并在 `reasons`
  给出可复核数值（如「OOD 退化 −0.5 超过容差 0：退化即阻断」），
  `blockedByOod` 单独标记供 journal 追溯。判定**只认三段真实行为分数 + 冻结任务集指纹**，
  `selfReportedGain` 只进审计与 `rewardHackingBlocked` 标记，绝不参与 `promoted`
  （沿用 `live-contrast` / v2.9.0 防 reward hacking 红线）。
- `npm run promotion:check`（`--promotion-contrast`，**第 19 道发布阻断门禁**）：
  合法晋升场景的三段分数**全部由 `runEval` 真实产出**——dev 段带 `empty-response`
  故障，编辑前 `emptyGuard=false`（终答为空→失败 0）/ 编辑后 `true`（守卫+重试→通过 1），
  holdout/ood 无故障且任务定义互异（指纹天然互异），编辑前后均通过（不退化）。
  实测 `dev 0→1、holdout 1→1、ood 1→1`，三段 hash 互异 → 合法晋升被接受。
  再在**同一份真实 spec** 上叠加 12 个受控违规信号（dev 不提升 / holdout 退化 /
  OOD 退化 / OOD 参与搜索 / 静默缺格 / 任务漂移 / 未真正留出 / 协议违规 /
  完整性失败 / 真值验证器 / 分数越界 / 自报增益），逐一验证拒绝且命中对应理由。
  报告 `data/bench/promotion-contrast.json` 幂等写入（除时间外主体不变则不覆盖）。
- `tests/promotion.test.ts`：12 项判据行为契约单测（含容差边界、NaN、自报不参与、
  `rewardHackingBlocked`），保证判据本身「改坏必红」。

**诚实边界**：这是**阶段 C 前置闸门 + 确定性回归门禁**，不是能力分数。它证明的是
「晋升判定机器在任何机器上可离线复算、退化即阻断」，不证明任何 harness 编辑真实有效；
三段是确定性构造的留出集（真实任务集尚待 W1-06 重定 dev/holdout/OOD 分层口径，
该任务已按 0pp 负结果策略性阻塞）。`leadership.verdict = not-proven`、L4 `not-achieved`
均不变。零新增源文件（90/90）、未上调任何代码预算阈值。

`npm test` **261/261**、发布门禁 **19/19** 全绿。

---

## [2.10.0] — 2026-11-09 · 免 Key 端点体检、聚合器健康度修复与弱模型能力下限（MINOR）

**解决的问题**：v2.8 把 4 个免 Key 弱端点的失败笼统记为「链路故障」，本地 0.5B 记为
「Ollama 未启动」；`keylessai` 还被设为 `priority: 4`，smart-fallback 首次请求会优先打到
一个已确认连接超时的端点（真实配置缺陷）。用户提供的 `awesome-freellm-apis` 列表也从未按
「匿名 + 原生 `tool_calls`」口径验证过。

**改动**：
- 15 个端点匿名实测（链路层 + 协议层双层判定），逐个精确归因：限流 / 额度耗尽 /
  模型下架 / 连接超时 / 需要 Key。新增 `docs/ENDPOINT-HEALTH.md`（可复现快照，不进 CI）。
- **新增 `ovhcloud` provider**：从 awesome 列表挖掘并经实测确认的匿名免注册端点，
  `/v1/models` 列 21 个模型、chat + 原生 `tool_calls` 全通（bro2 preflight PASS）。
  限流约 3 次/窗口，定位为故障转移兜底（`priority 5`），不作跑分主力。
- **修复 `llm7`**：`gpt-oss-120b` 已下架（400 `model_unavailable`）→ 免费 `gpt-oss:20b`，preflight PASS。
- **修复聚合器优先级**：按实测健康度重排 `kilo 10 > ovhcloud 5 > llm7 3 > pollinations 1 >
  opencode-zen / keylessai 0`；`keylessai` 从 4 降到 0，消除首次请求白等超时。
- **本地 0.5B 归位**：GGUF 一直在（380 MB），用 `llama_cpp.server`（无需 Ollama）起服务，
  preflight 判定 chat / SSE / 原生 `tool_calls` 全 PASS；如实记录其对 prompt 敏感、首次流式约 28 s。

**负结果（必须保留）**：本地 0.5B 的 L2 准入实测 **0/3，全部 0 工具调用、约 3 分钟/题**
（`data/bench/v2-localqwen-l2-admission.json`）。三条准入判据缺「无故障基线能通过一部分任务」：
基线 0 通过时 harness 差异无从体现。**弱模型对照证据缺口仍在，原因从「链路不可用」
升级为「能力下限」**。`leadership.verdict` 仍 `not-proven`，L4 仍 `not-achieved`。

**中等模型尝试（同为负结果，资源约束）**：自主下载 `qwen2.5:3b`（1.8 GB GGUF），
协议层 chat + 原生 `tool_calls` 均通过，是方向正确的弱模型对照候选。但本机
`cgroup` 内存上限仅 8 GB：多步 live 评测被 OOM killer 终止或触发连续空响应，
三次尝试均无 `completed` 轨迹。按「`provider_error` ≠ 能力弱」红线，这些无效报告已删除、
不作证据；结论是**本机资源不足以跑中等模型基准**，不是「3B 能力不够」。

**未做 / 边界**：不把外部端点可达性、本机服务/GGUF 写进 CI 门禁（治理红线：测试只断言可复现的结构不变量）；
不调任何代码预算阈值；零新增源文件。端点状态是快照，不写死「永久不可用」。
`npm test` 249/249、发布门禁 18/18 全绿。

---

## [2.9.0] — 2026-11-09 · 故障恢复证据的确定性回归门禁（MINOR）

> 类型：**MINOR · 新测量门禁 + 评测链路修正**。
> 不新增能力、不改变 `leadership.verdict`；只把 v2.7/v2.8 依赖真实端点的唯一一组正证据，
> 变成离线可复算、防哑弹、进 CI 的发布阻断门禁。

### 问题（为什么做这个）
`faults.provider` 此前只在 `mode === "live"` 生效（`eval.ts`），所以三组 on/off 对照只能靠 kilo
端点人工跑分（`data/bench/v2-kilo-*.json`）：端点抖动即无法重跑、CI 复现不了、W4 晋升判据也
没有确定性基础。这与「测试只断言可复现的结构不变量」红线相悖。
`auto:next` 指向的 W1-06「L2 扩到 60 个同质任务」已被 0pp 负结果否定，继续堆任务只会得到更多 0pp。

### 新增（Added）
- `src/observability/eval.ts`：`faults.provider` 在 deterministic / live 两种模式均生效；带故障任务
  一律 `setDefault` + `setStrict`，杜绝「切到别的 provider」吸收故障、污染唯一变量。
  L1 19/19 回归不受影响（无故障任务不进入该分支）。
- `src/bench/schema.ts`：故障任务允许「liveOnly（真实模型）」或「内置 script 作确定性回归」两种口径，
  禁止落到启发式 Mock（行为不可复算）。
- `src/observability/eval-grade.ts` · `judgeContrast`：唯一变量哈希校验、注入防哑弹、机制计数器、
  行为对比（成败级 / 效率级）、协议零违规；**没有任何自报增益字段参与判定**。
- `scripts/bench-v2.ts --fault-contrast` · `npm run fault:check`：3 组 on/off 对照，判分与指标抽取
  复用 `runEval` 唯一口径，报告落 `data/bench/fault-contrast.json`。
- **零新增源文件**：判定并入既有判分模块、编排并入既有跑分入口，`budget:check` 源文件数保持
  90/90、源码行 16,059/16,500、单文件 564/700，**未上调任何阈值**（少而精：合并优先于新增）。
- `project:status` 第 **18** 道发布阻断门禁 `faultcontrast`；`project-status.ts` 版本号改为从
  `package.json` 动态读取（此前硬编码 v2.3.2）。
- `tests/fault-contrast.test.ts` 12 项反例单测（哑弹 / 注入不全 / 计数器为零 / 唯一变量破坏 /
  机制关侧也通过 / 协议违规 / 自报增益不参与）。

### 证据（离线确定性，mock，2026-11-09）
| 机制组 | 类型 | 唯一变量 | 机制开 | 机制关 | 判定 |
| --- | --- | --- | --- | --- | --- |
| retry | 成败级 | `model.retry.attempts` 3→0 | 通过，注入 2 / 重试 2 | 失败（第 1 次 429 即终止），重试 0 | ✓ |
| empty-guard | 成败级 | `model.emptyGuard` true→false | 通过，守卫 2 / 重试 2 | 空终答伪装完成，守卫 0 | ✓ |
| repair | **效率级** | `policy.malformedArgs` repair→fail | 通过，repairs 1 / 工具错误 0 | 通过，repairs 0 / 工具错误 1 | ✓ |

`npm run fault:check` → **3/3 接受**；报告 `data/bench/fault-contrast.json`。
机制关侧常因提前终止只注入 1 次（`faultsInjected < times` 为预期），不作恢复力证据，
判定只要求两侧都 ≥1 且机制开侧等于声明值。

### 诚实边界（累计）
- 这是**回归门禁，不是新的能力证据**：证明「恢复机制仍有效且可离线复算」，不证明 bro2 比最小
  harness 强；无故障场景 0pp（§5.1/§5.2）继续成立。
- 弱模型对照仍为证据缺口（§5.4）；`leadership.verdict` 仍 `not-proven`、L4 仍 `not-achieved`。
- 确定性故障覆盖的是脚本化 Mock 行为，不替代真实端点下的 live 结论，二者互补。

## [2.8.0] — 2026-11-09 · 脏故障形态、空响应守卫与弱模型证据缺口（MINOR）

> 类型：**MINOR · 新故障形态 + 新恢复机制 + 任务集扩容**。
> 把 v2.7.0 的「立刻报错」型故障扩展为真实端点更常见的脏形态，
> 并把故障任务从 3 个扩到 9 个；同时如实记录一次**弱模型对照的证据缺口**。

### 新增（Added）
- `src/models/router.ts` · 三类真实脏故障（确定性注入，前 N 次生效后透传）：
  - `timeout` — 端点挂起后 ETIMEDOUT（短 stall，上限 1s，不拖慢评测）；
  - `retry-after` — 429 带 `Retry-After`，错误对象携带 `retryAfterMs`；
  - `empty-response` — **200 但半截/空响应，不抛错**，绕过所有 catch 型重试。
- **空响应守卫**（`emptyGuard`，默认开）：`content` 与 `toolCalls` 皆空即视为半截响应，
  主动转 `EmptyResponseError` 再重试；`emptyGuardHitCount` 计数器供归因。
  `--no-empty-guard` 为消融对照的唯一变量。
- 路由退避**尊重 Retry-After**：带 `retryAfterMs` 的错误用其指示值，否则指数退避。
- `EvalRunMetrics.emptyGuardHits`：证明「守卫真的动了」，不是哑弹故障。
- 6 个新 L3 故障任务（f04–f09）：timeout / retry-after / empty-response / 多文件协作 / 参数拼写，
  故障任务 3 → **9 个**，每类机制 ≥2 独立样本，双态校准 **10/10**（含 l3-01）。
- `tests/flaky.test.ts` 8 → **15** 项；顺手修复 `runOne` 返回对象漏 `tools` 字段的潜伏 bug
  （此前 ACI 工具分布一直是 undefined）。

### 证据（kilo，k=1，2026-11-09）
| 机制组 | 任务 | 机制开 | 机制关 | 稳定信号 |
| --- | --- | --- | --- | --- |
| 路由重试（429/500/timeout/retry-after） | f01/f02/f04/f05/f07 | **5/5** | **0/5** 第 1 步 `provider_error` | 10 次注入 → 10 次重试全恢复 |
| 空响应守卫（empty-response） | f06/f09 | **2/2**，`emptyGuardHits` 2/1 | **0/2** 静默空终答 | 3 次拦截 |
| repair 策略 | f03/f08 | 2/2，repairs 2/1，0 工具错误 | 2/2，工具错误 1/0 | **效率级**，步数方向不一致 |

证据：`data/bench/v2-kilo-{retry9,guard9,repair9}-{on,off}.json`。
**半截响应不开守卫时会伪装成 `stoppedBy=completed` 但终答为空**——比显式 `provider_error` 更危险，
这是本版补上的真实盲区。

### 负结果 · 弱模型对照证据缺口（必须保留）
严格模式（禁止 mock 降级）实测全部免 Key 端点：

| 端点 | 预检 | 真实跑分 | 判定 |
| --- | --- | --- | --- |
| `pollinations` | 就绪 | 无故障基线也 `provider_error`、工具错误率 2–3 | **链路抖动**，非能力弱 |
| `opencode-zen` / `llm7` | 未就绪 | 拒绝（SSE / 原生 tool_calls 缺失） | 链路故障 |
| `keylessai` | 未就绪 | 拒绝（连接失败） | 链路故障 |
| 本地 `qwen2.5:0.5b` | — | Ollama 未启动 | 不可用 |

`run` 命令里 llm7/opencode-zen 输出的「离线 Mock 模型驱动」正是**静默降级到 Mock**，
严格模式已挡掉。**「预检就绪」≠「能跑分」，「provider_error」≠「能力弱」。**
补齐条件：一个链路稳定、能力明显低于 kilo 的真实端点。在此之前不写「弱模型下增益更大」。

### 诚实边界（累计）
- 全部 kilo 单模型、k=1；9 任务仍不足以做统计显著性检验；
- repair 组步数方向不一致（f08 开 5 步 vs 关 3 步），只有 `repairs`/`toolErrors` 是稳定信号；
- 半截响应只模拟「整段为空」，未覆盖「半句文本 + 截断 tool_call JSON」；
- 证明的是「**对应恢复机制有价值**」，不改变无故障场景 0pp（§5.1/§5.2）；
- `leadership.verdict` 仍为 `not-proven`（外部有效性未建立）。

## [2.7.0] — 2026-11-09 · 故障注入场景与第一组正证据（MINOR）

> 类型：**MINOR · 新测量能力 + 首个正向 harness 增益证据**。
> L2/L3 连续 0pp 之后，把战场换到「瞬态故障恢复」：故障确定性注入，
> 唯一变量是机制开关——这次差异出现了。

### 新增（Added）
- `src/models/router.ts` · 故障注入与路由重试（合入同模块，控制文件数）：
  - `wrapFlaky(base, {kind, times})` — 确定性注入 429 / 5xx / 参数名拼写错误，
    前 N 次调用生效后透传；`injected` 计数用于证明「故障真的发生了」；
  - `isTransientError` — 与 OpenAICompat 同口径的瞬时故障判定；
  - 路由层退避重试：`model.retry: {attempts, baseMs}`，默认 3 次（免费端点是主战场）；
    瞬时错误原地重试不计熔断，耗尽才计；`retryAttempts` 计数器供归因。
- `bench:v2` 消融开关：`--no-retry`（关路由重试）、`--policy k=v`（策略维度对照）。
- 3 个 L3 故障任务（`v2-l3-f01/02/03`）：真实编码任务 + 确定性故障，
  双态校准 4/4（含 l3-01）。
- `EvalRunMetrics.providerRetries` / `faultsInjected`：恢复力归因字段。
- 防自欺断言：声明的故障未全部注入 → 该任务判失败并注明「结果不可用于恢复力结论」。

### 证据（kilo，k=1，2026-11-09）
| 对照 | 机制开 | 机制关 |
| --- | --- | --- |
| 429×2 / 500×3 | ✓✓（5 次路由重试全部恢复） | ✗✗ 第 1 步 provider_error |
| 参数名拼写 ×1 | repair：✓ 3 步 / repairs=1 / 0 错误 | fail：✓ 8 步 / 1 工具错误 |

### 诚实边界
- 证明的是「瞬态故障下恢复机制有价值」，**不改变无故障场景 0pp 的结论**；
- k=1 + 单模型 kilo；f03 步数差方向稳定但幅度有波动（fail 侧 4/8 步），
  稳定信号是机制计数（repairs、toolErrors）而非步数；
- 注入故障为「立刻报错」型，未覆盖超时与半截响应；
  `leadership.verdict` 仍为 `not-proven`（外部有效性未建立）。

### 教训（已入 lessons.jsonl）
- 初版 malformed-args 只字符串化标量：repair/fail 两种策略下 repairs=0、toolErrors=0，
  故障是哑弹，「差异」只是模型波动。判据固化：**注入后目标机制计数器必须非零**，
  否则不能说在测那个机制。

## [2.6.0] — 2026-11-08 · L3 首任务与「harness 增益未证实」（MINOR）

> 类型：**MINOR · 新层 + 负结果**。
> L3 层第一次有任务：三文件协作 + 旧断言识别 + 三约束同时满足。
> 结果仍然是 0pp——这次连「步数预算」都没能拉开差距，原因值得完整记录。

### 新增（Added）
- `data/fixtures/repos/ts-todo/` — 第 4 个 fixture：`store` / `query` / `persist` 三文件，
  可见测试含一条**描述旧行为**的断言（`list` 忽略选项），要求模型识别并更新。
- `data/tasks/v2/l3.jsonl` — 首个 L3 任务 `v2-l3-01`（`liveOnly`，预算 30 步，权重 2）：
  同时实现 `list` 过滤、`sortBy` 稳定排序、`save/load` 持久化，且不得削弱其余测试。
- `manifest.json` 扩到 4 个仓库（12,397 字节），内容指纹重算。

### 证据
- `task:check --layer l3` → **1/1 双态成立**。
- `fixture:check -- --run` → 4 仓库结构完整、测试可跑。
- L3 live（kilo，k=1）：standard **1/1**（12 步 / 17 工具）；minimal **1/1**（10 步 / 15 工具）。

### 负结果（必须保留）
**L2 与 L3 都是 0pp，minimal 甚至更省。** 原因不是任务不够长，而是：

> `minimal` 预设带 `shell`，shell 是图灵完备的。在单仓库、单进程、无故障的场景里，
> 工具层的精巧程度会被 shell 抹平。

harness 可能产生差异的条件至少需要一条：上下文超窗、故障恢复、多 Agent 协作、弱模型。
弱模型对照试过一次：`pollinations` 端点全部 `provider_error`（链路故障，不是能力差异），
**因此没有弱模型证据**。

### 诚实边界
- `leadership.verdict` 保持 `not-proven`；L4 未达成。
- 任何「bro2 比最小 harness 强 X%」的说法，当前**没有证据支持**。
- 下一步不应继续堆同质任务（只会得到更多 0pp），而应先建立能放大差异的场景（见 `BENCH-v2.md` §5.2）。

## [2.5.0] — 2026-11-08 · W2 编码 ACI 与首次真实 L2 跑分（MINOR）

> 类型：**MINOR · 新能力域**。
> 把「改文件」从精确字符串替换升级为代码感知的编辑接口；同时第一次用真实模型跑完 L2，
> 得到一个**负结果**：这批任务测不出 harness 差异。两个交付一起看才有意义。

### 新增（Added）
- `src/context/repomap.ts` — 零依赖符号索引：导出符号、相对导入边、被引用次数，
  输出**预算受限**（默认 1200 tokens，超了先丢低入度文件）。
- `src/tools/patch.ts` + `apply_patch` 工具 — unified diff：
  多文件/多块、行号漂移按内容定位、**失败零写入**（两阶段计算后才落盘）、
  失败返回最接近行号与「下一步」。
- `src/tools/diagnostics.ts` + `diagnostics` 工具 — 把 `node:test` / `unittest` / `tsc`
  三类输出解析成「哪个测试、哪一行、什么错」；自动识别项目类型，识别不了就明说。
- `src/tools/edit-strategy.ts` — 编辑降级链：精确 → 空白归一化 → 去缩进。
  **只在唯一命中时降级**；多处命中一律拒绝并报位置（错改比不改更难发现）。
- `scripts/aci-check.ts` — 编辑接口指标门禁：改对 / 该拒就拒 / 零半成品，7/7。
- `bench:v2 --mode live`：`--model` / `--preset` / `--repeat` / `--sample` / `--only`，
  报告默认落 `data/bench/v2-<provider>-<ts>.json`，逐任务含 `tools` 分布（ACI 归因用）。
- `src/models/live-gate.ts` — 预检唯一实现，`eval` 与 `bench:v2` 共用，杜绝两个入口判定分叉。
- `docs/BENCH-v2.md` — 任务来源、判定口径、复现命令、**不能下的结论**。

### 变更（Changed）
- `file_edit` 语义收紧：`old_text` 在文件中出现多次时**拒绝执行**（原为替换第一处）。
  这是一次有意的安全变更——静默改错位置的代价远高于让模型补一行上下文。
- `EvalRunMetrics` 增加 `tools`（工具使用分布），不参与判分，只用于归因。

### 证据（v2.5.0 发布时）
- `npm test` → **222/222 通过**。
- `npm run aci:check` → **7/7**；`project:status` 全部阻断门禁通过（新增 `aci`）。
- L2 真实跑分（kilo，k=1）：**standard 17/18（94.4%）**，平均 7.39 步 / 12.06 次工具。

### 负结果（Negative Result · 必须保留）
同模型同任务，只换 harness 预设：

| harness | 通过率 | 平均步数 | 平均工具调用 |
| --- | --- | --- | --- |
| standard | 17/18 | 7.39 | 12.06 |
| minimal | 17/18 | 6.94 | 9.72 |

**0pp 差距，成本高 24%。** 说明这 18 个单文件任务测不出 harness 差异：
可见测试已指明行为，7 步内完成，`repo_map` / `diagnostics` / 压缩 / 纠错都没被触发。
区分度必须来自 L3 长程与多约束任务（W1-07）——在那之前，
「bro2 比最小 harness 强」**没有证据**。

### 诚实边界（Unchanged）
- 任务、fixture、隐藏断言均为自建，不构成外部有效性；`leadership.verdict` 仍为 `not-proven`。
- 18 个任务、k=1，单题权重 5.6pp，一次波动即可改变结论。
- L3 为空：长程压缩与纠错能力**从未被测过**。

## [2.4.0] — 2026-11-08 · W1-03/04：L2 真实工程任务与隐藏验收（MINOR）

> 类型：**MINOR · 新能力域**。
> 从这一版起，bro2 的评测不再只有「脚本化回归」，而是能在**真实仓库快照**上
> 用隐藏测试判定「改没改对」。这是 W1「让 harness 有地方使劲」的关键一步。

### 新增（Added）
- `src/bench/runner.ts` — 隐藏测试执行器：
  - `stageRepo()` 把 fixture 铺进隔离工作区，排除 `node_modules` / `.git` / 缓存；
  - `runHiddenTests()` 顺序跑内联断言，**超时强杀**，失败输出截尾回传；
  - `hiddenReasons()` 只把失败转成判分原因，通过不产生噪声。
  - 隐藏断言以命令形式存在任务 JSON 里，**不落盘到工作区**，被测 agent 读不到。
- `src/observability/eval.ts` — 两个最小钩子：`prepareWorkspace` / `verifyWorkspace`。
  执行与判分仍由 `runEval` 唯一负责，v2 只注入环境与额外验收，不复制评测器。
- `liveOnly` 任务语义：真实能力任务在 deterministic 模式下**跳过**，
  既不用 mock 伪造通过，也不会把「没测」判成「0 分」。
- `data/tasks/v2/l2.jsonl` — 18 个 L2 真实工程任务（3 个仓库 × 6）：

  | 仓库 | 任务类型 | 例子 |
  | --- | --- | --- |
  | `ts-strkit` | 缺陷修复 / 新增导出 | `truncate` 边界、CRLF 分行、`wrap` / `escapeHtml` / `pad` |
  | `py-dates` | 半开区间语义 / 新增函数 | `overlaps` 相接误判、`merge_ranges` / `month_bounds` / `each_day` |
  | `js-cart` | 金额取整 / 输入校验 | `total` 分位取整、`applyCoupon` / `taxTotal`、越界抛 `RangeError` |

- `scripts/task-check.ts` — **双态校准**门禁，回答两个必须回答的问题：
  1. 原始快照上隐藏测试**必须失败**（否则不修也能过，白送分）；
  2. 应用任务自带的参考解后**必须通过**（否则任务不可解）。
  参考解只存在于任务 JSON，`toEvalTask()` 会剥离，绝不下发。
- `src/observability/eval-grade.ts` — 判分逻辑拆出，`eval.ts` 从 697 行降到 516 行，
  守住「单文件 ≤ 700 行」预算门禁。

### 变更（Changed）
- `bench:v2` 分层表新增「待 live」列；某层全为 live 任务时，门禁阈值按「未测」处理并明确打印，
  不把跳过包装成通过。
- `tests/bench-v2.test.ts` 不再写死任务总数，改为「合并后不丢不重 + l2 ≥ 18 + 全部绑定仓库」。
- 移除 l2 的格式样例任务（已被 18 个真实任务取代）。

### 证据（v2.4.0 发布时）
- `npm run task:check -- --layer l2` → **18/18 双态成立**（快照必失败、参考解必通过）。
- `npm test` → **196/196 通过**。
- `npm run project:status` → 全部阻断门禁通过（新增 `taskcheck` 一道）。

### 诚实边界（Unchanged）
- 这 18 个任务仍由本项目自建，**不构成外部有效性**；`leadership.verdict` 保持 `not-proven`。
- 尚未用真实模型跑过 L2（`--mode live` 属 W1-05），因此**没有任何 L2 能力分数**可引用。
- fixture 只有 3 个仓库、每个 6 个任务，规模不足以支撑「L2 ≥ 60」的目标（W1-06）。

---

## [2.3.2] — 2026-11-08 · W1-02：三个 fixture 仓库快照（PATCH）

> 类型：**PATCH · 战役内步骤**。
> W1-01 解决了「任务怎么装」，W1-02 解决「任务在什么代码上跑」。
> 没有可复现的代码快照，隐藏测试就没有落点，任务分数也无法比较。

### 新增（Added）
- `data/fixtures/repos/` 下 3 个最小仓库快照，各埋 1 个**真实缺陷**，
  可见测试全绿、隐藏测试才能抓到（这是任务区分度的来源）：

  | 仓库 | 语言 | 可见测试 | 埋入缺陷 |
  | --- | --- | --- | --- |
  | `ts-strkit` | TS（`node:test`，零依赖） | 6/6 | `truncate(text, max)` 在 `max < 4` 时返回长度 8，违反「不超过 max」契约 |
  | `py-dates` | Python（`unittest`，标准库） | 6/6 | 半开区间却用 `<=` 比较，首尾相接的两段被判为重叠 |
  | `js-cart` | JS（`node:test`，零依赖） | 4/4 | `total()` 未按分取整，返回 `0.30000000000000004` 这类不可用金额 |

- `data/fixtures/repos/manifest.json` — 快照清单：语言、项目文件、离线测试命令、
  埋入缺陷描述、**内容指纹**（按路径排序后对 `路径\0内容` 求 sha256）。
- `scripts/fixture-check.ts` + `npm run fixture:check`：
  `--run` 真实执行每个仓库的测试，`--update` 重算并写回指纹。
- 第 15 道阻断门禁 `fixture`：结构完整 + 体积受控 + 测试可跑。

### 修复（Fixed）
- **运行时产物污染指纹**：首版把 `__pycache__/*.pyc` 计入哈希，导致同一快照在不同
  Python 版本下得出不同指纹（跨环境假红），实测 py-dates 被算成 8 个文件。
  已排除 `__pycache__` / `node_modules` / `.pytest_cache` / `*.pyc` 等，并用
  `PYTHONDONTWRITEBYTECODE=1` 让测试子进程不再写字节码——快照保持干净（7585 字节）。
- **fixture 缺陷设计错误**：`py-dates` 初版用闭区间语义，`<=` 是正确的，
  「缺陷」并不成立。改为半开区间 `[start, end)`（工程中最常见的约定），
  `<=` 才成为真缺陷。**任务集的缺陷必须能被证明为真 bug，否则评测的是空气。**

### 验证
- `npm test` **190/190**（新增 `tests/fixture.test.ts` 4 项）。
- `npm run fixture:check -- --run` → 3/3 仓库测试通过，总 7,585 / 3,145,728 字节。
- 连续两次 `--run` 指纹完全不变（证明排除规则有效、指纹可复现）。
- `npm run budget:check`：14,187 / 16,500 行、80 / 90 文件、零运行时依赖。

### 诚实边界
- 这 3 个仓库是**为基准自建的最小快照**，不是真实开源项目的 fork。
  它们证明「装载 → 执行 → 隐藏判定」链路可用，但**不构成外部有效性证据**；
  W1-03 起基于它们写真实工程任务，W1-06 扩到 60 个时需要引入真实仓库来源。
- `hiddenTests` 字段仍未被执行器消费（W1-04）。

---

## [2.3.1] — 2026-11-08 · W1-01：v2 任务 schema 与分层装载器（PATCH）

> 类型：**PATCH · 战役内步骤**（W1 战役收口时才升 MINOR）。
> 这是基准重建的第一步：没有可分层、可校验、可复现的任务装载层，
> 后面所有「同模型增益（HLR）」都缺少可信的输入。

### 新增（Added）
- `src/bench/schema.ts` — v2 任务契约 `bro2.task/2`：
  `layer`（l1/l2/l3）、`repo`/`commit`（fixture 绑定）、`hiddenTests`（隐藏验收）、
  `budget`（成本上限）、`sample`（格式样例不计入真实通过率）。
  `upgradeLegacy()` 幂等升格旧任务，`validateTaskV2()` **一次返回全部问题**，
  `toEvalTask()` 是 v2 → 执行的**唯一**转换点。
- `src/bench/loader.ts` — 分层装载：l1 直接读既有 `data/eval-tasks.jsonl`
  （**不复制**，单一事实源），l2 读 `data/tasks/v2/l2.jsonl`；
  重复 id、坏行、layer 声明不符、fixture 仓库缺失全部报告为装载失败。
- `scripts/bench-v2.ts` + `npm run bench:v2` — 分层评测入口，
  `--layer` / `--json` / `--save` / `--quiet`；判分与指标抽取**完全复用** `runEval`。
- 第 14 道阻断门禁 `benchv2`：`bench:v2 -- --layer l1` 必须 19/19。

### 修复（Fixed）
- **分层评测误红**：全量阈值假设每个类别都有任务，单跑 l2 时因缺 safety/robustness
  被判定 0 分而 FAIL。改为只把**本层不存在**的类别断言降为 0，其余阈值与判定逻辑
  仍由 `runEval` 内部执行，不产生第二套门禁实现。
- **指纹口径分叉**：装载器初版用文件内容 sha256，而 `runEval` 用
  `sha1(JSON.stringify(tasks))`，两者永不相等，「指纹一致」形同虚设。
  已改为复用同一算法——l1 指纹 `d1419b1efaa7` 与既有 `eval-report.json` 完全一致，
  这才是「装载器交给评测器的是同一份任务」的硬证明。

### 验证
- `npm test` **186/186**（新增 `tests/bench-v2.test.ts` 10 项）。
- `npm run bench:v2 -- --layer l1` → **19/19 PASS**，指纹 `d1419b1efaa7`。
- `npm run bench:v2`（all）→ **20/20 PASS**（l1 19 + l2 样例 1）。
- `npm run budget:check`：14,031 / 16,500 行、79 / 90 文件、零运行时依赖。

### 诚实边界
- l2 目前只有 1 个 `sample` 格式样例，**尚不代表真实工程能力**；
  18 个真实仓库任务是 W1-03 的交付，fixture 快照是 W1-02。
- `hiddenTests` 字段已定义并被校验，但**判分尚未执行**——执行器接入属于 W1-04。

---

## [2.3.0] — 2026-11-08 · 自治执行机制与「少而精」工程宪法（MINOR）

> 类型：**MINOR · 新增能力域**。解决两个真实断点：
> ① 持续改进的状态留在对话里，会话一断就归零；
> ② "代码量要少、质量要高"只停留在口头，没有任何机制拦得住膨胀。

### 新增（Added）
- **计划账本三件套**（`src/plan/`、`data/plan/`）：
  - `backlog.jsonl` 任务定义（31 项，覆盖 W1–W5 五个战役）；
  - `journal.jsonl` 尝试事件（`start/done/fail/block/unblock`，只增）；
  - `lessons.jsonl` 可复用工程教训（`trigger/action/evidence/confidence`）。
  - **状态不单独存储**，由 journal 折叠得出——与 `Trajectory` 是唯一真相源同一哲学，
    不存在"状态文件与实际不一致"的可能。
- **`bin/autopilot.ts`**：`auto:next`（下一个任务卡 + 命中教训）/ `auto:status`（战役进度 + 已用 LOC）/
  `auto:done` / `auto:fail` / `auto:block` / `auto:unblock`。刻意只做调度与记账，
  **不做实现、不跑门禁、不联网**——边界写死，避免"看起来自动其实不可信"。
- **`scripts/loc-budget.ts` + 第 13 道阻断门禁 `budget`**：把「少而精」变成可执行约束。
  四项硬指标：源代码行 ≤ 16,500、源文件 ≤ 90、单文件 ≤ 700 行、测试/源 ≥ 0.15，
  外加运行时依赖恒为 0。当前 13,694 行 / 76 文件 / 最大 661 行（`observability/eval.ts`）/ 测试比 0.21。
- **`tests/plan.test.ts`**（12 项）：折叠语义（`done` 终态、`blocked` 只能 `unblock` 解除、
  `fail` 可重试）、调度（跳过依赖未满足、不重复选 in-progress）、教训检索（置信 0 失效、不相关不命中）。

### 变更（Changed）
- **`tests/remote-sync.test.ts` 去硬编码版本**：原断言 `pkg.version === "2.2.2"` 会让每次发版都改测试，
  属于脆弱断言。改为校验「semver 格式 + CHANGELOG 存在同版本条目」这一**不变量**，
  发版只需写发布记录，测试自动对齐。

### 文档（Docs）
- 新增 [`docs/PLAN-TOP-HARNESS.md`](./docs/PLAN-TOP-HARNESS.md)：
  九维差距矩阵、HLR/CAS 北极星指标、W1–W5 五大战役、13 周里程碑、风险与退出条件；
  §3.4 工程宪法（少而精）、§11 自治执行（三阶段 + tick 协议 + 四条红线）。

### 验证
- `npm test` **176/176**；`npm run project:status` **13/13** 阻断门禁 + 2 项信息展示；
- `npm run budget:check` 四项全绿（83% / 84% / 94% / 100%）；
- `npm run auto:status` 输出五战役进度，`npm run auto:next` 正确选中 `W1-01`。

---

## [2.2.2] — 2026-11-08 · 修复 CI 验收门禁失败（PATCH）

> 类型：**PATCH · 回归修复**。v2.2.1 引入的 `tests/remote-sync.test.ts` 中有一条断言
> 「本机私有凭证文件 `/root/.codebuddy/credentials/bro2-github-pat` 必须存在」，
> 这是**环境事实**而非仓库不变量：GitHub Actions runner 上没有该文件，
> 导致 `npm test` 从 `130ae39` 起连续 3 次 CI 失败（`11/12` 门禁），
> 而本地因凭证存在显示 `162/162` 全绿——典型的「本地绿 / CI 红」。

### 修复（Fixed）
- `tests/remote-sync.test.ts`：移除对凭证文件存在性的断言，改为与机器无关的**设计约束**
  （默认路径位于 `$HOME/.codebuddy/credentials`、凭证缺失时 `[ ! -r ... ]` 显式报错退出、
  仓库内零明文；`.git/config` 仅在存在时校验）。
- 新增 **「CI 可移植性」**门禁：扫描全部 `tests/*.test.ts`，禁止出现本机专属
  绝对路径（`/root/`、`/workspace/`、`/home/`、`/Users/`、Windows 盘符），
  `/etc/passwd`、`/tmp/...` 等通用夹具不受影响。防止同类错误再次混入。
- `scripts/remote-check.ts`：修复网络抖动导致的 `push:check` 间歇性误报。
  实测 `git ls-remote` 直连 6 次有 1 次 `exit=128 unable to access`，而 `ship.sh` 推送后
  依赖该自检——一次抖动就会让**推送已成功**的 `ship` 整体非零退出。现加入：
  `ls-remote` 有限重试（3 次 / 每次 10s）、push 后远程 ref 传播延迟时**复查一次**再判定、
  「网络不可达 = 无法复核」明示为信息项（`exit=0`）而非冒充「已同步」或「漏推」；
  只有确认未同步才 `exit=1`。`project:status` 中该信息项超时放宽至 90s。
- 已在**有凭证 / 无凭证两种环境**分别验证，并在**纯 checkout 副本**（无本机凭证、
  无本地 git 身份）下跑通全量 `npm test` **164/164**；`push:check` 连跑 4 次稳定。

### 变更（Changed）
- 版本 `2.2.2`；同步 `CHANGELOG` / `README` 更新日志 / `DELIVERABLES` /
  `scripts/project-status.ts` 版本行 / 私有技能 `bro2-self-iteration` `1.3.2`。
- 私有技能新增反模式条目：**测试不得依赖本机环境事实**（凭证、绝对路径、本机服务）。

### 根因与教训
CI 只 checkout 仓库内容，不携带本机私有状态。单测必须只断言**可从仓库复现的结构不变量**；
任何「本机文件存在 / 本机服务可达 / 本机凭据有效」的断言都属于运行时检查，
应由 `push-remote.sh` 等真实执行环节承担，不能写进 `npm test`。

---

## [2.2.1] — 2026-11-08 · 改进即推送：远程同步闭环（PATCH）

> 类型：**PATCH · 发布流程 / 验收脚本补齐**。v2.2.0 的进化启动器把「越用越快」写进了
> 本地只增账本，但发布动作仍依赖人工执行 `git push`——出现过「本地已提交、远程未同步」的断点。
> 本版把「每次改进都推送 GitHub 远程」固化为**机制**：唯一推送通道、一键闭环、防漏推门禁，
> 并复用此前持久化的 fine-grained PAT 凭证（仓库外 600 权限文件，绝不入库、绝不回显）。

### 新增（Added）
- **`scripts/push-remote.sh` · 唯一推送通道**：从 `BRO2_GITHUB_PAT_FILE`（默认
  `$HOME/.codebuddy/credentials/bro2-github-pat`）读取凭证，用一次性 `GIT_ASKPASS`
  交给 git；显式屏蔽全局/系统 `credential.helper`，避免误用此前写操作 403 的 App 令牌；
  临时 askpass 用 `trap` 清除。凭证不回显、不写入仓库、不进 `.git/config`。
- **`scripts/ship.sh` · 改进同步闭环**：`npm run ship` = 还原运行时噪声 → `git add -A`
  → 干净身份提交 → 唯一通道推送 → 同步自检；`npm run ship -- --rounds 8 "<msg>"`
  先推进 8 轮真实迭代再提交推送。迭代本身离线可复现，网络只出现在最后一步。
- **`scripts/remote-check.ts` · 防漏推门禁**：纯只读 `ls-remote` / `rev-list`，
  核对本地 HEAD 是否等于远程 main、本地最新 tag 是否已推送；不一致即 `EXIT=1`
  并提示 `npm run ship`。`npm run push:check` 单独可跑，也作为 `project:status`
  第 2 项信息展示门禁。
- **`tests/remote-sync.test.ts`**：5 项结构不变量测试，守住「凭证绝不入库」、
  「推送只走唯一通道」、「防漏推检查纯只读」三条红线。

### 变更（Changed）
- `package.json`：版本 `2.2.1`；新增 `ship` / `push:remote` / `push:check`。
- `scripts/project-status.ts`：信息展示区新增 `pushcheck` 远程同步一致性项。
- 私有技能 `bro2-self-iteration` 升级 `1.3.0`：新增「每次改进必推」红线与
  `references/remote-sync.md`，`release-playbook.md` 补 §8 复用持久化凭证。

### 验证
- `npm test` **162/162**；`npm run project:status` **12/12** 阻断门禁全绿、信息展示 2 项；
- `npm run push:check` → `✓ 远程已同步`；`npm run ship` 端到端闭环通过；
- 远程 `github.com/moda1216/bro2`：`main` 与本地一致，`v2.2.0` / `v2.2.1` tag 齐全。

### 修订：凭证生命周期（澄清「何时才该 revoke」）

早期发布流程里的「用完立即 revoke」针对的是**一次性临时 token**，与本版「持久化复用
同一凭证」的机制冲突，已在私有技能 `release-playbook.md §8.5` 与 `remote-sync.md` 修正：

- **revoke 与有效期无关**。fine-grained PAT 自带过期时间，未到期即可持续复用；
  revoke 是主动吊销，只在「有泄露证据 / 用户主动决定轮换 / 凭证真的失效」时触发。
- 复用场景下例行轮换反而有害：会让 `ship` 通道立刻失效、迫使用户再次以明文传输 token，
  扩大暴露面，且与「复用之前的凭证」这一要求直接冲突。
- 暴露面如实标注：token 曾以明文出现在对话消息中，平台侧会话记录文件内存在明文副本；
  仓库、`.git/config`、报告与提交记录中零明文（由 `tests/remote-sync.test.ts` 守住）。
  会话数据的访问收紧由用户决定，不包装成「必须 revoke」。

---

## [2.2.0] — 2026-11-08 · 进化启动器与迭代水位看板（MINOR）

> 类型：**MINOR · 新增能力域**。v2.1.0 造好了冻结速度尺子，但真实账本 0 条记录、
> 演示跑完即删——「有尺子、没刻度」，用户无处查看「越用越快」是否真的发生。
> 本版把复利闭环接到**持久只增账本**，并提供可反复运行的启动器与可视化水位，
> 让设计目标 1 从「离线演示断言」变成「跨会话可查看、可证伪的时间序列」。
> 详见 [docs/ITERATION-WATERMARK.md](./docs/ITERATION-WATERMARK.md)。

### 新增（Added）
- **`bin/evolve-loop.ts` · 进化启动器**：`npm run evolve:tick -- --rounds N` 每次推进 N 轮真实迭代，
  账本只增、跨会话累积；`npm run watermark` 只读查看；`--reset` 需显式指定才清空账本。
  每轮轨迹来自 `runEval` 真实评测（deterministic 模型脚本 + 真实 harness 策略分支），
  **没有任何手搓的行为摘要**。
- **`data/rsi/compound-tasks.jsonl` · 复利回路专属工作负载**：与主能力评测任务集严格隔离；
  畸形工具参数任务使 `malformedArgs=repair` 真实把 `toolErrors` 2→0（`repairs=2` 为真实代码分支），
  `noop` 变体行为不变，自报提分的伪修复被 reward hacking 拦截。
- **`src/rsi/watermark.ts` · 迭代水位看板**：对只增账本做逐轮前缀投影，输出
  `data/rsi/watermark.html`（4 条 SVG 曲线 + 逐轮表）、`watermark.json` 与
  `docs/ITERATION-WATERMARK.md`；`formatWatermark` 提供终端视图。
- **惰性真实探测（`compound.ts` 向后兼容增强）**：新增 `PendingCandidate` 与
  `CompoundOptions.probe`。被经验裁剪的候选**不触发评测**，因此 `attempts` 等于真实计算成本，
  而不是纸面裁剪；经验回退需补探测时拒绝伪造摘要，由启动器降级为全量重跑。
- **`scripts/watermark-check.ts` · 第 12 道发布阻断门禁**：校验冻结尺子唯一、账本 seq 连续、
  报告与尺子一致、派生视图完整、门禁运行前后账本字节不变（只读）。
- **测试**：`tests/watermark.test.ts`（8 项）；全量 `npm test` **157/157**。

### 变更（Changed）
- `velocity.ts`：把 `snapshot()` 的判定提炼为**唯一纯函数** `velocitySnapshotFrom(records)`，
  Ledger 与看板共用同一把尺子；判定口径、阈值、诚实性约束一字未改。
- `project:status`：新增 `watermark` 阻断门禁，版本显示 v2.2.0；`package.json` 版本升至 2.2.0。

### 首次真实启动结果（可复核，非演示断言）
- 连续 8 轮真实迭代写入持久账本：探测数 **3 → 2**、每轮真实评测 **4 → 3** 次、
  累计跳过探测 **7** 次、接受改进 8 次、协议违规 0。
- 冻结尺子在**第 6 轮**首次判定 `trend=accelerating`；IPA **0.333 → 0.471**
  （前半 0.444 → 后半 0.500），平均探测 2.25 → 2.00，首轮命中率 1.00 未下降。
- 判定全程 `frozenMetric=true` / `selfReported=false`；`leadership.verdict` 仍 `not-proven`、
  L4 仍 `not-achieved`，水位变化**不构成能力或业界水平结论**。

### 诚实边界
- 轨迹来自确定性模型脚本 + 真实 harness 代码分支，是**行为对比证据**，不是模型能力分数。
- 复利结论仅限**同类失败模式**；跨失败模式泛化（P3 OOD）与异步按需探测（P4）尚未实现。
- 启动器预跑的是「本轮被探测候选」的轨迹，省下的是真实评测/判定次数；看板只读，绝不回写账本。

---

## [2.1.0] — 2026-11-08 · 复利中枢：两大设计目标的可证伪落点（MINOR）

> 类型：**MINOR · 新增能力域**。新增跨会话经验层与冻结速度度量，把「越使用改进速度越快」与
> 「越用越省 / 越用越稳」从口号变成有门禁、可证伪、防 reward hacking 的工程闭环。详见
> [docs/COMPOUND-LOOP.md](./docs/COMPOUND-LOOP.md) 与 [ROADMAP.md §0](./ROADMAP.md)。

### 新增（Added）
- **`src/rsi/experience.ts` · ExperienceBank（P2 落地）**：事件式只增账本，三类指纹
  （失败模式 / 请求结构 / 上游），读取时折叠成快照；`retrieve` / `prioritize` / `invalidate`。
  指纹只由类别与结构特征构成，禁止编码任务 id 或答案（防记忆任务集）。
- **`src/rsi/velocity.ts` · VelocityLedger（复利速度度量）**：`firstTryHitRate` / `avgAttempts` /
  `improvementPerAttempt` / `reuseRate` 一等公民；样本 < 6 一律 `insufficient-data`；
  协议违规轮不计入趋势；`selfReported=false`、`frozenMetric=true`。
- **`src/rsi/compound.ts` · compoundProbe（复利闭环）**：经验只裁剪 Propose 探测集、
  **判定仍走全量行为对比**；经验不灵必回退；保留 `EXPLORE_SLOTS=1` 探索位（RRSI 正则思想）；
  经验回写只由「行为对比成立且非 reward hacking」的接受项驱动。
- **`src/models/route-experience.ts` · LearnedRoutePolicy（P0.5-a/c 最小闭环）**：实现 `RoutePolicy`
  注入 `HybridProvider`、零侵入；冷启动回退启发式；远程失败→本地兜底同时记
  `remote: failure` 与 `local: success`；端点质量经验跨会话累积（补充聚合器进程内健康态）。
- **测试 / 演示 / 门禁**：`tests/compound.test.ts`（18 项）、`examples/compound-demo.ts` +
  `npm run compound:demo`（10/10 断言）、`project:status` 第 11 道阻断门禁 `compound`。
- **文档**：新增 `docs/COMPOUND-LOOP.md`；`ROADMAP.md` 重排为「两大目标双主线 + 共享中枢」；
  `META-RSI.md` 补 §7.1 边界澄清；README 产品特性与更新日志同步。

### 设计决策（Design）
- 经验复用**不靠改判定结果**体现变快（`proposeProbeCompose` 是全量判定），而是靠 Propose 阶段
  减少探测次数；从根上杜绝「经验库 → reward hacking」的通路。
- `requestSignature` 刻意**不含末条角色**：否则经验指纹与 `cheapToLocalPolicy` 视角重合，
  学习型路由永远无法覆盖启发式判断、也就没有增益；由 `minSamples` + `minLocalSuccessRate`
  双重冷启动保护把关。

### 验证（Verified）
- `npm test` **149/149 PASS**（新增 18）；`npm run project:status` **11/11 阻断门禁通过**。
- `compound:demo` 实测：同一失败模式第 1 轮探测 3 次、第 2 轮起 2 次，
  `VelocityLedger trend=accelerating`（IPA 0.444→0.500、探测 2.25→2.00）；
  学习型路由把 5 个原本走远程的请求压到本地（`remoteAvoided=6`）；端点质量跨会话保留。
- 诚实边界不变：`leadership.verdict = not-proven`、L4 `not-achieved`；复利仅在同失败模式类内成立，
  跨类泛化属 P3/P4；离线确定性轨迹不是真实模型能力分数。

### 仍待建（Next）
- P0.5-b 语义 / 近似缓存；P0.5-c 把成本正式纳入 evolve 晋升判据。
- P3 RRSI 正则 + OOD 通道；P4 OO-Harness 类族 / HarnessRouter（跨失败模式泛化）。
- P2 后续：把 `VelocityLedger` 趋势接入 meta fitness 效率维度（须先过 OOD 校验）。

---

## [2.0.6] — 2026-11-08 · P0 真实强模型评测通路打通（OpenRouter 免费 550B）（PATCH）

> 类型：**PATCH · 证据更新 + 路线图推进**。用 OpenRouter 免费层的 120B+ 强模型跑通 `eval:live`，拿到 bro2 在真实强模型上的第一份有效分数，兑现 ROADMAP P0 的核心目标。

### 新增（Added）
- **P0 强模型接入实证**：`AGENTOS_LIVE_PROVIDER=openrouter OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free npm run eval:live` 一行命令跑通；`preflight` 六项门禁全绿（配置 / 端点 / 认证 / 模型可用 / SSE 流式 / 原生 `tool_calls`）。
- **第一份真实强模型分数** `data/eval-live-report.json`：12 个 live 任务通过 5 个，总体 **41.7%**；分类 `tool-use 50% / grounding 0% / context 33.3% / multi-step 66.7%`；**协议违规 0、工具错误率 0**，平均延迟 9.3s、总 token 128413。
- **配置零改动**：`agentos.config.json` 早已预留 `openrouter`（`apiKeyEnv: OPENROUTER_API_KEY`、`model: ${OPENROUTER_MODEL}`），凭据只走环境变量，不入库、不落报告、不进提交记录。

### 验证（Verification）
- `npm run project:status` 仍 **10/10** 发布门禁通过；`npm test` **131/131**（本轮无代码改动）。
- live 报告内部 `gate.pass=false` 属预期：它对比的是确定性 mock 基线（1.0），不是发布阻断门禁；恰好实证「不能把仿真分当真实能力分」。

### 诚实边界（不变）
- `leadership.verdict = not-proven`、证据阶梯 L4 = `not-achieved` 不变。41.7% 是**单模型、单任务集、k=1** 的实测，未做多模型横向对比、未做 OOD、未对齐公开基准，不据此宣称领先。
- 失败集中在 grounding / 上下文锚定 / 多步工具编排，为 P1 对比式改进与 P3 OOD 通道提供了真实失败模式输入。

---

## [2.0.5] — 2026-11-08 · 双层叠加（免 Key 网状 + 本地协同）+ P1 对比式改进 live 闭环（PATCH）

> 类型：**PATCH · 能力增强 + 路线图推进**。把 `hybrid.remote` 指向 `keyless`，形成「聚合器管可用性 / hybrid 管开销」的正交双层；并按 ROADMAP 推进 **P1**（对比式改进接入 live RSI）。

### 新增（Added）
- **双层叠加**：`agentos.config.json` 的 `hybrid.remote` 从 `kilo` 改为 `keyless`——外层 `HybridProvider` 把便宜/重复调用拦在本地+缓存，内层 `KeylessAggregator` 把单点限流吸收为故障转移，bro2 调用侧仍只见一个接口。
- **组合根装配顺序修复** `src/index.ts`：把 `keyless`（与 `cached`）提前到 `hybrid` 之前装配，使 `hybrid.remote=keyless` 的嵌套依赖不再依赖配置书写顺序。
- **可复用端点穿透解析** `src/models/resolve.ts`：`resolveLeaves / leafEndpoints / probeTargets` 递归展开组合/网状 provider，去重防环、远端 configured 上游优先、本地兜底殿后；`preflight` 与 `eval:live` 门禁共用同一套判定（任一远端上游 ready 即放行，体现故障转移韧性）。
- **doctor 递归展示** `bin/agentos.ts`：逐层展开 `hybrid → keyless → 各上游`，并把 `HybridProvider.inferenceStats()` 的 `remoteDetail`（网状明细）暴露到评测报告。
- **P1 · 对比式改进 live 闭环** `src/rsi/live-contrast.ts`：`toRunSummary / baselineFromRuns / evaluateLiveCandidates / LiveContrastVerifier`，把 `contrast.ts`（HARNESS² Propose–Probe–Compose）接入真实评测轨迹；**候选自报分数提升 `scoreGain` 绝不参与判定**——只抬分数没修复失败模式的伪修复被判定为 reward hacking 并拒绝；全程 `usedGroundTruthVerifier=false`。
- **P1 验证**：`tests/contrast-live.test.ts`（9 项）+ `examples/contrast-live.ts`（`npm run contrast:live`，用真实 fault 任务轨迹演示 2 真修复晋升 / 2 伪修复拦截）；纳入 `project:status` 第 10 道门禁。

### 验证（Verification）
- `tests/nested-hybrid-keyless.test.ts`（8 项）+ `tests/contrast-live.test.ts`（9 项）；全量 `npm test` **131/131**。
- `npm run hybrid:keyless:demo`：4 次任务仅 1 次穿透远程网状，`remoteCallRatio=0.25`，含 1 次限流故障转移；`remoteDetail.backendCount=3`。
- `npm run project:status`：**10/10 发布门禁通过**（新增 contrast 门禁）。

### 诚实边界（不变）
- `leadership.verdict = not-proven`、证据阶梯 L4 = `not-achieved` 不变。双层叠加提升的是**网状韧性 + 远程开销**，P1 提供的是**无真值下防 reward hacking 的改进判据**，均不抬高单模型能力；公开基准对齐与第三方复现（ROADMAP P5）仍待完成。

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
