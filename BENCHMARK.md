# bro2 · 能力基准与「领先」的可证伪评估

> 本文回答一个问题：**凭什么说一个 Agent 的能力处于领先水平？**
> 结论先行：**目前不能**。bro2 建立了能证明/证伪这件事的机器，拿到了内部可控域内的最强证据，
> 但「行业领先」是外部比较命题，在缺少公开基准与真实模型对比的前提下不成立。
> 设计与迭代见 [DESIGN.md](./DESIGN.md) / [ITERATIONS.md](./ITERATIONS.md)，评测框架见 [EVAL.md](./EVAL.md)。

---

## 1. 先纠正一个容易犯的错

`eval 19/19`、`verify 23/23`、`ablation 10/10` **都不是能力领先的证据**。它们测的是：给定脚本化 Mock 模型行为，Harness 的调度 / 治理 / 协议正确性。模型智能根本不参与评分。

把这些数字当作「领先」，就是 RSI 文献里的 **self-confirming loop**：用自己写的题、自己的尺子、自己跑分，然后宣布自己赢了。

因此 bro2 把"领先"拆成**外部可复核的判据**，并让程序自动判定当前到了哪一级 —— 判定逻辑本身在写保护面内（`src/benchmark/ladder.ts`），不能被 RSI 改。

---

## 2. 五级证据阶梯

| 级 | 名称 | 判据 | 当前 | 主要证据 | 尚缺 |
| --- | --- | --- | --- | --- | --- |
| L0 | 结构连通 / 无空接口 | 各层可运行，评测报告落盘并通过门禁 | ✅ achieved | `eval-report.json`、87 项测试、`verify.ts` | — |
| L1 | 确定性行为回归 | overall ≥ 0.85、门禁 PASS、未配对 tool_call = 0 | ✅ achieved | overall 1.0 / 协议违规 0 | 只证明框架正确，不测模型智能 |
| L2 | 有界可验证自我改进 | train 与 holdout 单调提升、保护面未变更、有害候选被拒 | ✅ achieved | train 0.286→0.857、holdout 0.5→1.0、4 晋升 1 拒绝 | 收益只在自建域成立，基座模型冻结 |
| L3 | meta RSI + 贡献分离 | 冻结 fitness 单调提升、ablation 量化组件贡献、跨 provider 接口就绪 | ~ partial | fitness 0.8879→0.9、7 个 ablation 变体、Ollama 协议实证 | 无真实模型矩阵；ablation 是内部对照 |
| L4 | 公开基准对齐 / 行业领先 | BFCL / τ-bench / GAIA / SWE-bench 类基准上胜过同期开源 harness，第三方可复现 | ❌ not-achieved | 无 | 已有第一份真实模型分数（0/12，单点 0.5B CPU + 内部任务集），但**不是公开基准**；无同期 harness 对照、无第三方复现、无 GPU / API Key |

> L3 即使内部证据齐备也**只给 partial**，因为跨 provider 只有协议级仿真。判定代码不会给自己发满级。
> 运行 `npm run benchmark` 可从落盘报告重新生成这张表，而不是读一段写死的结论。

**当前结论（`data/benchmark-report.json` → `leadership.verdict`）**：`not-proven`。

---

## 3. Harness 贡献分离（内部最强证据）

方法：同一任务集、同一模型、同一预算，逐个关闭 bro2 的能力，量化每个组件的真实贡献。
任务集为 **10 个纯行为断言**（`data/evolve/train.jsonl` 的行为部分 + 4 个主评测代表任务），
**已剥离 `expectedPolicy` 配置断言** —— 否则变体差异会变成"检查配置值是否被看到"的循环论证。

