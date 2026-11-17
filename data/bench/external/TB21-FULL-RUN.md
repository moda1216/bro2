# Terminal-Bench 2.1 全量 89×3 评测 · 运行手册（v2.35.0）

用户指令「直接铺全量 89×3（多会话）」。这是路径①（真榜面对齐）的全量执行：用 2.1 公开 89 题 + 官方 per-task 镜像 + 官方 `test_outputs.py` 判分器，模型钉死 `gpt-oss-120b`（ovhcloud，与公开榜 26.217% 同模型），产出可对齐的分。

## 红线（全程未破）

- 自跑、**非第三方复核**；模型与公开榜同（gpt-oss-120b），任务集同（2.1/89），判分器同（官方 pytest）——三轴对齐，Δ 可归因到 harness。
- 每题先过**判别力 gate**：初始镜像（无解）上 verifier 必须 fail，否则标记无判别力并跳过，绝不把恒 pass 计入分数。
- 逐 trial 原子落盘、断点续跑；严格串行（ovhcloud 2 req/min 全局限速）。
- 不写 `external-results.json`、不改 `src/`、不改 L4/`verdict`。

## 关键工程修复（相对初版 PoC）

| 问题 | 修复 |
|---|---|
| 初版 runner verifier 在独立容器跑，拿不到 bro2 产出，reward 恒 0 | 改同容器跑 verifier |
| `permission.allowedPaths` 默认不含 `/app`，bro2 写不进产出目录 | 注入 `allowedPaths` 含 `/app` |
| 部分题 `instruction.md` 为空（如 constraints-scheduling） | 从 `task.toml` 的 `instruction` 字段回退 |
| bro2 启动的解法子进程（如死循环 Rscript）拖垮 verifier | verifier 前清理孤儿进程 + verifier 带超时 |
| 240k tokens 不够 gpt-oss-120b 跑复杂题 | 抬到 400k / 90min（公平性配置，不改判分） |

> 注：初版 PoC 报告里 `constraints-scheduling reward=0` 的结论已被 `supersededBy` 标注作废——那是权限脚手架 bug 的伪影。修复后该题 reward=1。

## 当前运行状态（2026-11-17）

- 首次全量后台进程：`nohup python3 examples/tb21-batch.py > /tmp/tb21-full-run.log 2>&1 &`，PID 30890（PPID=1，独立会话 SID 30889，会话结束后仍存活）。
- 已提交：`b0aa95a` / tag `v2.35.0`（已推远程）。
- 断点：见 `tb21-full-results.jsonl`，每完成一个 trial 追加一行。冒烟 `constraints-scheduling r1 reward=1` 已入库。
- **新会话接续第一步**：`ps aux | grep tb21-batch.py` 看进程是否还在；若在，只 `python3 examples/tb21-batch.py --status` 观察；若不在，用下方命令续跑（自动跳过已完成 trial）。

## 断点续跑命令

```bash
# 查看进度（已完成 trial 数、当前 reward）
python3 examples/tb21-batch.py --status

# 续跑全量（自动跳过已完成 (task,repeat)）
cd /workspace/agent-os && nohup python3 examples/tb21-batch.py > /tmp/tb21-full-run.log 2>&1 &

# 单题调试
python3 examples/tb21-batch.py --task <taskName> --repeat 1

# 本会话只推进 N 个 trial
python3 examples/tb21-batch.py --limit 10
```

## 产物

- `data/bench/external/tb21-full-results.jsonl`：逐 trial 结果（每行含 task/repeat/reward/steps/tokens/wallSeconds/verifyNote/image）。
- `/tmp/tb21-logs/<task>-r<repeat>.log`：逐 trial bro2 运行日志（临时，会话内可查）。
- `/tmp/tb21-full-run.log`：批量进程日志。
- `/tmp/tb21-batch-cache/<task>/`：任务文件缓存与 wrapper 镜像构建目录（含 `.sound` 判别力 gate 缓存）。

## 耗时与跨会话

ovhcloud 匿名层 2 req/min 是硬约束。单题 3 分钟（简单）到 40 分钟（复杂）不等，89×3≈267 trials 预计 **100+ 小时连续运行**。单会话跑不完，须跨会话累积：每次会话启动/续跑上面的命令，脚本自动从断点继续。结果以 `tb21-full-results.jsonl` 为准，中途可随时 `--status` 查看。

若换不限流的 gpt-oss-120b 端点，可大幅压缩耗时（测量侧 `ovh-throttle.mjs` 只需改 host/间隔）。
