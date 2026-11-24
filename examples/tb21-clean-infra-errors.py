#!/usr/bin/env python3
"""清理 tb21-full-results.jsonl 中的基础设施失败行（err=no-image 等）。

背景：GitHub Actions runner 早期因缺 /tmp/tb21-recon-rows.json 镜像映射，
把 89 个 task 全写成 status=error/err=no-image。这类行不是有效评测 trial，
会虚增「进度」并污染可复算证据，必须剔除。

红线：
  - 只删 status=error 且 err 属于基础设施类（no-image/pull-failed/build-failed）的行；
  - 绝不删 status=ok 的真实 trial（含 reward=0 的失败题，它们是有效证据）；
  - 幂等：重复运行不再改动文件；原地原子替换。

用法：python3 examples/tb21-clean-infra-errors.py [--dry-run]
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "data", "bench", "external", "tb21-full-results.jsonl")
INFRA_ERRS = {"no-image", "pull-failed", "build-failed"}


def main() -> int:
    dry = "--dry-run" in sys.argv
    if not os.path.exists(RESULTS):
        print("无结果文件，无需清理")
        return 0
    kept, removed = [], 0
    for line in open(RESULTS, encoding="utf-8"):
        if not line.strip():
            continue
        import json
        row = json.loads(line)
        if row.get("status") == "error" and row.get("err") in INFRA_ERRS:
            removed += 1
            continue
        kept.append(line if line.endswith("\n") else line + "\n")
    print(f"基础设施失败行: {removed} | 保留有效行: {len(kept)}")
    if removed == 0:
        print("幂等：无需改动")
        return 0
    if dry:
        print("dry-run：未写文件")
        return 0
    tmp = RESULTS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.writelines(kept)
    os.replace(tmp, RESULTS)
    print(f"已原地清理 {removed} 行基础设施失败记录")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
