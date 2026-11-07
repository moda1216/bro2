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

> 免费模型列表变动频繁，以各家控制台为准；`:free` 后缀模型通常限速但真免费。
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

## 五、探针脚本

`npm run free:probe`（`examples/free-api-probe.ts`）会对所有已注册免费服务执行 `probe()`，
输出每个端点的 `networkReachable / authRejected / toolCalling / streaming`。
未填 Key 时只报告传输层状态（不消耗额度），是接入前的最佳健康检查。

---

## 六、诚实提醒

- 免费额度会随时收紧（2025–2026 已有多家调整政策），建议备 2–3 家轮切。
- 不要为"刷分"滥用免费额度；bro2 的 `preflight` 门禁会在端点故障时 `EXIT=1` 并拒绝写低分报告，
  避免把"配额耗尽 / 网络抖动"误判成"模型/ harness 弱"。
- 免费 API **不**改变 bro2 的治理不变式：协议违规零容忍、holdout 严格提升、只增账本——见 `RSI.md`。
