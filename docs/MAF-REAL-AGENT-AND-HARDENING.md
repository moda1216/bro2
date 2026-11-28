# MAF 真实执行通道与治理加固（2026-11-28）

> 本轮修正一次审视中发现的三个 P0 缺陷：**MAF 评测不经过模型**、**回滚门禁可绕过**、**多实例审计 seq 重复**。同时处理白盒运行态、鉴权与数据目录锚点。结论仍为 `leadership.verdict = not-proven` / L4 = `not-achieved`——这些是工程正确性与治理修复，不是能力领先证据。

## 1. 真实执行通道（替代字符串变换冒充 Agent）

- `Scenario.verifier` 二值：`exact-output-v1` 是**确定性 DSL 判分**（trim/upper 等，只用于验证统计机器与编排正确性，**不产生能力结论**）；`agent-output-v1` 是**真实 Agent Loop 判分**。
- `AgentRunner` 由宿主注入。`createAgentOS` 注入的实现：每个用例创建独立隔离 session，调 `loopRef.run()`，把 genomic prompt + 各 agent Block 的提示片段经 `extraInject` 注入，把 genome 与 Block 的工具白名单传给 `RunOptions.allowedTools`；终答 `answer` 再经可选 DSL 后处理比对 `expected`。
- `RunOptions.allowedTools` 在 `AgentLoop` 的工具分派处拦截：白名单外工具不进入 `ToolRuntime`，直接回报"基因组未授权此工具"。这是 Block 工具白名单真正生效的点。
- 未注入 runner 时创建 `agent-output-v1` 场景直接 fail-closed；评测时 runner 抛错/超时记为 `pair.status=error`，不计命中、不给出绿灯。
- 预算：`maxMs / (用例数 × 2)` 限制单次调用，超时 `AbortController` 中止；未执行用例显式记为 error（**不再用稀疏数组**——那会让 `.reduce/.filter` 跳过空槽、悄悄扭曲统计口径）。
- 实测：`tests/maf-agent-loop.test.ts` 用 `createAgentOS` + MockProvider 证明 runner 计数 = 真实推理调用数 ≥16、提示片段进入模型请求、白名单外 `calc` 被真实 Loop 拦截；MockProvider 只用于测试，不作为能力分数。

## 2. 治理门禁修复

| 缺陷 | 修复 | 验证 |
| --- | --- | --- |
| `rollback` 用 `includes('"version":"…"')` 字符串匹配，`agent.propose` 同类审计行可绕过 | 改为结构化判定：`action==="agent.publish" && refs.agentId===x && refs.version===v`，且目标状态须为 active/retired | 实测：回滚到未发布 draft 被拒；回到曾发布版本成功 |
| 多实例 `audit.seq` 启动时按行数初始化，实测 `…9,9` | 复用编排器 `withLock`，`seq` 在锁内置为 `audit.jsonl` 行数；状态文件全部"锁内重读→改→原子写" | 实测两实例 seq 连续唯一；另一实例无需重启即可见发布与 releases |
| `publish` 把旧 active 置 retired 但只写新版本文件 | 旧版本逐个落盘 | 实测磁盘状态 = retired/active 一致 |
| 数据文件半写入被静默当空集，下次写入永久覆盖 | `read()` 存在但解析失败即抛错，fail-closed | 实测损坏文件启动报错 |
| MAF 目录锚在代码 `root/data/maf` 而非 `storage.dir`，e2e 测试往仓库真实账本写 | 改为 `join(storageDir, "maf")`；默认 `storage.dir=./data` 使生产路径不变 | 测试用临时数据目录，不再污染仓库 |

## 3. 白盒与访问边界

- 跨实例运行态：每实例每 1.5s 写 `data/runtime/active-<instanceId>.json` 心跳（只含 sessionId 与 ts），`/api/sessions` 与 SSE `snapshot/running-snapshot` 合并 6s 内所有实例心跳；白盒面板显示"跨实例 N · 运行中 N"。
- REST 最低鉴权：非回环监听（含 `0.0.0.0`）**必须**提供 `--token` 或 `AGENTOS_API_TOKEN`，否则拒绝启动；`/api/*` 校验 `Authorization: Bearer` 或 `?token=`（SSE 用）；Web 前端把 token 存 localStorage，401 时提示输入。
- 问责主体不再信任请求体自报：`publish/rollback/revoke/distill/promote-block` 的 `actor` 固定来自鉴权上下文（`local-user` / `token-owner`）。

## 4. 诚实边界（未变）

- 不是跨机集群：锁依赖单文件系统 `mkdir` 原子性；无共识、无 leader election、无网络分区处理。
- 单进程内多 server 共享一个 token 变量（当前实现）；多 token 隔离未做。
- 取消仍是协作式；灰度仍是状态机/影子双跑，不是真实流量 canary；`fold()` 无快照压缩。
- `exact-output-v1` 的 1ms 评测**从不**产生能力结论；`agent-output-v1` 只在真实判分任务上产生证据，仍需冻结模型下的外部基准与第三方复现才能谈领先。
