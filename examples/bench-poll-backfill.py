#!/usr/bin/env python3
"""后台轮询 bench run，完成后自动回填真实进度证据（幂等，可复跑）。

用法：
  python3 examples/bench-poll-backfill.py --run 45585895109
  python3 examples/bench-poll-backfill.py --run 45585895109 --once   # 只查一次，不循环

行为：
  1. 每 90s 查 run 状态（GitHub API 事实源），最多 120 次（约 3h）。
  2. run 终结（success/failure/cancelled）后等 90s 让 workflow 回写 commit 落定。
  3. fetch 远端 → 读 tb21-full-results.jsonl → 按模型分组统计（只数 status=ok）。
  4. 写 data/evidence/bench-run-backfill-<run>.json → rebase → commit → push。
  5. 幂等：证据文件已存在则跳过写入，只打印现状。

诚实：只读事实源；不预判成败；verdict=not-proven 恒定；按 respModel 分组，
kilo/nemotron 自跑数据不与 120b 榜单混算；不改评分器、不伪造 trial。

注意：本进程依赖本地沙箱存活；沙箱休眠会中断。但评测本体在 GitHub Actions
不受影响，结果由 workflow 自动 commit 回 main——即使本进程中断，进度也不丢，
重跑本脚本即可补齐证据。
"""
from __future__ import annotations

import argparse
import base64
import collections
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.request

REPO = "moda1216/bro2"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_FILE = "/root/.codebuddy/credentials/bro2-github-pat"
RESULTS_PATH = "data/bench/external/tb21-full-results.jsonl"
INTERVAL = 90
MAX_CHECKS = 120


def log(msg: str) -> None:
    line = f"[{datetime.datetime.now(datetime.timezone.utc).isoformat()}] {msg}"
    print(line, flush=True)


def token() -> str:
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"].strip()
    if os.path.exists(TOKEN_FILE):
        return open(TOKEN_FILE).read().strip()
    raise RuntimeError("无 GitHub token")


def api(path: str, tok: str):
    req = urllib.request.Request(f"https://api.github.com{path}")
    for k, v in {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bro2-bench-poll",
        "Authorization": f"Bearer {tok}",
    }.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def git(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=check)


def read_remote_results(tok: str):
    c = api(f"/repos/{REPO}/contents/{RESULTS_PATH}?ref=main", tok)
    txt = base64.b64decode(c["content"]).decode()
    rows = [json.loads(l) for l in txt.splitlines() if '"status"' in l]
    ok = [r for r in rows if r.get("status") == "ok"]
    err = [r for r in rows if r.get("status") == "error"]
    rewards = [r["reward"] for r in ok if r.get("reward") is not None]
    by_model: dict[str, list] = {}
    for r in ok:
        key = r.get("respModel") or r.get("provider") or "legacy(ovh/gpt-oss-120b)"
        by_model.setdefault(key, []).append(r.get("reward"))
    return {
        "total": len(rows), "ok": len(ok), "error": len(err),
        "reward_sum": sum(rewards), "reward_n": len(rewards),
        "by_model": {
            k: {"trials": len(v), "reward_sum": sum(x for x in v if x is not None),
                "reward_n": sum(1 for x in v if x is not None)}
            for k, v in by_model.items()
        },
        "provider_tagged_rows": sum(1 for r in rows if r.get("provider")),
        "file_sha": c["sha"],
    }


