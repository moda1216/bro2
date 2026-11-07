# bro2 · 本地真实模型推理服务（沙箱路线 B）

> 当目标环境**装不上 Ollama 二进制**时，用 `llama.cpp` + **Ollama 官方 registry 的 GGUF 权重**
> 提供与 Ollama `/v1` 等价的 OpenAI Chat Completions 契约，让 `doctor` / `preflight` /
> `eval --mode live` 无需改动一行代码即可接入，跑出**真实模型推理**分数。
>
> 相关：[TAKEOVER.md](./TAKEOVER.md)（真机路线 A）· [EVAL.md](../EVAL.md)（指标口径）· [BENCHMARK.md](../BENCHMARK.md)（领先判据）

---

## 0. 为什么需要这条路线（本沙箱实测，2026-11-07）

| 探测项 | 实测结果 |
| --- | --- |
| `ollama.com` / `registry.ollama.ai` / `github.com` 网页 | HTTP 200 可达 |
| GitHub Release 资产（含 15KB 的 `sha256sum.txt`） | **全部超时 `http=000`** |
| GitHub 代理（8 个并发筛选） | 最快 ~250KB/s，1.5GB 官方包需 ~1.7 小时；多数 000 / 429 |
| 清华 / 中科大 / 阿里 / 腾讯的 GitHub Release 镜像 | 均无 Ollama（404） |
| **`registry.ollama.ai`（Ollama 官方模型仓库）** | **2.28MB/s 可用**，`qwen2.5:0.5b` 权重 398MB 约 3 分钟 |
| pypi 镜像 / hf-mirror | 可用 |
| `nproc` | 32（宿主机视图，**误导**） |
| `cpu.max` | `400000 100000` → **实际仅 4 核配额** |
| `memory.max` | **8GB**（`free` 显示的 123Gi 是宿主机） |
| GPU / Ollama / API Key | 无 |

结论：**官方 Ollama 二进制被出口策略堵死，但真实权重与推理能力都在**。Ollama 只是服务端实现，
bro2 的接入契约是 OpenAI Compat，因此换一个提供同一契约的本地推理服务即可。

---

## 1. 组件与真实性

| 组件 | 来源 |
| --- | --- |
| 权重 | `registry.ollama.ai/v2/library/qwen2.5/blobs/sha256:c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515`（**Ollama 官方仓库**，qwen2.5:0.5b GGUF，397807936 bytes） |
| 推理引擎 | `llama-cpp-python` 0.3.36 预编译 CPU wheel |
| 端点 | `tools/local-llm-server.py`（Python 标准库 HTTP + SSE，零 Web 框架依赖） |
| 契约 | `GET /v1/models`、`POST /v1/chat/completions`（流式 / 非流式 / `tools` / `tool_calls`） |

**每个请求都执行真实 CPU 前向推理**，不是脚本化仿真。服务端把执行统计写到
`data/local-llm-stats.json`（`requests` / `promptTokens` / `completionTokens` /
`toolCallsEmitted` / `inferenceSeconds`），可作为「确实跑了推理」的旁证。
该文件**不是能力分数**，不参与证据阶梯判定。

---

## 2. 可复现命令

```bash
# 2.1 取 Ollama 官方权重
mkdir -p /root/.cache/bro2-llm
curl -fL -o /root/.cache/bro2-llm/qwen2.5-0.5b.gguf \
  https://registry.ollama.ai/v2/library/qwen2.5/blobs/sha256:c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515
# 校验：397807936 bytes，前 4 字节 = "GGUF"

# 2.2 装推理后端
pip3 install --break-system-packages llama-cpp-python==0.3.36
# 若只有 sdist 且内存受限（8GB 下 32 并行编译会 OOM）→ 用预编译 wheel：
#   https://github.com/abetlen/llama-cpp-python/releases/download/v0.3.36/
#     llama_cpp_python-0.3.36-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl
#   经 gh-proxy.com 代理下载（~26MB），保存为**原始 wheel 名**后 pip install ./<name>.whl

# 2.3 起服务 —— 线程数必须对齐真实 CPU 配额，别信 nproc
cat /sys/fs/cgroup/cpu.max          # 400000 100000 = 4 核
LOCAL_MAX_TOKENS=128 python3 tools/local-llm-server.py \
  --threads 4 \
  --model /root/.cache/bro2-llm/qwen2.5-0.5b.gguf \
  --model-id qwen2.5:0.5b --port 11434 \
  --stats-file data/local-llm-stats.json

# 2.4 接 bro2（另一个终端）
export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
export OLLAMA_MODEL=qwen2.5:0.5b
export AGENTOS_LIVE_PROVIDER=ollama
npm run doctor && npm run preflight && npm run eval:live
# → data/eval-live-report.json 才是「模型 + 框架」的真实分数
```

---

