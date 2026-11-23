#!/usr/bin/env bash
# bro2 · Terminal-Bench 2.1 全量 89×3 常驻评测 supervisor
# ----------------------------------------------------------------
# 目标：抗会话重置 / 抗端点抖动 / 抗进程崩溃的「持续推进」。
# 机制：
#   1) 无限循环调用 tb21-batch.py —— 它天然断点续跑（已完成 (task,repeat) 跳过），
#      所以每次重启都从断点继续，绝不重复计分、绝不丢已落盘 trial。
#   2) 每轮结束检查进度；达到 267/267 才退出（真完成）。
#   3) batch.py 崩溃/异常退出 → 记录心跳 + 指数退避后重启（上限 60s）。
#   4) 心跳与进度持续追加到 /tmp/tb21-supervisor.log 与
#      data/bench/external/tb21-supervisor-heartbeat.json（供外部只读查看）。
#   5) 端点偶发 429/NET fail 由 ovh-throttle.mjs 内部重试；整批失败由本循环兜底。
#
# 关键诚实：本脚本不写 external-results.json、不改评分器、不改 src；只驱动测量。
# 所有 trial 结果仍由 tb21-batch.py 原子落盘到 tb21-full-results.jsonl。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULT="$ROOT/data/bench/external/tb21-full-results.jsonl"
HEART="$ROOT/data/bench/external/tb21-supervisor-heartbeat.json"
HLOG="/tmp/tb21-supervisor.log"
TOTAL=267
BACKOFF=5

heartbeat() {
  local n="$1" state="$2"
  local done="$TOTAL"
  if [ -f "$RESULT" ]; then done=$(grep -c '"status"' "$RESULT" 2>/dev/null || echo 0); fi
  python3.11 - "$HEART" "$done" "$TOTAL" "$state" "$n" <<'PY'
import json,sys,datetime
path,done,total,state,n=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),sys.argv[4],int(sys.argv[5])
obj={"ts":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"),
     "done":done,"total":total,"pct":round(done/total*100,2),"state":state,"round":n,
     "verdict":"not-proven","note":"supervisor heartbeat; partial≠榜单分数"}
open(path,"w").write(json.dumps(obj,ensure_ascii=False))
PY
  echo "[$(date -u +%H:%M:%S)] round=$n state=$state progress=$done/$TOTAL" >> "$HLOG"
}

log() { echo "[$(date -u +%H:%M:%S)] $*" >> "$HLOG"; }

log "=== supervisor 启动 ==="
round=0
while true; do
  round=$((round+1))
  heartbeat "$round" "running"
  log "round $round: 调用 tb21-batch.py（断点续跑）..."
  # batch.py 自身会跑完所有 pending trial；用 tee 把本轮 stdout 追加到日志便于追溯
  (cd "$ROOT" && python3 examples/tb21-batch.py >> "$HLOG" 2>&1)
  rc=$?
  # 统计当前完成数（含 status 字段的行 = 已落盘 trial）
  done=$(grep -c '"status"' "$RESULT" 2>/dev/null || echo 0)
  log "round $round: batch.py 退出 rc=$rc，进度 $done/$TOTAL"
  if [ "$done" -ge "$TOTAL" ]; then
    heartbeat "$round" "complete"
    log "=== 全量完成 $done/$TOTAL，supervisor 退出 ==="
    break
  fi
  # 未完成：退避后重启（batch.py 崩溃或整批跳过都由此兜底）
  log "round $round: 退避 ${BACKOFF}s 后续跑..."
  sleep "$BACKOFF"
  if [ "$BACKOFF" -lt 60 ]; then BACKOFF=$((BACKOFF*2)); fi
done
