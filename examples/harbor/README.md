# bro2 作为 Harbor 自定义 agent 装载（P0-01）

> **性质**：协议接入验证（**零 Key 可做，不产生能力分数**）。本目录让 bro2 可被
> [Harbor](https://docs.harborframework.com/) 装载为「已安装 agent」，从而与
> `mini-swe-agent` / `Terminus-2` 在**同一模型、同一任务、同一预算、同一评分器**下被统一调度出对照数。
> 确定性 mock 验证（`examples/harbor-verify.ts`）只验证**接线正确性**，不反映 harness 价值、
> **不写 `data/benchmark/external-results.json`、不改 `L4` / `leadership.verdict`**。

---

## 1. 接入口做了什么

`bro2_agent.py` 实现 Harbor 的 `BaseInstalledAgent` 契约（依据 Harbor 文档
`core-concepts/agents/custom-agents`）：

- `name()` → `"bro2"`，Harbor 按 `-a examples.harbor.bro2_agent:Bro2Agent` 加载；
- `install()` → 在任务容器内装好 Node 20+ 并校验 bro2 源码就绪；
- `run(instruction, environment, context)` → 在容器内执行
  `node bin/agentos.ts run --task "<instruction>" --preset standard --auto-approve`，
  bro2 的 agent 循环在容器内跑、对 `/app` 有文件系统访问、产出任务文件；
- `MODEL_CONNECTION` → 把用户传入的模型 slug 原样透传给 bro2（bro2 按自身
  `agentos.config.json` 解析），支持免 Key 端点（kilo 等）。

`config.yaml` 记录推荐预算（`max_steps: 12`，与 `external:measure` 的 `MAX_MODEL_CALLS` 对齐）
与默认 provider（`kilo`）。

---

## 2. 可复现命令（第三方可复核）

```bash
# 0) 安装 Harbor（一次）
pip install harbor            # 或 uv tool install harbor

# 1) 取公开任务（固定 commit + SHA256 校验；无需 Key / GPU）
sh examples/fetch-external-tasks.sh

# 2) 构建固定评分器镜像（python:3.11-slim + pytest==8.3.3）
docker build -t bro2/tb-verifier:1 - < examples/tb-verifier.Dockerfile

# 3) 把 bro2 源码挂进 Harbor 的 agent 目录（或按需配置挂载）
#    Harbor 通过 -a 加载自定义 agent；bro2 源码需在任务容器内可达（/app/bro2）

# 4) 跑 bro2 作为 Harbor agent（示例：同模型同任务同预算）
harbor run \
  -t <terminal-bench-task-dir> \
  -a examples.harbor.bro2_agent:Bro2Agent \
  -m kilo-auto/free \
  --ak max_steps=12

# 5) 换 holdout 模型族复测（跨模型稳定性）
harbor run -t <task-dir> -a examples.harbor.bro2_agent:Bro2Agent -m ovhcloud/gpt-oss-120b
```

> 上述 live 命令需要 Harbor 运行时 + 一个可工具调用的模型端点，二者都不在本沙箱默认具备。
> 因此本目录提供的是**接入口 + 可复现协议**，能力对照由第三方按同样协议复跑填入。

---

## 3. 零 Key 接线验证（本沙箱可跑，不产分）

```bash
# 验证 bro2 作为 Harbor agent 的接线契约：同一任务子集 / 同一预算 / 同一评分器三方对齐
node --experimental-strip-types --no-warnings examples/harbor-verify.ts
# 离线契约复核
node --experimental-strip-types --no-warnings --test tests/harbor-verify.test.ts
```

`harbor-verify.ts` 复用 `external-measure.ts` 的 `sanity()`（空工作区必 fail / 官方解必 pass /
评分器 SHA256 比对），并模拟 Harbor 调 `run()` 的数据流，断言：

1. 同一 3 个公开任务子集被装载；
2. 预算上限 `MAX_MODEL_CALLS` 与 `external:measure` 一致（12）；
3. 同一 Docker 评分器（SHA256 校验）被调用，三方对齐可复核；
4. **不写 `data/benchmark/external-results.json`**；
5. **不改 `L4` / `leadership.verdict`**（对照前后指纹一致）。

产物：`data/bench/external/harbor-verify-report.json`（含上述诚实标志）。

---

## 4. 诚实边界

- 本目录是**协议接入口**，证明 bro2 *可*被 Harbor 装载；真实能力对照需 Harbor 运行时 + 端点。
- 确定性 mock 验证量的是**接线正确性**，模型智能不参与评分，故**不反映 harness 价值**。
- 对照数由第三方按同一协议复跑填入；bro2 侧自跑数见
  [`../EXTERNAL-MEASUREMENT.md`](../EXTERNAL-MEASUREMENT.md)（k=3 kilo：bro2 6/9 vs minimal 2/9，Δ=+4）。
- 本 P0 不写 `external-results.json`、不改 `L4` / `verdict`，不冒充外部证据。
- 与 `mini-swe-agent` / `Terminus-2` 的**第三方可复核对照**框架见
  [`data/bench/external/agent-comparison.json`](../../data/bench/external/agent-comparison.json)。