## 3. 实测踩过的坑（都已修）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| `pip` 编译报 `Killed signal terminated program cc1plus` | ninja 按 `nproc=32` 并行，8GB 内存被 `cc1plus` 打爆（OOM） | 改用预编译 wheel；或 `CMAKE_BUILD_PARALLEL_LEVEL=2` 重编 |
| GitHub Release 连 15KB 校验文件都下不了 | 出口策略 | 只从 `registry.ollama.ai` / pypi 取；wheel 走代理 |
| `Invalid wheel filename (wrong number of parts)` | 保存名 `llama_cpp_python.whl` 不符合 PEP 427 | 重命名为原始 wheel 名 |
| **单次 9-token 请求耗时 24s、每个评测任务 ~100s** | `--threads 8` 超订阅 4 核配额，`nr_throttled=8015` 次 cgroup 限流 | **`--threads 4`** → 短请求 0.09s、带 tools 6.8s（提速 15–250×） |
| qwen2.5 模板把工具调用输出成 `<tool_call>` 文本，`tool_calls=null` | Ollama 模板行为 | `chat_format="chatml-function-calling"`（llama.cpp 官方 handler）产出标准 `tool_calls` |
| `preflight` 流式探测提前 cancel | 客户端只读首个 chunk | 服务端 `Connection: close` + 捕获 `BrokenPipeError` |

---

## 4. 端点契约

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/models` | GET | 返回 `{data:[{id:"qwen2.5:0.5b"}]}`，`doctor` / `preflight` 据此校验模型名 |
| `/v1/chat/completions` | POST | `messages` / `tools` / `tool_choice` / `temperature` / `max_tokens` / `stream` / `stream_options` |
| `/health` | GET | 后端标识、`isRealInference: true` |
| `/stats` | GET | 真实推理累计统计 |
| `/api/tags` | GET | Ollama 风格模型清单（兼容） |

响应头会标明实现，便于审计：`X-Local-LLM-Backend`、`X-Local-LLM-ToolFormat`、
`X-Local-LLM-Streaming`。

---

## 5. 诚实边界（必须随结果一起复述）

- **不是 Ollama 二进制**：是 `llama.cpp` 提供等价 OpenAI Compat 契约。bro2 无需改代码，
  但服务端实现、模型加载器、量化内核与真机 Ollama 不同，**不可视为同配置对比**。
- **不是仿真端点**：每次请求真实执行 CPU 前向推理；权重来自 Ollama 官方仓库。
- **工具调用有协议适配**：`chatml-function-calling` handler 把模型输出的函数调用意图
  序列化为 OpenAI `tool_calls`，与 Ollama `/v1` 兼容层的职责相同。
  **不宣称模型原生输出结构化 `tool_calls`**。
- **流式为 buffered-sse**：先完成一次完整真实推理，再按 SSE 分片下发；不冒充逐 token 流式。
  `usage` 为 llama.cpp 返回的真实 token 计数。
- **CPU-only / 单模型 / 0.5B / 4 核配额**：分数只代表这一具体配置，不能外推到更大模型、
  GPU 或云端，更不能据此宣布「行业领先」。
- 本路线**不写** `data/benchmark/external-results.json`、**不进**证据阶梯 L4、
  **不改** `leadership.verdict`（仍 `not-proven`）。要往 L4 走，仍需公开基准、≥3 个
  provider 对照矩阵与第三方独立复现，见 [TAKEOVER.md §2–§4](./TAKEOVER.md)。

---

## 6. 第一份真实分数（本沙箱实测）

按 §2 起服务 → `preflight` 六项门禁全绿 → `npm run eval:live`，产出 `data/eval-live-report.json`：

| 指标 | 实测值 |
| --- | --- |
| 总体得分 / pass@k | **0.0% / 0.0%** |
| 通过任务 | **0 / 12**（live 跳过 7 项脚本化用例） |
| 门禁 | **FAIL**（9 条阈值全部触发，`EXIT=1` 是门禁对真实低分的正常判负，不是崩溃） |
| 协议违规 / 工具错误率 / Guard | **0 / 0.0% / 0.0%** |
| 平均步数 / 工具调用 / 平均延迟 | 1 / 0 / 108151 ms |
| 相对基线 | `1 → 0`（确定性 Mock → 真实 0.5B） |

服务端累计统计：18 次真实 CPU 前向推理、13 次流式、35446 prompt tokens、105 completion tokens、
累计推理 1316s、`errors=0`。

**读法**：0 分真实、未粉饰；失败模式是「1 步 / 0 工具调用」—— 0.5B 模型在 26 个工具定义下不发起工具调用。
协议违规 0 / 工具错误率 0 说明 Harness 链路正常，故不能归因框架；单模型 + 内部任务集也不构成外部比较证据。
确定性报告保持 `mode=deterministic / overall=1`，`external-results.json` 未创建，`verdict` 仍 `not-proven`、L4 仍 `not-achieved`。