| 变体 | 得分 | 通过 | 相对完整 bro2 |
| --- | --- | --- | --- |
| **完整 bro2**（已落地演进策略） | **1.000** | 10/10 | 基线 |
| 保守基线（策略层全关） | 0.700 | 7/10 | −0.300 |
| 朴素单轮（无多步工具循环） | 0.100 | 1/10 | **−0.900** |
| 消融：受控参数修复 | 0.900 | 9/10 | −0.100 |
| 消融：终答接地校验 | 0.900 | 9/10 | −0.100 |
| 消融：证据优先压缩 | 0.900 | 9/10 | −0.100 |
| 消融：高危优先并行调度 | 1.000 | 10/10 | 0.000（本域无区分度，如实标注） |

两个结论：

1. **多步工具循环（Model + Harness 的核心）贡献最大**，去掉它几乎什么也做不了（−0.900）。这量化了 "Harness 不是聊天壳" 这句话。
2. **RSI 迭代出的 4 个策略各带来可测增益**（合计 +0.300），且 `no-parallel` 在本域无区分度 —— 报告没有把 0 贡献包装成提升。

`e9`（advisory 策略）被排除在能力基准外：它对应的改进方向是被 holdout 治理不变量**主动拒绝**的，属于治理决策而非能力目标。

---

## 4. 如何真正证明领先（可执行清单）

bro2 已把接口与流程备好，缺的是外部数据与真实模型：

1. **接入真实模型**
   ```bash
   ollama serve && ollama pull qwen3:8b       # 必须带 tool-use 训练
   export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"   # /v1 前缀别漏
   export OLLAMA_MODEL="qwen3:8b" AGENTOS_MODEL=ollama
   npm run doctor            # 面向人的诊断：端点 / 认证 / SSE / tool_calling
   npm run preflight         # 机器门禁：ready=PASS 才继续，否则 EXIT=1
   npm run eval:live         # 第一份真实模型分数 → data/eval-live-report.json
   ```
   小模型常忽略 `tools` 把调用写进正文 → 零 `tool_calls` 直接终答，**静默失败不报错**；`doctor` 会判为 `text-json` / `unsupported` 并建议换模型。`preflight` 还区分「网络不可达」与「401/403 认证被拒」，避免把 Key 错误误导成服务没起。沙箱内可用 `npm run live:smoke` 验证 live 链路（**不是能力分数**），或按 [docs/LOCAL-LLM.md](./docs/LOCAL-LLM.md) 起本地真实推理服务直接跑 `eval:live`。**轮 7 已实测**：`preflight` 六项门禁全绿后 `eval:live` 得到 `overall 0.0%`（0/12，门禁 FAIL、协议违规 0，`data/eval-live-report.json`）—— 这是第一份真实模型分数，但只代表 `qwen2.5:0.5b / CPU 4 核 / 单模型 / 内部任务集`，**不构成外部比较证据**：`verdict` 仍 `not-proven`、L4 仍 `not-achieved`。

2. **建跨模型对比矩阵**：≥3 个 provider（本地 Ollama + 2 个云端），同一任务集、同一预算、重复 k 次。
   只在某一个模型掉分 = 模型问题；全掉 = 框架问题。这是区分两者唯一的办法。

3. **接入公开基准**：把 BFCL（函数调用）/ τ-bench（多轮状态一致）/ GAIA（多步检索）/ SWE-bench 类（代码修复）的任务转成 bro2 的 `EvalTask` 格式，用 `runEval` 跑分。
   `BENCHMARK_FAMILIES` 已把内部 6 个分类映射到这些基准族，便于对齐口径 —— **这只是分类映射，不冒充已跑过这些基准**。

4. **对照同期开源 harness**：同任务、同模型、同预算下与 DeepSeek Harness / 其它开源运行时对比。

5. **第三方复现 + 置信区间**：多次重复、给出方差，并排除对自建任务集过拟合。

### 外部基准结果导入接口（已加严格校验）

唯一认可的通道是 `data/benchmark/external-results.json`。`data/benchmark-report.json` 是 bro2 自己的产物，属于**内部证据**，手塞 `external` 字段不会被计入。校验器 `src/benchmark/external.ts` 与 `scoring.ts` / `ladder.ts` 同在写保护面内。

格式示意（**所有数值必须替换为真机实测值，禁止直接落盘**）：

