#!/usr/bin/env python3
"""
bro2 · Terminal-Bench 2.1 全量 89×3 批量评测（路径① 榜面对齐）

设计红线：
  - 自跑、非第三方复核；模型钉死 gpt-oss-120b（与公开榜同模型）；
    官方 per-task 镜像 + 官方 test_outputs.py 判分器原样使用。
  - 判别力 sanity gate：每题在「初始镜像（无解）」上跑 verifier 必须 fail；
    否则该题 verifier 无判别力，标记 SOUND=false 并跳过，绝不把恒 pass 计入分数。
  - 逐 trial 原子落盘 JSONL；断点续跑（已完成 (task,repeat) 跳过）；
    严格串行（ovhcloud 2 req/min 是全局限速，并行容器会叠加触发 429）。
  - 不写 external-results.json、不改 src、不改 L4/verdict。

用法：
  python3 examples/tb21-batch.py --limit 1                 # 先跑 1 个 trial 验证流水线
  python3 examples/tb21-batch.py --task constraints-scheduling --repeat 1
  python3 examples/tb21-batch.py                           # 全量 89×3（断点续跑）
  python3 examples/tb21-batch.py --status                  # 只看进度

结果：data/bench/external/tb21-full-results.jsonl（每行一个 trial）
日志：/tmp/tb21-logs/<task>-r<repeat>.log（bro2 逐 trial 运行日志）
"""
from __future__ import annotations

import argparse, datetime as dt, hashlib, json, os, re, shutil, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "data", "bench", "external")
RESULTS = os.path.join(EXT, "tb21-full-results.jsonl")
LOGDIR = "/tmp/tb21-logs"
CACHE = "/tmp/tb21-batch-cache"
COMMIT = "7131e4375048a0e408a8fb404b5f499d726b695b"
REPO = "harbor-framework/terminal-bench-2-1"
BASE = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/tasks"
THROTTLE = os.path.join(ROOT, "examples", "ovh-throttle.mjs")
TASKS_FILE = "/tmp/tb21-tasks.json"
RECON_FILE = "/tmp/tb21-recon-rows.json"

# 每题预算：受 ovhcloud 2 req/min 限制，放宽墙钟（同 v2.33）。
# 冒烟实测：gpt-oss-120b 在 2.1 复杂题（ars）上 32 步耗尽 247k tokens，240k 不够；
# 抬高到 400k（约 55 步）+ 90 分钟墙钟，让复杂题有完成机会。这是 adapter 公平性配置，
# 不改评分器、不放宽判分，仅避免因脚手架预算不足产生假阴性。
BUDGET = {"maxSeconds": 5400, "maxSteps": 60, "maxTokens": 400000}


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def run(cmd: list[str], *, timeout: int | None = None, check: bool = False) -> subprocess.CompletedProcess:
    try:
        cp = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        # text=True 下超时异常里 stdout/stderr 可能是 bytes，统一解码再拼接。
        def dec(x):
            if x is None:
                return ""
            return x.decode("utf-8", "replace") if isinstance(x, bytes) else x
        return subprocess.CompletedProcess(cmd, 124, dec(e.stdout), dec(e.stderr) + "\n[timeout]")
    if check and cp.returncode != 0:
        raise RuntimeError(f"cmd failed ({cp.returncode}): {' '.join(cmd)}\n{cp.stdout[-800:]}\n{cp.stderr[-800:]}")
    return cp


def load_tasks() -> list[str]:
    if os.path.exists(TASKS_FILE):
        return json.load(open(TASKS_FILE))
    # 回退：从固化的 git tree 快照提取
    snap = json.load(open(os.path.join(EXT, "tb-tree-snapshot.json")))
    files: dict[str, set] = {}
    for p in snap["pinned21Paths"]:
        parts = p.split("/")
        if len(parts) >= 3 and parts[0] == "tasks":
            files.setdefault(parts[1], set()).add("/".join(parts[2:]))
    return sorted(files)


