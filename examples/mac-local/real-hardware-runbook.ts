/**
 * bro2 · 真机验证流程闭环（Apple Silicon / MLX / GGUF）
 * ----------------------------------------------------------------
 * 审计硬约束 H1 / 需求6：24G Mac 自主运行 + 系统工具外部测量能耗。
 * 本沙箱无 Apple Silicon / MLX / powermetrics，无法真机验证——这是环境限制，诚实标注。
 * 但「流程闭环」可以做：把真机验证的契约、判据、产物落点、待回填字段全部固化，
 * 使换到真机环境后能一条命令跑完、结果自动回填到同一 schema。
 *
 * 本工具做两件事：
 *   1) 在本沙箱做「流程自检」：检查 runbook/脚本骨架/回填契约三者齐全且自洽
 *      （这是本环境能证的：流程完整，不是真机能力）。
 *   2) 写出 docs/MAC-REAL-HARDWARE-RUNBOOK.md + examples/mac-local/real-hardware-verify.sh
 *      + data/evidence/mac-real-readiness.json（待回填字段清单）。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/mac-local/real-hardware-runbook.ts
 * 输出见上。verdict 恒为 not-proven（真机未测），流程自检可为 green。
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNBOOK = resolve(ROOT, "docs/MAC-REAL-HARDWARE-RUNBOOK.md");
const SCRIPT = resolve(ROOT, "examples/mac-local/real-hardware-verify.sh");
const OUT = resolve(ROOT, "data/evidence/mac-real-readiness.json");

interface Check { name: string; pass: boolean; evidence: Record<string, unknown> }
const checks: Check[] = [];
const check = (name: string, pass: boolean, evidence: Record<string, unknown>): void => {
  checks.push({ name, pass, evidence });
};

// ---- 真机验证契约：每个待回填字段 = 判据 + 测量工具 + 阈值 ----
const CONTRACT = [
  { field: "offline_task_set_pass", criterion: "断网+无 key 跑通完整任务集（至少 SOUND 子集）", tool: "agentos run --offline --no-key", threshold: "reward=1 逐条记录", source: "真机执行" },
  { field: "mlx_tokens_per_sec", criterion: "MLX 7B Q4_K_M 生成吞吐", tool: "mlx_lm 内置计时 / time", threshold: "> 0 且记录 p50", source: "真机执行" },
  { field: "peak_unified_memory_gb", criterion: "峰值统一内存（不 swap）", tool: "vm_stat / powermetrics", threshold: "≤ 20GB usable（预留 4G）", source: "真机执行" },
  { field: "energy_joules_per_task", criterion: "每任务能耗", tool: "powermetrics --samplers cpu_power", threshold: "记录实测值，无则不编造", source: "真机执行" },
  { field: "quantization_loss", criterion: "Q4 相对 F16 的通过率损失", tool: "同任务集双精度对照", threshold: "逐任务记录 Δ", source: "真机执行" },
  { field: "tool_calls_native", criterion: "本地模型原生 tool_calls（非文本模拟）", tool: "preflight 2 调用", threshold: "finish_reason=tool_calls", source: "真机执行" },
];

// ---- 生成真机验证脚本骨架（真实可执行，但需真机环境）----
const script = `#!/usr/bin/env bash
# bro2 · 真机验证（在 Apple Silicon Mac 上运行；本沙箱未执行）
# 前置：brew install mlx / llama.cpp；模型 Qwen2.5-7B Q4_K_M (~5.97G)
set -euo pipefail
ROOT="\$(cd "\$(dirname "\$0")/../.." && pwd)"
OUT="\$ROOT/data/evidence/mac-real-result.json"
RESULT="\$ROOT/data/bench/external/mac-real-tasks.jsonl"

echo "== 0) 环境自检 =="
uname -m | grep -q arm64 || { echo "需要 Apple Silicon (arm64)"; exit 1; }
sysctl -n hw.memsize | awk '{print "统一内存 GB:", \$1/1024/1024/1024}'
command -v powermetrics >/dev/null || echo "WARN: powermetrics 不可用，能耗记 unmeasured"

echo "== 1) 断网确认（拔网线 / 关 Wi-Fi 后运行）=="
echo "请人工确认已断网；本脚本不擅自改网络设置"

echo "== 2) 启动本地后端（MLX 或 llama.cpp-gguf，二选一）=="
# MLX:   python3 -m mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 11434
# GGUF:  llama-server -m qwen2.5-7b-Q4_K_M.gguf --port 11434 --ctx-size 4096
# 注意 llama.cpp function-calling 需 stream:false（adapter 已固化该约束）

echo "== 3) 断网+无 key 跑任务集 =="
# agentos run --base-url http://127.0.0.1:11434/v1 --no-key --offline \\
#   --tasks "\$RESULT" --out "\$ROOT/data/bench/external/mac-real-results.jsonl"

echo "== 4) 系统工具外部测量 =="
# vm_stat 5 > \$ROOT/data/evidence/mac-vmstat.txt
# powermetrics --samplers cpu_power -i 1000 -n 10 > \$ROOT/data/evidence/mac-power.txt

echo "== 5) 回填结果 schema =="
echo "把实测字段填入 \$OUT；缺失字段写 unmeasured，禁止仿真填充。"
echo "判据与阈值见 docs/MAC-REAL-HARDWARE-RUNBOOK.md"
`;

// ---- 生成 runbook 文档 ----
const runbook = `# 真机验证 Runbook（Apple Silicon / MLX / GGUF）

> 状态：**流程闭环已建，真机未执行**。本沙箱无 Apple Silicon / MLX / powermetrics，
> 下列步骤需在 24G 统一内存的 Mac 上人工执行。\`verdict=not-proven\`、\`L4=not-achieved\` 不变。

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

1. **环境自检**：\`uname -m\` 须为 arm64；\`sysctl -n hw.memsize\` 记录统一内存。
2. **断网**：物理断网或关 Wi-Fi，人工确认（脚本不擅改网络）。
3. **启动后端**（二选一）：
   - MLX：\`python3 -m mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 11434\`
   - GGUF：\`llama-server -m qwen2.5-7b-Q4_K_M.gguf --port 11434 --ctx-size 4096 --n-gpu-layers -1\`
   - **关键**：llama.cpp function-calling 必须 \`stream:false\`；\`n_ctx>=4096\`（system+tools≈3700 tokens）。
4. **跑任务集**：\`bash examples/mac-local/real-hardware-verify.sh\`（脚本含完整命令模板）。
5. **外部测量**：\`vm_stat\` 采内存、\`powermetrics --samplers cpu_power\` 采能耗；无 powermetrics 写 \`unmeasured\`。

## 待回填字段与判据（回填到 \`data/evidence/mac-real-result.json\`）

| 字段 | 判据 | 测量工具 | 阈值 |
| --- | --- | --- | --- |
${CONTRACT.map((c) => `| \`${c.field}\` | ${c.criterion} | \`${c.tool}\` | ${c.threshold} |`).join("\n")}

## 回填契约（不可伪造）

- 缺失字段写 \`"unmeasured"\`，**禁止仿真值**（F3 已证仿真会污染证据）。
- 每条任务逐条落 reward，不写聚合分；\`verdict\` 在真机全量通过前保持 \`not-proven\`。
- token 只认端点原始 usage 字段；本地后端若不返回 usage，标 \`unmeasured\`。
- 回填后运行 \`node --experimental-strip-types --no-warnings examples/mac-local/real-hardware-runbook.ts\`
  校验流程，再由独立方复核（V6）。

## 诚实边界

本 runbook 与脚本骨架是**流程闭环**，证明"换到真机有可执行路径、判据、回填 schema"，
不证明任何真机能力。真机 tokens/s、峰值内存、量化损失、能耗均属**待人工回填**的一手缺口。
`;

// ---- 本沙箱流程自检（只证流程完整，不证真机）----
writeFileSync(RUNBOOK, runbook);
mkdirSync(dirname(SCRIPT), { recursive: true });
writeFileSync(SCRIPT, script);

check("流程闭环三件套齐全", [RUNBOOK, SCRIPT].every((p) => existsSync(p)), {
  runbook: "docs/MAC-REAL-HARDWARE-RUNBOOK.md", script: "examples/mac-local/real-hardware-verify.sh",
});
check("回填契约覆盖 6 个真机缺口字段", CONTRACT.length === 6 && CONTRACT.every((c) => c.field && c.criterion && c.tool && c.threshold), {
  fields: CONTRACT.map((c) => c.field),
});
check("脚本含断网+无 key+系统测量+unmeasured 四要素",
  /断网/.test(script) && /--no-key/.test(script) && /powermetrics/.test(script) && /unmeasured/.test(script),
  { offline: /断网/.test(script), nokey: /--no-key/.test(script), measurement: /powermetrics/.test(script) });
check("adapter 推荐配置已被 runbook 引用（流程对齐）",
  runbook.includes("5.97G") && runbook.includes("stream:false") && runbook.includes("4096"),
  { alignedWithAdapter: true });

const passed = checks.filter((c) => c.pass).length;
const report = {
  generatedAt: new Date().toISOString(),
  purpose: "真机项流程闭环：固化契约/判据/回填 schema，本沙箱只证流程完整",
  environment: "本沙箱无 Apple Silicon/MLX/powermetrics（uname 为 x86_64 Linux）",
  artifacts: {
    runbook: "docs/MAC-REAL-HARDWARE-RUNBOOK.md",
    script: "examples/mac-local/real-hardware-verify.sh",
    readyEvidence: "data/evidence/mac-real-readiness.json",
  },
  pendingFields: CONTRACT,
  checks,
  summary: { total: checks.length, passed, failed: checks.length - passed, verdict: passed === checks.length ? "process-closed-not-executed" : "process-red" },
  honest: {
    scope: "流程闭环（契约+脚本+回填 schema+自检），不执行真机",
    notProven: CONTRACT.map((c) => c.field),
    note: "真机能力须在 Apple Silicon Mac 上按 runbook 执行并回填，经独立方复核后方可更新 verdict。本沙箱不伪造真机数据。",
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(`真机流程闭环：${passed}/${checks.length} ${report.summary.verdict}`);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
console.log("  真机能力 verdict=not-proven（待回填 " + CONTRACT.length + " 字段）");
if (passed !== checks.length) process.exitCode = 1;
