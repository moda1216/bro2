#!/usr/bin/env bash
# bro2 · 真机验证（在 Apple Silicon Mac 上运行；本沙箱未执行）
# 前置：brew install mlx / llama.cpp；模型 Qwen2.5-7B Q4_K_M (~5.97G)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/data/evidence/mac-real-result.json"
RESULT="$ROOT/data/bench/external/mac-real-tasks.jsonl"

echo "== 0) 环境自检 =="
uname -m | grep -q arm64 || { echo "需要 Apple Silicon (arm64)"; exit 1; }
sysctl -n hw.memsize | awk '{print "统一内存 GB:", $1/1024/1024/1024}'
command -v powermetrics >/dev/null || echo "WARN: powermetrics 不可用，能耗记 unmeasured"

echo "== 1) 断网确认（拔网线 / 关 Wi-Fi 后运行）=="
echo "请人工确认已断网；本脚本不擅自改网络设置"

echo "== 2) 启动本地后端（MLX 或 llama.cpp-gguf，二选一）=="
# MLX:   python3 -m mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 11434
# GGUF:  llama-server -m qwen2.5-7b-Q4_K_M.gguf --port 11434 --ctx-size 4096
# 注意 llama.cpp function-calling 需 stream:false（adapter 已固化该约束）

echo "== 3) 断网+无 key 跑任务集 =="
# agentos run --base-url http://127.0.0.1:11434/v1 --no-key --offline \
#   --tasks "$RESULT" --out "$ROOT/data/bench/external/mac-real-results.jsonl"

echo "== 4) 系统工具外部测量 =="
# vm_stat 5 > $ROOT/data/evidence/mac-vmstat.txt
# powermetrics --samplers cpu_power -i 1000 -n 10 > $ROOT/data/evidence/mac-power.txt

echo "== 5) 回填结果 schema =="
echo "把实测字段填入 $OUT；缺失字段写 unmeasured，禁止仿真填充。"
echo "判据与阈值见 docs/MAC-REAL-HARDWARE-RUNBOOK.md"