def load_images() -> dict[str, str]:
    if os.path.exists(RECON_FILE):
        return {r["task"]: r.get("docker_image") for r in json.load(open(RECON_FILE)) if r.get("docker_image")}
    return {}


def load_done() -> set[tuple[str, int]]:
    if not os.path.exists(RESULTS):
        return set()
    done = set()
    for line in open(RESULTS):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            if r.get("status") == "ok":
                done.add((r["task"], int(r["repeat"])))
        except Exception:
            continue
    return done


def append_result(row: dict) -> None:
    with open(RESULTS, "a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
        f.flush()


def image_exists(img: str) -> bool:
    return run(["docker", "image", "inspect", img]).returncode == 0


def prepare(task: str, img: str) -> str | None:
    """准备阶段：拉文件 + pull 镜像 + build wrapper。返回 wrapper tag 或 None。"""
    w = os.path.join(CACHE, task)
    os.makedirs(os.path.join(w, "tests"), exist_ok=True)
    os.makedirs(os.path.join(w, "bro2"), exist_ok=True)

    # 1) 拉关键文件（带缓存）
    files = {
        "task.toml": "task.toml",
        "instruction.md": "instruction.md",
        "solution/solve.sh": "solve.sh",
        "tests/test.sh": "tests/test.sh",
        "tests/test_outputs.py": "tests/test_outputs.py",
    }
    for src, dst in files.items():
        out = os.path.join(w, dst)
        if os.path.exists(out) and os.path.getsize(out) > 0:
            continue
        # 重试 3 次，避免网络抖动误跳过整题
        fetched = False
        for attempt in range(3):
            cp = run(["curl", "-sL", "--max-time", "60", "--retry", "2", "--retry-all-errors",
                      "-o", out, "-w", "%{http_code}", f"{BASE}/{task}/{src}"])
            if cp.stdout.strip() == "200" and os.path.exists(out) and os.path.getsize(out) > 0:
                fetched = True
                break
            time.sleep(2 * (attempt + 1))
        if not fetched:
            return None

    # instruction.md 为空时回退到 task.toml 的 instruction 字段（部分题题面内嵌在 toml）
    instr = os.path.join(w, "instruction.md")
    if os.path.getsize(instr) == 0:
        toml = open(os.path.join(w, "task.toml")).read()
        m = re.search(r'instruction\s*=\s*["\']{3}(.*?)["\']{3}', toml, re.S)
        if m and m.group(1).strip():
            open(instr, "w").write(m.group(1).strip())
    if os.path.getsize(instr) == 0:
        return None  # 无题面 → 无法让 bro2 解题，跳过

    # 2) pull 镜像（若本地没有）
    img = re.search(r'docker_image\s*=\s*["\']([^"\']+)["\']', open(os.path.join(w, "task.toml")).read()).group(1)
    if not image_exists(img):
        cp = run(["docker", "pull", img], timeout=600)
        if cp.returncode != 0:
            return None

    # 3) build wrapper（装 Node22 + pytest；注入 bro2 源码 / tests；对齐 workspace / 放宽预算）
    tag = f"bro2-tb21:{task}"
    # 版本指纹：BUDGET + throttle 脚本 hash + 本构建脚本 hash。任一变更（含构建逻辑如
    # pip/wget 装 node 替代 apt）都让旧镜像作废重建，避免跑着旧 Dockerfile 的镜像。
    throttle_sha = hashlib.sha256(open(THROTTLE, "rb").read()).hexdigest()[:16]
    batch_sha = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()[:16]
    fp = f"{throttle_sha}-{batch_sha}"
    if image_exists(tag):
        cp = run(["docker", "run", "--rm", tag, "python3", "-c",
                  "import json,os;"
                  "b=json.load(open('/bro2/agentos.config.json'))['budget'];"
                  "t=open('/bro2/.throttle-sha').read().strip() if os.path.exists('/bro2/.throttle-sha') else '';"
                  f"print(1 if (b['maxTokens']=={BUDGET['maxTokens']} and b['maxSeconds']=={BUDGET['maxSeconds']}"
                  f" and t=='{fp}') else 0)"])
        if cp.stdout.strip() == "1":
            return tag
    bdir = os.path.join(w, "build")
    os.makedirs(bdir, exist_ok=True)
    for item in ("src", "bin", "agentos.config.json", "package.json"):
        s = os.path.join(ROOT, item)
        d = os.path.join(bdir, "bro2", item) if item in ("src", "bin") else os.path.join(bdir, "bro2", item)
        if os.path.exists(d):
            if os.path.isdir(d):
                shutil.rmtree(d)
            else:
                os.remove(d)
        if os.path.isdir(s):
            shutil.copytree(s, d)
        else:
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)
    shutil.copy2(THROTTLE, os.path.join(bdir, "bro2", "ovh-throttle.mjs"))
    shutil.copytree(os.path.join(w, "tests"), os.path.join(bdir, "tests"), dirs_exist_ok=True)

    dockerfile = f"""FROM {img}
# 绕过 apt：本环境容器 apt 下载 8MB Packages 索引会卡死（pip/wget 直连却秒级），
# 改用 pip 装 pytest + wget 装 Node22 官方 tar.gz（均实测 ~10s）。纯构建优化，不改判分/预算。
RUN python3 -m pip install --no-cache-dir -q pytest && \
    wget -q -O /tmp/node.tar.gz https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-x64.tar.gz && \
    mkdir -p /usr/local/n22 && tar -xzf /tmp/node.tar.gz -C /usr/local/n22 --strip-components=1 && \
    rm -f /tmp/node.tar.gz
# bash -lc 登录 shell 会重置 PATH，故软链到 /usr/local/bin（默认 PATH 内含）确保 node 可见。
RUN ln -sf /usr/local/n22/bin/node /usr/local/bin/node && \
    ln -sf /usr/local/n22/bin/npm /usr/local/bin/npm && \
    ln -sf /usr/local/n22/bin/npx /usr/local/bin/npx
COPY bro2/ /bro2/
COPY tests/ /tests/
RUN echo -n '{fp}' > /bro2/.throttle-sha
RUN mkdir -p /logs/verifier && python3 - <<'PY'
import json
p='/bro2/agentos.config.json'; d=json.load(open(p)); b=d.setdefault('budget',{{}})
b['maxSeconds']={BUDGET['maxSeconds']}; b['maxSteps']={BUDGET['maxSteps']}; b['maxTokens']={BUDGET['maxTokens']}
# 2.1 任务 I/O 全在 /app：workspace 与写白名单都必须含 /app，否则 bro2 写 /app 被拒
perm=d.setdefault('permission',{{}})
perm['workspace']='/app'
perm['allowedPaths']=['/app', '/bro2/data/workspace', '/bro2/data/scratch']
json.dump(d,open(p,'w'),indent=2)
PY
WORKDIR /bro2
"""
    open(os.path.join(bdir, "Dockerfile"), "w").write(dockerfile)
    # 慢网络下 apt/node 安装可能 >15min，放宽到 30min；超时按失败处理让上层重试。
    cp = run(["docker", "build", "-t", tag, bdir], timeout=1800)
    if cp.returncode != 0:
        return None
    return tag


