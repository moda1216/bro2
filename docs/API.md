# bro2 · REST / SSE API 参考

> 零依赖 `node:http` 实现，启动：`npm run web`（默认 `http://127.0.0.1:3080`）。
> 所有响应带 CORS 头；SSE 使用标准 `event:` / `data:` 帧。

---

## 1. 端点总览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | Web UI（单页：对话流 / 工具卡片 / Trajectory 轨迹 / 审批弹窗） |
| GET | `/api/status` | 运行时状态：模型、工具、Preset、技能、插件、指标、**已落地演进配置** |
| GET | `/api/sessions` | 最近 60 个会话 |
| POST | `/api/sessions` | 新建会话 `{ "preset": "standard" }` → 201 `{ session }` |
| POST | `/api/fork` | 从 Trajectory 分叉会话 `{ "sessionId": "..." }` |
| GET | `/api/trace?session=<id>&limit=300` | 会话只增事件流 + 统计 |
| GET | `/api/metrics` | 实时指标快照 + 最近 60 条 |
| GET | `/api/approvals` | 待审批列表 |
| POST | `/api/approvals/<id>` | 提交审批 `{ "decision": "approve" \| "deny" \| "always" }` |
| POST | `/api/plugins` | 热插拔插件 `{ "name": "tool-audit" }`（可逆副作用） |
| POST | `/api/connectors/http` | 挂载 HTTP MCP 连接器 `{ "name", "url" }` |
| POST | `/api/model` | 切换默认 provider `{ "name": "ollama" }` |
| POST | `/api/chat` | **SSE 流式对话** `{ "sessionId"?, "text", "preset"? }` |
| OPTIONS | `*` | 预检，204 |

未知路由返回 `404 { "error": "未知路由: METHOD PATH" }`。

---

## 2. `/api/status` 关键字段

```json
{
  "name": "bro2",
  "model": "mock",
  "models": [{ "name": "mock", "active": true, "failures": 0, "coolingDown": false }],
  "permission": "workspace-write",
  "tools": ["...26 个工具..."],
  "presets": ["..."],
  "skills": ["..."],
  "plugins": { "loaded": ["tool-audit"], "available": ["..."] },
  "metrics": { "events": 0, "toolCalls": 0, "toolFailures": 0 },
  "evolution": {
    "loopDetectionThreshold": 2,
    "compactTokens": 36000,
    "stateFile": "data/evolve/state.json",
    "policy": {
      "loopDetection": "exact",
      "malformedArgs": "repair",
      "grounding": "require-evidence",
      "compaction": "salience",
      "parallel": "risk-first"
    },
    "meta": { "plateauPatience": 1, "evidenceLimit": 12, "...": "..." }
  },
  "sessionCount": 3
}
```

`evolution.policy` 是**已通过 train/holdout 双门禁并真正作用到运行时**的行为策略；
`evolution.meta` 是**已通过冻结 fitness 晋升并作用于下一次 evolve** 的元状态。
评测器显式用 `evolvedState: false` 隔离该通道，防止改进反作用于验证。

---

## 3. SSE 对话事件

`POST /api/chat` 返回 `text/event-stream`，事件类型：

| event | data | 时机 |
| --- | --- | --- |
| `session` | `{ sessionId }` | 连接建立（未传 sessionId 时自动建会话） |
| `chunk` | `{ kind: "text"\|"tool_call"\|"done", text }` | 模型流式输出 |
| `event` | 完整 `Event` 对象 | 任意内核事件（工具调用/结果、审批、Guard、压缩、修复、接地打回等） |
| `done` | `RunResult` | 任务结束 |
| `error` | `{ error }` | 运行异常 |

保活心跳每 15s 发 `: ping`。连接随 `done` / `error` 关闭，事件订阅自动 dispose。

新增的可观测事件类型（策略层）：`tool.repair`、`grounding.reject`、`guard.advisory`；
`context.compaction` 的 payload 额外带 `strategy` 与 `evidenceKept`。

---

## 4. 示例

```bash
# 状态
curl -s http://127.0.0.1:3080/api/status | python3 -m json.tool | head -30

# 建会话
SID=$(curl -s -X POST http://127.0.0.1:3080/api/sessions \
  -H 'content-type: application/json' -d '{"preset":"standard"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['session']['id'])")

# SSE 流式对话（-N 禁用缓冲）
curl -sN -X POST http://127.0.0.1:3080/api/chat \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"text\":\"计算 sum([1,2,3]) 并写入 api-demo.md\"}"

# 轨迹
curl -s "http://127.0.0.1:3080/api/trace?session=$SID&limit=50" | python3 -m json.tool

# 切换真实模型（需先配置环境变量并启动服务）
curl -s -X POST http://127.0.0.1:3080/api/model \
  -H 'content-type: application/json' -d '{"name":"ollama"}'
```

---

## 5. 模型接入与诊断

- `GET /api/status` 的 `models` 列出已注册 provider 及熔断状态。
- 端点可达性 / `tool_calling` 能力探测走 CLI：`npm run doctor`（面向人）；CI 门禁用 `npm run preflight`（`ready=PASS` 才 `EXIT=0`，支持 `--provider` / `--all` / `--json`），见 [EVAL.md](../EVAL.md) 与 [docs/TAKEOVER.md](./TAKEOVER.md)。
- Ollama 本地免 API Key；`baseUrl` 需带 `/v1` 前缀。小模型若不支持原生 `tool_calls`，Agent 会**静默退化为纯聊天**，务必先跑 `doctor`。

---

## 6. 安全边界

- 服务默认绑定 `127.0.0.1`，不对外暴露；CORS 为 `*`，若需公网访问应加反向代理与鉴权。
- 权限沙箱是**应用层路径白名单**（`data/workspace` / `data/scratch`），非 OS 级隔离。
- 高危操作默认进入 HITL 审批；`--auto-approve` 仅用于 headless / CI。
- 密钥只从环境变量读取，日志中只出现引用名并做脱敏。
