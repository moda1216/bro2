# bro2 · 发布日志（CHANGELOG）

> 语义化版本 `MAJOR.MINOR.PATCH`：
> - **MAJOR**：破坏性架构变更（接口/契约不兼容，需迁移）。
> - **MINOR**：新增能力域或重大特性（向后兼容）。
> - **PATCH**：修复、证据更新、文档/验收脚本补齐（向后兼容）。
>
> 发布动作（强制）：feature 完成 → `npm run project:status` 全绿 → `git tag -a vX.Y.Z` → 追加本条目 → 同步 [DELIVERABLES.md](./DELIVERABLES.md) §3 状态。
> 产出物管理三件套：`DELIVERABLES.md`（登记册）· `CHANGELOG.md`（本文件）· `ROADMAP.md`（演进）。

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
