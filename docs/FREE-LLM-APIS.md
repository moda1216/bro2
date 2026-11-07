# 免费 LLM API 接入指南（bro2 · 无需本地大模型）

> 结论先说：**本地只能跑 0.5B 小模型，不等于无法验证 bro2 的业界水平。**
> 几乎所有主流服务都提供 OpenAI 兼容接口，bro2 的 `OpenAICompatProvider` 直接复用即可。
> 拿到一个免费 Key（多数无需信用卡），一条 `npm run eval:live` 就能用真实强模型测 bro2 的 harness。

---

## 一、为什么这能补齐"本地小模型"的短板

bro2 验证"业界水平"有两层含义，二者都被免费 API 解决或显著推进：

1. **真实模型能力评测**：本地 0.5B 的 `overall 0.0%` 只说明小模型弱，不代表 harness 差。
   免费 API 提供 8B–550B 级真实模型，能让 bro2 在真执行器上跑 `eval:live`，得到有意义的分数。
2. **harness 工程质量的 SOTA 对齐**：bro2 的 RSI / 元 RSI / 对比式改进（见 `docs/RSI-NEXT.md`）
   不依赖模型大小，可在冻结模型下持续进化；免费 API 只是让它有"真执行器"可测。

> 诚实边界：免费 API 证明的是 **harness × 真实模型** 的联合表现；bro2 的
> `leadership.verdict = not-proven` 不变——要宣称行业领先仍需公开基准（BFCL / τ-bench /
> GAIA / SWE-bench）对齐与第三方复现。免费 API 把"跑真实模型"这一步从不可能变成一行命令。

---

## 二、沙箱实测可达性（2026-11-07）

用 `curl -m6 -o /dev/null -w "%{http_code}"` 探测 `/v1/models`，结果如下（仅看传输层，不验证鉴权）：

| 服务 | HTTP | 含义 |
|---|---|---|
| **OpenRouter** | `200` | 端点可达，部分 `/models` 公开 |
| **NVIDIA NIM** | `200` | 端点可达 |
| SiliconFlow（硅基流动） | `401` | 可达，需鉴权（国内直连） |
| DeepSeek | `401` | 可达，需鉴权 |
| Groq | `403` | 可达，需鉴权 |
| Google Gemini | `000` | 本沙箱网络不可达（需代理） |
| Fireworks | `404` | 路径变更，用 `/inference/v1` |

> `200 / 401 / 403` 都表示**网络与端口是通的**；只有 `000` 是真正被网络阻断。
> 跑 `npm run free:probe` 可让 bro2 的 `probe()` 对每个服务给出更细的结论
> （可达 / 需 Key / 原生 tool_calls / SSE 流式）。

---

## 三、免费服务清单（OpenAI 兼容，已在 `agentos.config.json` 注册）

所有服务均为 `type: "openai"`，bro2 自动按 `baseUrl + apiKeyEnv + model` 接入。