def verify_in_container(cid: str, timeout: int = 900) -> tuple[int, str]:
    """容器内跑官方判分器，返回 (reward, note)。超时按 fail（0）保守处理。"""
    cp = run(["docker", "exec", cid, "bash", "-lc",
              "cd /app && python3 -m pytest /tests/test_outputs.py -q >/tmp/v.out 2>&1; echo $?"],
             timeout=timeout)
    if "timeout" in (cp.stderr or ""):
        return 0, "verifier-timeout"
    rc = cp.stdout.strip().splitlines()[-1] if cp.stdout.strip() else "1"
    return (1 if rc == "0" else 0), f"rc={rc}"


def sanity_empty_fails(task: str, tag: str) -> tuple[bool, str]:
    """判别力 gate：初始镜像（无 agent 产出）上 verifier 必须 fail。"""
    cid = f"tb21-sanity-{task}"
    run(["docker", "rm", "-f", cid])
    cp = run(["docker", "run", "-d", "--name", cid, tag, "sleep", "300"])
    if cp.returncode != 0:
        return False, "container-start-fail"
    try:
        reward, note = verify_in_container(cid, timeout=300)
    finally:
        run(["docker", "rm", "-f", cid])
    # reward=0 表示空工作区无解 → 有判别力；reward=1 表示恒 pass → 无判别力
    return reward == 0, f"empty-reward={reward} ({note})"


