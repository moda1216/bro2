#!/usr/bin/env python3
"""外部评测心跳落盘（供 GitHub Actions workflow 调用）。

用法：python3 examples/bench-heartbeat.py <done_count>
输出：data/bench/external/tb21-supervisor-heartbeat.json

诚实：verdict 恒为 not-proven；partial≠榜单分数；只记录进度，不产出能力结论。
"""
import datetime as dt
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "bench", "external", "tb21-supervisor-heartbeat.json")

done = int(sys.argv[1]) if len(sys.argv) > 1 else 0
total = 267
obj = {
    "ts": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    "done": done,
    "total": total,
    "pct": round(done / total * 100, 2),
    "state": "complete" if done >= total else "running",
    "source": "github-actions/cron",
    "verdict": "not-proven",
    "note": "partial≠榜单分数；GitHub Actions 跨会话持久累积",
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(obj, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"心跳: {done}/{total} ({obj['pct']}%) verdict=not-proven")