| 服务 | 配置名 | baseUrl | Key 环境变量 | 推荐免费模型 | 速率限制 |
|---|---|---|---|---|---|
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `openai/gpt-oss-120b`、`nvidia/nemotron-3-ultra-550b-a55b:free`、`google/gemma-4-31b-it:free` | 免费模型 50–1000 RPD（充 $10 信用后放宽，用免费模型不扣费）|
| NVIDIA NIM | `nvidia-nim` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_NIM_API_KEY` | `nvidia/nemotron-3.5-super-vl-120b-a12b`、`deepseek-ai/deepseek-v4.1-flash` | 40 RPM |
| SiliconFlow | `siliconflow` | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`、`Qwen/Qwen3-8B` | 1000 RPM/模型（部分小模型永久免费）· 国内直连 |
| DeepSeek | `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `deepseek-chat`（新户送额度）| 按额度 |
| Groq | `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `openai/gpt-oss-120b`、`qwen/qwen3-32b` | 30 RPM / 1000 RPD（免费 tier）|
| **Pollinations** | `pollinations` | `https://text.pollinations.ai/openai/v1` | （**无需 Key**，`apiKeyOptional:true`）| `openai`（路由到 `gpt-oss-20b`）| 匿名层约 1 回复/45s/IP（`402 FREE_LIMIT`）|
| **Kilo Gateway** | `kilo` | `https://api.kilo.ai/api/gateway/v1` | （**无需 Key**，`apiKeyOptional:true`）| `kilo-auto/free`（自动路由到免费强模型，如 `beam-free`/`nemotron-3.5-super-vl`）| 约 200 请求/小时/IP；**实测支持原生 tool_calls** |
| **OpenCode Zen** | `opencode-zen` | `https://opencode.ai/zen/v1` | （**无需 Key**，需 `x-session-id`，适配器自动生成）| `nemotron-3.5-lightning-free` 等 `-free` 模型 | 匿名免费层；沙箱 IP 可能触达免费额度上限（换 IP 即恢复）|
| **LLM7** | `llm7` | `https://api.llm7.io/v1` | （**无需 Key**，`apiKeyOptional:true`）| `gpt-oss-120b` 等 | 免 Key 聚合端点；**免费模型子集不稳定**，仅作可达性核验 |

> 免费模型列表变动频繁，以各家控制台为准；`:free` 后缀模型通常限速但真免费。
> **Pollinations 是已实测可用的「无 Key」端点**：`pollinations` 已注册进 `agentos.config.json`，
> `apiKeyOptional:true` 且 `POLLINATIONS_API_KEY` 不设置时走匿名层。沙箱实测 6/6 通过 preflight，
> 且 `eval:live` 真跑出分数（见第六节），**全程零 API Key、零注册**。
> 数据来源：`github.com/for-the-zero/Free-LLM-Collection` 与各家官方文档（2026-11 抓取）。

---

## 四、一条命令跑真实强模型评测

```bash
# 1) 取一个免费 Key（OpenRouter 注册即给，无需信用卡）
export OPENROUTER_API_KEY=sk-or-...
export OPENROUTER_MODEL=openai/gpt-oss-120b      # 120B 级，远强于本地 0.5B

# 2) 先过接入门禁（确认可达 / 原生 tool_calls / SSE）
AGENTOS_LIVE_PROVIDER=openrouter npm run preflight

# 3) 跑真实评测，拿第一份"强模型"分数
AGENTOS_LIVE_PROVIDER=openrouter npm run eval:live
```

换 NVIDIA NIM / SiliconFlow / DeepSeek / Groq 仅改 `AGENTOS_LIVE_PROVIDER` 与对应的 `*_API_KEY` / `*_MODEL`。
`eval:live` 写入 `data/eval-live-report.json`，与确定性报告 `data/eval-report.json` 证据面隔离。

---

## 五、无 Key 匿名端点（已实测可用）

> 上一轮结论「免费 ≠ 免密钥」在主流平台成立，但**确实存在一批公共匿名端点/开源网关**，
> 不要求注册与 Key。bro2 已接入其中验证可用的 **Pollinations**：

```bash
# 无需任何 Key —— 直接跑（匿名层，per-IP 限速）
AGENTOS_LIVE_PROVIDER=pollinations npm run preflight   # 6/6 PASS（含原生 tool_calls、SSE）
AGENTOS_LIVE_PROVIDER=pollinations npm run eval:live   # 真实模型评测，零 Key
```

**第一份无 Key 真实分数**（2026-11-07，沙箱实测，`data/live-pollinations-gptoss20b.json`）：

| 指标 | 值 | 说明 |
|---|---|---|
| 模型 | `gpt-oss-20b`（经 Pollinations 匿名层）| OpenAI 开放权重 20B |
| 总体得分 | **25%（3/12）** | 真实模型，非脚本执行器 |
| 协议违规 | **0** | harness 在真实模型下仍保持工具调用完整性 |
| 平均延迟 | **89,492 ms/任务** | 受匿名层 ~45s/IP 限速拖累 |
| 工具错误率 | 47.1% | 含限速重试超时，部分非模型能力问题 |