```json
{
  "results": [
    {
      "benchmark": "BFCL-v3",
      "model": "qwen3:8b",
      "harness": "bro2",
      "date": "2026-11-07",
      "score": 0.87,
      "metric": "overall_accuracy",
      "tasks": 200,
      "repeat": 3,
      "confidenceInterval": [0.84, 0.90],
      "reproducibleCommand": "npm run eval:live -- --tasks data/benchmark/bfcl.jsonl --k 3",
      "notes": "需注明模型版本与评分脚本"
    }
  ]
}
```

| 校验 | 规则 |
| --- | --- |
| 必填 | `benchmark / model / date / score / metric / reproducibleCommand`（`EXTERNAL_RESULT_SCHEMA.required`，与校验器同源） |
| 可选 | `harness / tasks / repeat / confidenceInterval / notes` |
| 类型与范围 | `score ∈ [0,1]` 有限数值；`date` 为真实日历日期且不晚于今天；`tasks` / `repeat` 正整数；`confidenceInterval` 为 `[lo,hi]` 且 `lo ≤ hi` |
| 复现命令 | 非空可执行命令，`N/A` / `TODO` / `见文档` 等占位符一律拒绝 |
| 未知字段 | 拒绝：字段必须严格落在白名单内，防止夹带 |
| 自带结论 | 拒绝 `verdict` / `proven` / `leading` / `winner` / `rank` / `claim` 等 —— 结论只能由证据阶梯给出 |

被拒记录逐条留在 `ladder.externalValidation.rejected`（含索引与原因），不会连坐其它合法记录。`npm run benchmark` 的「【外部证据校验】」段打印提交 / 采纳 / 拒绝数；`npm run external:check` 用 38 项断言实证伪造记录无法撼动证据等级。

**导入后**：至少 1 条通过校验才把 L4 从 `not-achieved` 提升为 `partial`；`leadership.verdict` **恒为 `not-proven`**，程序绝不自动宣布领先。胜出结论仍需同期开源 harness 对照与第三方复核。完整字段表与操作序列见 [docs/TAKEOVER.md](./docs/TAKEOVER.md)。

---

## 5. 声明的可证伪性

`leadership.falsification` 明确写出如何推翻本声明，任一成立即领先不成立：

1. 在上述公开基准上 bro2 未超过同期开源 harness；
2. 换用 holdout 之外的真实模型后，RSI 带来的能力增益消失；
3. **去掉 RSI 后分数不变** —— 说明"改进"来自对自建任务集过拟合，而非机制本身。

对应命令：`npm run benchmark`（内部对照）、`npm run eval:live`（真实模型）、导入外部基准结果。

---

## 6. 如实标注的边界

- **Mock 的 100% 不是能力**：确定性模式固定模型输出，测的是框架；真实能力只能由 `eval --mode live` 测量。
- **沙箱条件**：无 GPU、无 Ollama、无 API Key。Ollama 接入只有**协议级高保真仿真**证据（`npm run ollama:check`，4/4 通过），证明链路兼容，不证明模型质量。
- **ablation 是内部对照**：任务集自建、样本 10 个、无置信区间，不能外推到通用任务分布。
- **沙箱是应用层路径白名单**，非 bwrap/Landlock 等 OS 级隔离；`--experimental-strip-types` 只擦除类型不做类型检查。
- **真上生产的底座**：Go / Rust 更稳，本项目定位是「可读、可改、与设计逐条对应」的内核，见 [DESIGN.md 附录 A](./DESIGN.md)。

---

## 7. 运行

```bash
npm run benchmark        # 生成 data/benchmark-report.json（ablation + 证据阶梯 + 领先度声明）
npm run benchmark:check  # 21 项断言，重点验证"测量机器诚实"而非"分数高"
npm run external:check   # 38 项断言，外部证据导入通道防伪造
npm run doctor && npm run preflight && npm run eval:live    # 需自备真实端点，流程见 docs/TAKEOVER.md
```