def backfill(run_id: str, conclusion: str, tok: str) -> int:
    # 等 workflow 回写 commit 落定
    log(f"run 终结({conclusion})，等 {INTERVAL}s 让回写 commit 落定...")
    time.sleep(INTERVAL)

    ev_path = os.path.join(ROOT, "data", "evidence", f"bench-run-backfill-{run_id}.json")
    if os.path.exists(ev_path):
        log(f"证据已存在，跳过写入：{ev_path}")
        return 0

    git(["fetch", "origin", "main"])
    stats = read_remote_results(tok)
    run = api(f"/repos/{REPO}/actions/runs/{run_id}", tok)
    log(f"远端结果：总 {stats['total']} | ok {stats['ok']} | error {stats['error']} | "
        f"reward {stats['reward_sum']}/{stats['reward_n']} | provider标注行 {stats['provider_tagged_rows']}")
    for k, v in stats["by_model"].items():
        log(f"  模型组 [{k}]: {v['trials']} trial | reward {v['reward_sum']}/{v['reward_n']}")

    evidence = {
        "id": f"bench-run-backfill-{run_id}",
        "run_id": run_id,
        "backfilled_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "run": {
            "status": run["status"], "conclusion": run["conclusion"],
            "event": run["event"], "head_sha": run["head_sha"],
            "created_at": run["created_at"], "updated_at": run["updated_at"],
        },
        "results": stats,
        "honesty": {
            "verdict": "not-proven", "l4": "not-achieved",
            "model_grouping": "按 respModel/provider 分组；kilo/nemotron 自跑数据不对标 120b 榜单 26.217",
            "note": "只读事实源回填；不预判成败；未改评分器/未放宽判分/未伪造 trial",
        },
        "progress_delta": {
            "before": 9, "after_ok": stats["ok"],
            "new_trials": stats["ok"] - 9,
        },
    }
    with open(ev_path, "w") as f:
        json.dump(evidence, f, ensure_ascii=False, indent=2)
    log(f"已写证据：{ev_path}")

    # rebase 到远端（workflow 可能同时回写），再提交推送
    git(["add", os.path.relpath(ev_path, ROOT)])
    cp = subprocess.run(["git", "commit", "-m",
                         f"docs(bench): 回填 run {run_id} 真实进度证据({conclusion});"
                         f"ok={stats['ok']} reward={stats['reward_sum']}/{stats['reward_n']} 按模型分组[skip ci]"],
                        cwd=ROOT, capture_output=True, text=True)
    log(f"commit: {cp.stdout.strip().splitlines()[-1] if cp.stdout.strip() else cp.stderr.strip()[:120]}")

    auth = f"https://x-access-token:{tok}@github.com/{REPO}.git"
    pull = subprocess.run(["git", "pull", "--rebase", auth, "main"], cwd=ROOT, capture_output=True, text=True)
    log(f"pull --rebase rc={pull.returncode}")
    if pull.returncode != 0:
        log(f"pull 失败：{pull.stderr.strip()[:200]}")
        return 1
    push = subprocess.run(["git", "push", auth, "HEAD:refs/heads/main"], cwd=ROOT, capture_output=True, text=True)
    log(f"push rc={push.returncode}: {push.stdout.strip().splitlines()[-1] if push.stdout.strip() else push.stderr.strip()[:120]}")
    return 0 if push.returncode == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="bench workflow run id")
    ap.add_argument("--once", action="store_true", help="只查一次")
    a = ap.parse_args()
    tok = token()

    if a.once:
        run = api(f"/repos/{REPO}/actions/runs/{a.run}", tok)
        log(f"once: {a.run} status={run['status']} conclusion={run['conclusion']} sha={run['head_sha'][:8]}")
        if run["conclusion"] in ("success", "failure", "cancelled"):
            return backfill(a.run, run["conclusion"], tok)
        return 0

    log(f"开始轮询 run {a.run}，间隔 {INTERVAL}s，最多 {MAX_CHECKS} 次")
    for i in range(MAX_CHECKS):
        try:
            run = api(f"/repos/{REPO}/actions/runs/{a.run}", tok)
            concl = run["conclusion"]
            log(f"check {i+1}/{MAX_CHECKS}: status={run['status']} conclusion={concl}")
            if concl in ("success", "failure", "cancelled"):
                return backfill(a.run, concl, tok)
        except Exception as e:
            log(f"check {i+1}: API 异常 {type(e).__name__}: {e}")
        time.sleep(INTERVAL)
    log(f"达到 {MAX_CHECKS} 次上限，run 仍未终结；结果由 workflow 自动回写 main，重跑本脚本可补齐证据")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