> **如何读这个分数**：25% 是真实模型在受限匿名端点上的**下界**——它受到两层压制：
> (1) 模型本身是 20B 开放权重，弱于 120B+ 闭源模型；(2) 匿名限速把每任务拖到 ~90s，
> 触发超时与重试错误。但 **0 协议违规** 是 harness 自身的正面证据：工具调用配对、Guard、
> 终止逻辑在「真模型」下依然不崩。这同时印证了「Mock 100% 只说明 Harness 正确」的判断——
> 与确定性 Mock 基线对比的「1→0.25」是预期差距，不是回归。

---

## 六、本地 + 远程协同，减少远程调用（核心反向优化）

无 Key 端点虽然免费，但**限流极严**（Kilo ~200 次/小时/IP、Pollinations ~1 次/45s/IP）。
bro2 不止"能接"，还把"本地部署的小模型"和"远程强模型"组合成一个 `hybrid` provider，
**在保持任务能力的同时，显著降低远程调用次数**——这正是"远程模型 API 反过来优化 bro2"的关键。

`hybrid` 在 `agentos.config.json` 中这样定义（已内置）：

```json
"hybrid": {
  "type": "hybrid",
  "remote": "kilo",            // 远程强模型（免 Key 端点）
  "local": "local-qwen",       // 本地小模型（llama.cpp，零调用成本）
  "policy": "cheap-to-local",  // 启发式路由：便宜的调用留本地
  "cache": true,               // 缓存优先：相同提示零调用
  "fallback": true             // 远程限流/5xx 时降级到本地而非失败
}
```

三层降调用机制：
1. **缓存优先（cache-first）**：相同 `(model+messages+tools+temperature)` 的请求命中缓存，
   零调用（无论本应走本地还是远程）。
2. **启发式路由（cheap-to-local）**：无工具的纯生成、工具结果整理等"便宜"调用路由到本地小模型；
   需要推理/工具选择的才走远程强模型。
3. **限流降级（rate-limit-fallback）**：远程返回 `429 / FreeUsageLimit / 5xx` 时，自动降级到本地，
   既保韧性，又避免对远程端点反复重试打满限额。

每次评测后，`eval:live` 报告里会带 `inference` 指标，量化"省下的远程调用"：

| 字段 | 含义 |
|---|---|
| `remoteCalls` | 真正打到远程强模型的次数 |
| `localCalls` | 打到本地小模型的次数（含降级） |
| `cacheHits` | 缓存命中、零调用的次数 |
| `remoteAvoided` | 因缓存/降级而避免的远程调用总数 |
| `remoteCallRatio` | 远程调用占比（越低越好） |

实测演示（`npm run hybrid:demo`，5 次相同工具调用 + 2 次纯生成）：
`remoteCalls=1 / localCalls=2 / cacheHits=4 / remoteAvoided=4`，**远程占比从 100% 降到 14.3%**。

> 该机制与 RSI 形成闭环：对比式改进（`src/rsi/contrast.ts`）可把
> "remoteAvoided 提升而分数不降"作为一条真实的改进目标，持续反哺 bro2。
> 详见 `docs/ROADMAP.md` 的「混合推理」工作流，与 `src/models/{cache,hybrid}.ts`。

---

## 七、探针脚本

`npm run free:probe`（`examples/free-api-probe.ts`）会对所有已注册免费服务执行 `probe()`，
输出每个端点的 `networkReachable / authRejected / toolCalling / streaming`。
未填 Key 时只报告传输层状态（不消耗额度），是接入前的最佳健康检查。

---

## 七、诚实提醒

- 免费额度会随时收紧（2025–2026 已有多家调整政策），建议备 2–3 家轮切。
- 不要为"刷分"滥用免费额度；bro2 的 `preflight` 门禁会在端点故障时 `EXIT=1` 并拒绝写低分报告，
  避免把"配额耗尽 / 网络抖动"误判成"模型/ harness 弱"。
- 免费 API **不**改变 bro2 的治理不变式：协议违规零容忍、holdout 严格提升、只增账本——见 `RSI.md`。