def run_trial(task: str, repeat: int, tag: str) -> dict:
    """单个 trial：同容器跑 bro2 + verifier，产出不跨容器。"""
    cid = f"tb21-{task}-r{repeat}"
    run(["docker", "rm", "-f", cid])
    os.makedirs(LOGDIR, exist_ok=True)
    logf = os.path.join(LOGDIR, f"{task}-r{repeat}.log")
    instr = os.path.join(CACHE, task, "instruction.md")
    t0 = time.time()
    # 题面从仓库 mount 进容器（镜像本身不含 instruction.md）
    cp = run(["docker", "run", "-d", "--name", cid,
              "-v", f"{instr}:/app/instruction.md:ro", tag, "sleep", "4200"])
    if cp.returncode != 0:
        return {"task": task, "repeat": repeat, "status": "error", "err": "container-start-fail", "ts": now()}

    bro2_rc, reward, steps, tokens = None, None, None, None
    try:
        # bro2 在容器内跑（workspace=/app，ovhcloud 节流）
        with open(logf, "w") as lf:
            p = subprocess.Popen(
                ["docker", "exec", cid, "bash", "-lc",
                 'cd /bro2 && AGENTOS_LIVE_PROVIDER=ovhcloud '
                 'NODE_OPTIONS="--import /bro2/ovh-throttle.mjs" '
                 'node --experimental-strip-types --no-warnings bin/agentos.ts run '
                 '--model ovhcloud --task "$(cat /app/instruction.md)" '
                 '--preset standard --auto-approve --quiet'],
                stdout=lf, stderr=subprocess.STDOUT, text=True,
            )
            try:
                bro2_rc = p.wait(timeout=3900)
            except subprocess.TimeoutExpired:
                p.kill()
                bro2_rc = 124
        log = open(logf, errors="replace").read()
        m = re.search(r"(\d+)\s*步", log)
        steps = int(m.group(1)) if m else None
        m = re.search(r"(\d+)\s*tokens", log, re.I)
        tokens = int(m.group(1)) if m else None
        # 关键：bro2 主进程退出后，其启动的解法子进程（如死循环的 Rscript）可能残留，
        # 会拖垮同容器的 verifier。先清理孤儿进程，仅保留 PID 1（容器 sleep）。
        run(["docker", "exec", cid, "bash", "-lc",
             "for p in $(ls /proc | grep -E '^[0-9]+$'); do "
             "[ \"$p\" = 1 ] && continue; "
             "cmd=$(tr '\\0' ' ' </proc/$p/cmdline 2>/dev/null); "
             "case \"$cmd\" in *Rscript*|*/usr/lib/R/*|*python*test_outputs*) kill -9 $p 2>/dev/null;; esac; "
             "done; true"], timeout=60)
        # 同容器跑官方 verifier（带超时，防止 verifier 自身 hang）
        reward, vnote = verify_in_container(cid, timeout=900)
    finally:
        run(["docker", "rm", "-f", cid])

    return {
        "task": task, "repeat": repeat, "status": "ok",
        "reward": reward, "verifyNote": vnote, "steps": steps, "tokens": tokens,
        "bro2_rc": bro2_rc, "wallSeconds": round(time.time() - t0, 1),
        "log": os.path.relpath(logf, ROOT), "ts": now(),
    }


