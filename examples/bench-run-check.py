#!/usr/bin/env python3
"""检查外部评测 GitHub Actions run 状态 + cron 是否激活（只读，可复跑）。

用法：
  python3 examples/bench-run-check.py                    # 概览：所有 bench run + 结果进度
  python3 examples/bench-run-check.py --run <run_id>     # 单个 run 状态
  python3 examples/bench-run-check.py --verbose          # 含每个 job/step

诚实：只读，不改任何证据；verdict=not-proven 恒定。状态来自 GitHub API 事实源。
需要 token：优先读 /root/.codebuddy/credentials/bro2-github-pat，或环境变量 GITHUB_TOKEN。
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.request

REPO = "moda1216/bro2"
BENCH_WF = "428158730"
RESULTS_PATH = "data/bench/external/tb21-full-results.jsonl"


def token() -> str | None:
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"].strip()
    for p in ("/root/.codebuddy/credentials/bro2-github-pat", os.path.expanduser("~/.github_pat")):
        if os.path.exists(p):
            return open(p).read().strip()
    return None


def api(path: str, tok: str | None):
    req = urllib.request.Request(f"https://api.github.com{path}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "bro2-bench-check")
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", help="单个 run id")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    tok = token()

    if a.run:
        d = api(f"/repos/{REPO}/actions/runs/{a.run}", tok)
        print(f"run {a.run}: status={d['status']} conclusion={d['conclusion']} event={d['event']} sha={d['head_sha'][:8]}")
        if a.verbose:
            jobs = api(f"/repos/{REPO}/actions/runs/{a.run}/jobs", tok)
            for j in jobs.get("jobs", []):
                print(f"  job {j['id']}: {j['status']}/{j['conclusion']}")
                for s in j.get("steps", []):
                    print(f"    {s['number']:>2} {s['name']}: {s['status']}/{s['conclusion']}")
        return 0

    runs = api(f"/repos/{REPO}/actions/workflows/{BENCH_WF}/runs?per_page=10", tok)
    print(f"bench workflow run 总数: {runs.get('total_count')}")
    sched = 0
    for r in runs.get("workflow_runs", []):
        mark = " <== cron" if r["event"] == "schedule" else ""
        if r["event"] == "schedule":
            sched += 1
        print(f"  {r['id']} {r['status']}/{r['conclusion']} event={r['event']} sha={r['head_sha'][:8]} created={r['created_at']}{mark}")
    print(f"cron 触发次数（最近10）: {sched}")

    # 结果进度：从 API 读文件，只数 status=ok
    try:
        c = api(f"/repos/{REPO}/contents/{RESULTS_PATH}?ref=main", tok)
        import base64
        txt = base64.b64decode(c["content"]).decode()
        rows = [json.loads(l) for l in txt.splitlines() if '"status"' in l]
        ok = [r for r in rows if r.get("status") == "ok"]
        err = [r for r in rows if r.get("status") == "error"]
        rewards = [r["reward"] for r in ok if r.get("reward") is not None]
        print(f"结果文件: 总 {len(rows)} 行 | 有效 ok {len(ok)} | error {len(err)} | reward {sum(rewards)}/{len(rewards)}")
        # 诚实标注：kilo 接入后逐行带 provider/respModel，必须按模型分组，不得与 120b 榜单混为一谈。
        by_model: dict[str, list] = {}
        for r in ok:
            key = r.get("respModel") or r.get("provider") or "legacy(ovh/gpt-oss-120b, 无身份字段)"
            by_model.setdefault(key, []).append(r.get("reward"))
        for key, rs in by_model.items():
            scored = [x for x in rs if x is not None]
            print(f"  模型组 [{key}]: {len(rs)} trial | reward {sum(scored)}/{len(scored)}"
                  f"{'  <== 不对标120b榜单' if 'legacy' not in key else '  <== 120b榜单锚点(历史9条)'}")
    except Exception as e:
        print(f"结果文件读取失败: {type(e).__name__}: {e}")
    print("verdict=not-proven（本工具只读，不产出能力结论）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
