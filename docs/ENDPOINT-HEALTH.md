# 免 Key 端点体检与本地小模型（2026-11-09）

> 本文是**运行时链路/协议体检快照**，不是能力分数，也不是发布门禁。
> `leadership.verdict` 仍为 `not-proven`，L4 仍为 `not-achieved`。
> 端点状态会变，结论只对探测时刻成立；因此**不进 CI 门禁**（治理红线：测试只断言可复现的结构不变量）。

## 0. 为什么要做这次体检

v2.7/v2.8 的负结果里，免 Key 弱端点被笼统记为「链路故障 / 抖动」，本地 0.5B 被记为「Ollama 未启动」。
这两个记录都不够准确：前者把限流、额度、模型下架、连接超时混成一类；后者其实是**服务没起，模型一直在**。
本次把每个失败拆到可操作的原因，并据此修正 `agentos.config.json` 的优先级与模型名。

## 1. 判定口径

全部**匿名**调用（不带任何 `Authorization`），两层判定，缺一不可：

1. **链路层**：`POST /chat/completions` 返回 200 且有内容；
2. **协议层**：带 `tools` + `tool_choice:auto` 时返回**原生 `message.tool_calls`**。
   bro2 的 Agent Loop 靠 `tool_calls` 执行工具，模型把工具调用写进正文（text-json）等于任务静默失败。

`awesome-freellm-apis` 的 `STATUS.md` 只验「服务在线」，不验「免 Key 可调用」，两者不能混用。

## 2. 15 个端点实测归因

| 端点 | 匿名 chat | 原生 `tool_calls` | 失败原因 / 处置 |
| --- | --- | --- | --- |
| **kilo** | 200 | ✓ | 唯一能稳定跑多步基准的免 Key 端点 → 主力，`priority 10` |
| **ovhcloud** | 200 | ✓ | **本次新挖掘**：匿名免注册，21 个模型，含小模型 → 兜底，`priority 5`（限流约 3 次/窗口） |
| **llm7** | 200 | ✓ | 原配 `gpt-oss-120b` 已下架（400 `model_unavailable`）→ 改免费 `gpt-oss:20b` 复活，`priority 3`；连续第 2 请求即 429（Retry after 1s），靠重试/退避扛 |
| **pollinations** | 200 | ✗ | 第 2 次请求 402 `FREE_LIMIT`：1 reply / 45s / IP。Agent 多步调用必撞限流 → `priority 1` |
| **opencode-zen** | 429 | — | `FreeUsageLimitError`：免费额度耗尽，需订阅 → `priority 0` |
| **keylessai** | 超时 | — | `UND_ERR_CONNECT_TIMEOUT`（workers.dev 不可达）→ **`priority 4 → 0`** |
| aionlabs / modelscope / zhipu | 401 | — | 需要 API Key |
| groq / cerebras / mistral / chutes / glhf | 403 / 429 / 超时 / 526 | — | 需要 Key 或被边缘拦截 |
| huggingface | 连接超时 | — | `router.huggingface.co` 在本环境不可达 |

**关键教训**：列表里 31 家全标 🟢 Operational、537 个免费模型，但除 OVHcloud 明确写了
`no registration for anonymous tier` 之外，每家都挂着 "Get API Key" 链接。
**「免费额度」「无需信用卡」「服务在线」都不等于「免 Key 可调用」。**

## 3. 本地 0.5B：不是没模型，是没起服务

- GGUF 一直在：`${BRO2_LOCAL_GGUF:-/root/.cache/bro2-llm/qwen2.5-0.5b.gguf}`（380 MB）。
- 环境已有 `llama_cpp 0.3.36`，**无需安装 Ollama**（新版 Ollama 只剩 1.47 GB 的 `.tar.zst`，大文件在本环境会被链路掐断）。
- 只需补三个 server 依赖并起服务：

```bash
python3.11 -m pip install sse-starlette starlette-context pydantic-settings
python3.11 -m llama_cpp.server \
  --model "${BRO2_LOCAL_GGUF:-/root/.cache/bro2-llm/qwen2.5-0.5b.gguf}" \
  --model_alias qwen2.5:0.5b --host 127.0.0.1 --port 11434 \
  --n_ctx 4096 --n_threads 16 --n_batch 512 \
  --chat_format chatml-function-calling --verbose false
```

- **bro2 preflight 判定 PASS**：`/v1/models`、chat、SSE 流式、原生 `tool_calls` 全通。
  强 system prompt 引导下能返回规范 `probe_ping({"value":"hello-agent-os"})`。
- **但它是弱模型**：弱引导时会退化成正文文本（如 `functions.read_file:`）、对 prompt 敏感、
  首次流式约 28 s，能力明显弱于 kilo。
- 结论：链路稳定 + 能力明显更弱，但**准入实测 0/3、全部 0 工具调用**（见 `docs/BENCH-v2.md` §5.6），
  卡在第三条准入判据（无故障基线能通过一部分任务）。0.5B 属于「能力下限」，不是合格弱模型对照。

## 3.1 中等模型（3B）与本机资源约束

为跨过能力下限，自主下载了 `qwen2.5:3b`（1.8 GB GGUF，Ollama registry 匿名 blob，
`sha256:5ee4f07c…`），同样用 `llama_cpp.server` 起服务（端口 11435）。
**协议层实测通过**：chat 正常、带强引导时返回规范原生 `tool_calls`。

但本机 `cgroup memory.max = 8 GB`（`memory.events` 有 `oom_kill 1`）：
- 同时开 0.5B + 3B 两个服务 + 门禁并发 → 3B 被 OOM killer 杀掉（`exit 137`）；
- 停掉 0.5B、3B 降配（`n_ctx 2048 / n_threads 8 / n_batch 128 / no mlock`）→ warmup 正常；
- 一旦跑多步 live 评测，`bench:v2` 的接入预检会因冷启动 > 30 s 探针窗口被拒，
  或触发连续空响应拦截，`stopReason = provider_error`，无法产出 `completed` 轨迹。

**结论**：这是**环境资源约束**（8GB 内存 + 纯 CPU 撑不住中等模型的多步推理），
不是「3B 能力不够」。按「`provider_error` ≠ 能力弱」红线，三次 `provider_error` 报告
均已删除、不进证据集；`leadership.verdict` 不变。补齐路径是换有足够内存 / GPU 的环境
在此 `local-qwen3b` provider 上重跑准入，而不是再找更多限流端点。

> 环境检查：`cat /sys/fs/cgroup/memory.max`、`cat /sys/fs/cgroup/memory.events`。
> 起服务前先看 `memory.current`，避免多服务并发触发 OOM。

## 4. 聚合器优先级修复（实际 bug）

修正前 `keylessai` 被设为 `priority: 4`，而 smart-fallback 的打分把 priority 当主权重——
**首次请求会优先打到一个已确认连接超时的端点，白等一次超时**，与实测健康度完全相反。
现按体检结果重排：`kilo 10 > ovhcloud 5 > llm7 3 > pollinations 1 > opencode-zen / keylessai 0`，
并同步修正 `keyless.backends` 的显式顺序与 `llm7` 的模型名。

## 5. 诚实边界

- 本轮修复的是**可用性与配置正确性**（目标 2：低成本高容错），不是能力分数，不推动 `verdict`。
- 限流型端点（ovhcloud / llm7 / pollinations）协议可用但**跑不了多步基准**，
  因此不能用来补「弱模型下 harness 增益更大」的结论；该结论只能由本地 0.5B 的实测给出。
- 端点状态随时变化，本表是快照；恢复后再提权，不要写死「永久不可用」。