def print_status(tasks: list[str]) -> None:
    done = load_done()
    if not os.path.exists(RESULTS):
        print("尚无结果文件")
        return
    rows = [json.loads(l) for l in open(RESULTS) if l.strip()]
    rewards = [r["reward"] for r in rows if r.get("status") == "ok" and r.get("reward") is not None]
    print(f"已完成 trial: {len(done)} / {len(tasks)*3}  ({len(tasks)} 题 × 3 repeats)")
    if rewards:
        print(f"已判分 reward: {sum(rewards)}/{len(rewards)} = {sum(rewards)/len(rewards):.4f}")
    skipped = [r for r in rows if r.get("status") in ("skip", "error")]
    if skipped:
        print(f"跳过/错误: {len(skipped)}")
        for r in skipped[:20]:
            print("  ", r.get("task"), r.get("repeat"), r.get("status"), r.get("err") or r.get("reason", ""))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="本会话最多新跑多少 trial（0=不限）")
    ap.add_argument("--task", help="只跑指定题")
    ap.add_argument("--repeat", type=int, default=3, help="每题 repeat 数（默认 3）")
    ap.add_argument("--status", action="store_true", help="只看进度")
    args = ap.parse_args()

    tasks = load_tasks()
    if args.status:
        print_status(tasks)
        return
    if args.task:
        tasks = [args.task]

    done = load_done()
    images = load_images()
    skipped_tasks: set[str] = set()
    new = 0

    print(f"[{now()}] 全量任务 {len(tasks)} 题，已完成 {len(done)} trials，limit={args.limit or '∞'}")

    for task in tasks:
        if task in skipped_tasks:
            continue
        img = images.get(task)
        if not img:
            append_result({"task": task, "status": "error", "err": "no-image", "ts": now()})
            skipped_tasks.add(task)
            print(f"  [{task}] SKIP: 无 docker_image")
            continue
        # 是否所有 repeat 都已完成
        pending = [r for r in range(1, args.repeat + 1) if (task, r) not in done]
        if not pending:
            continue

        print(f"  [{task}] prepare...", flush=True)
        tag = prepare(task, img)
        if not tag:
            append_result({"task": task, "status": "error", "err": "prepare-fail", "ts": now()})
            skipped_tasks.add(task)
            print(f"  [{task}] SKIP: prepare 失败")
            continue

        # 判别力 gate：只在首次 prepare 后做一次
        gate_key = os.path.join(CACHE, task, ".sound")
        if os.path.exists(gate_key):
            sound = open(gate_key).read().strip() == "1"
            gate_note = "cached"
        else:
            sound, gate_note = sanity_empty_fails(task, tag)
            open(gate_key, "w").write("1" if sound else "0")
        if not sound:
            append_result({"task": task, "status": "skip", "reason": f"no-discrimination ({gate_note})", "ts": now()})
            skipped_tasks.add(task)
            print(f"  [{task}] SKIP: verifier 无判别力 ({gate_note})")
            continue

        for r in pending:
            if args.limit and new >= args.limit:
                print(f"  达到 limit={args.limit}，本会话停止（可 resume）")
                return
            print(f"  [{task}] repeat {r}/{args.repeat} 开跑（ovhcloud 节流，约 15-40min）...", flush=True)
            row = run_trial(task, r, tag)
            row["sanity"] = gate_note
            row["image"] = img
            append_result(row)
            new += 1
            print(f"  [{task}] r{r} -> reward={row.get('reward')} "
                  f"steps={row.get('steps')} wall={row.get('wallSeconds')}s", flush=True)

    print(f"[{now()}] 本轮新跑 {new} 个 trial。完成度：{len(load_done())}/{len(tasks)*3}")


if __name__ == "__main__":
    main()
