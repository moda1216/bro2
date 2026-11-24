# 真机验证 Runbook（Apple Silicon / MLX / GGUF）

> 状态：**流程闭环已建，真机未执行**。本沙箱无 Apple Silicon / MLX / powermetrics，
> 下列步骤需在 24G 统一内存的 Mac 上人工执行。`verdict=not-proven`、`L4=not-achieved` 不变。

## 为什么需要真机

审计（DEEP-REWRITE-AUDIT H1 / 需求6）判定：
- 本地自治真机跑通 = **NOT-PROVEN**（唯一真实推理是 qwen2.5:0.5b CPU）；
- 能效系统测量 = **NOT-PROVEN**（whitebox 的 token 是构造值）。
 adapter.ts 的 11/11 是**预算公式自洽**，不是真机能力。

## 推荐配置（来自 adapter.ts 一手预算）

| 模型 | 量化 | 显存占用 | 24G 可行性 |
| --- | --- | --- | --- |
| Qwen2.5-14B | Q4_K_M | 10.8G | fits |
| Qwen2.5-7B | Q4_K_M | 5.97G | fits（推荐默认）|
| Qwen2.5-3B | Q4_K_M | 3.47G | fits |

预算公式：权重=params×bits/8，KV=2·layers·ctx·kv_heads·head_dim·2B。
预留 4G 给系统、overhead 1.5G、usable=20G，minCtx=4096。

## 执行步骤

1. **环境自检**：`uname -m` 须为 arm64；`sysctl -n hw.memsize` 记录统一内存。
2. **断网**：物理断网或关 Wi-Fi，人工确认（脚本不擅改网络）。
3. **启动后端**（二选一）：
   - MLX：`python3 -m mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 11434`
   - GGUF：`llama-server -m qwen2.5-7b-Q4_K_M.gguf --port 11434 --ctx-size 4096 --n-gpu-layers -1`
   - **关键**：llama.cpp function-calling 必须 `stream:false`；`n_ctx>=4096`（system+tools≈3700 tokens）。
4. **跑任务集**：`bash examples/mac-local/real-hardware-verify.sh`（脚本含完整命令模板）。
5. **外部测量**：`vm_stat` 采内存、`powermetrics --samplers cpu_power` 采能耗；无 powermetrics 写 `unmeasured`。

## 待回填字段与判据（回填到 `data/evidence/mac-real-result.json`）

| 字段 | 判据 | 测量工具 | 阈值 |
| --- | --- | --- | --- |
| `offline_task_set_pass` | 断网+无 key 跑通完整任务集（至少 SOUND 子集） | `agentos run --offline --no-key` | reward=1 逐条记录 |
| `mlx_tokens_per_sec` | MLX 7B Q4_K_M 生成吞吐 | `mlx_lm 内置计时 / time` | > 0 且记录 p50 |
| `peak_unified_memory_gb` | 峰值统一内存（不 swap） | `vm_stat / powermetrics` | ≤ 20GB usable（预留 4G） |
| `energy_joules_per_task` | 每任务能耗 | `powermetrics --samplers cpu_power` | 记录实测值，无则不编造 |
| `quantization_loss` | Q4 相对 F16 的通过率损失 | `同任务集双精度对照` | 逐任务记录 Δ |
| `tool_calls_native` | 本地模型原生 tool_calls（非文本模拟） | `preflight 2 调用` | finish_reason=tool_calls |

## 回填契约（不可伪造）

- 缺失字段写 `"unmeasured"`，**禁止仿真值**（F3 已证仿真会污染证据）。
- 每条任务逐条落 reward，不写聚合分；`verdict` 在真机全量通过前保持 `not-proven`。
- token 只认端点原始 usage 字段；本地后端若不返回 usage，标 `unmeasured`。
- 回填后运行 `node --experimental-strip-types --no-warnings examples/mac-local/real-hardware-runbook.ts`
  校验流程，再由独立方复核（V6）。

## 诚实边界

本 runbook 与脚本骨架是**流程闭环**，证明"换到真机有可执行路径、判据、回填 schema"，
不证明任何真机能力。真机 tokens/s、峰值内存、量化损失、能耗均属**待人工回填**的一手缺口。
