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

## 6. 运行时如何开启跨会话端点经验（v2.12.0，opt-in）

体检结论若只停在文档，新进程仍会重新撞一遍已知死端点。v2.12.0 把它接成闭环：
在 `agentos.config.json` 的 `keyless` provider 上显式打开

```jsonc
"useEndpointExperience": true
// 可选："experienceFile": "/path/to/experience.jsonl"（缺省 data/rsi/experience.jsonl）
```

装配层从只增账本折叠跨会话先验注入 `score()` 排序，每次上游成败再回写同一账本；
`meshStats()` 可查看每端点先验。**默认关闭**：确定性评测与 CI 不写被跟踪账本、
不制造假 diff、不携带本机状态；先验为空时行为与 v2.11.0 一致。
先验只影响排序，绝不绕过冷却 / 限流 / 能力感知的硬过滤；失效或样本不足自动归零、
回退完整探测。离线验证见 `npm run endpoint:check`（第 20 道门禁，13/13）。

## 7. 1.5B 中间档与「流式工具调用」陷阱（v2.13.0 · 含 §3.1 结论修正）

用户质疑「3B 跑不动可以换更小的」。实测 `qwen2.5:1.5b`（941MB GGUF，Ollama
registry 匿名 blob `sha256:183715c435899…`），**完全跑得起来**：

```bash
python3.11 -m llama_cpp.server \
  --model /root/.cache/bro2-llm/qwen2.5-1.5b.gguf \
  --model_alias qwen2.5:1.5b --host 127.0.0.1 --port 11436 \
  --n_ctx 4096 --n_threads 4 --n_batch 128 \
  --chat_format chatml-function-calling --verbose false
```

配置 `local-qwen15b` 加了 `"stream": false` 与 `"maxTokens": 128`（v2.13.0 为 256，
v2.14.0 为压低纯 CPU 单步生成时长下调）。`n_ctx` 取 **4096**：2048 会撞
`HTTP 400`（system prompt + 工具定义约需 3700 tokens），8192 冷启动撞 30s 探针窗口，
4096 是本机 8GB 下的折中。实测冷启动约 10s（含 warmup）、稳态内存
3.4~4.3GB / 8GB，`oom_kill 0`；warmup 后 `preflight` **✓ PASS**（676ms）。

**真正的病根**：llama.cpp server 的 `chatml-function-calling` handler 在
`stream: true` + `tool_choice: auto` + tools 下抛
`ValueError: Automatic streaming tool choice is not supported`，零 `tool_calls`；
非流式则正常返回规范工具调用。而 bro2 的 `complete()` 过去硬编码流式，
`probe()` 又把「非流式带 tools」与「流式普通应答」分开测，从未覆盖 live 真正走的
组合 → preflight 全绿、Agent 零工具调用。v2.13.0 把传输模式改为 provider 可配
（默认仍流式）并补上组合探针，详见 `docs/BENCH-v2.md` §5.9。

**三个曾把测量挡在门外的配置坑**（都不是能力或内存结论）：
`n_ctx 2048` 撞 `HTTP 400 requested 3695 tokens`（Agent 光 system prompt + 工具定义
就要约 3700）；请求无 `max_tokens` 让弱模型生成到上下文上限、单 worker 被占死
（表现为「端点不可达」但端口在监听）；大 `n_ctx` 冷启动撞 30s 探针窗口。
处理分别是 `n_ctx 4096`、provider 配 `maxTokens`、评测前 warmup，**未调门禁阈值**。

**§3.1 结论修正与负结果**：本机纯 CPU 多步 live 评测仍在 18 分钟后挂起，
无法产出 `completed` 轨迹；3/3 全 `provider_error` 的报告按红线删除、不进证据集。
结论是「本机算力不足以完成多步评测」，不是「1.5B 能力不够」，也不是
「必须换更大内存」。同理，§3 把 0.5B 归因为「能力下限」不再成立——那批
0 工具调用发生在链路缺陷之下，不构成能力证据，需重测（v2.14.0 已重测，见 §8）。

---

## 8. 链路修通后的单步重测（v2.14.0 · 最终归因）

`npm run weak:probe`（`examples/weak-single-step.ts`）用最短单步任务重测，红线写死
「只有 `completed` + 协议零违规才算有效测量」；`cancelled` / `guard` /
`provider_error` 一律记 `insufficient-runtime`，不进证据集。

| 尝试 | 停止原因 | 步数 / 工具调用 | 协议违规 | 耗时 |
| --- | --- | --- | --- | --- |
| ① `t01` | `cancelled`（600s 墙钟） | 3 / 2 次 `calc` | 0 | 600s |
| ② 单步探针 | `guard` | 3 / 2 次 `calc` | 0 | 773s |
| ③ 单步探针（放宽步数） | `guard`：**连续 3 次相同工具调用，判定为死循环** | 3 / 2 次 `calc` | 0 | 818s |

- warmup：非流式 + 带 tools 返回**规范 `tool_calls`**（10.3s）→ v2.13.0 的适配修复确实生效。
- **链路结论（已证）**：修复前本地端点 0 工具调用，修复后同一 1.5B 发起 2 次原生
  `calc` 调用、协议 0 违规 → §3 / `docs/BENCH-v2.md` §5.6 的「能力下限」结论彻底撤销。
- **能力结论（未测出）**：三次都无 `completed` 轨迹，「1.5B 能否完成一次工具任务」
  仍是未测出，不写「太弱」也不写「够用」。
- **瓶颈归因**：纯 CPU 单步约 250~270s；③ 的守卫原文是死循环检测
  （模型反复调用同一工具、不给终答），这是**行为信号**而非配置问题。
  再放宽 `loopDetectionThreshold` 只会掩盖测量事实，因此不再重跑。
  仍**不是「必须换更大内存」**：1.5B 稳态 3.4~4.3GB / 8GB、无 OOM。

报告 `data/bench/v2-localqwen15b-admission.json`（`measurementValid: false`，
含 `linkProbe` 链路证据）；完整判据见 `docs/BENCH-v2.md` §5.11。
