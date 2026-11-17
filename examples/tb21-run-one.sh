#!/usr/bin/env bash
# bro2 · Terminal-Bench 2.1 单题手动 Harbor 等价 runner（v2.34.0, 路径① PoC 产物）
#
# 作用：把 bro2 接到 2.1 公开 89 题集的「官方 per-task 镜像 + 官方 verifier」上，
# 用 gpt-oss-120b（ovhcloud，测量侧 2 req/min 节流）真实解题，产出与公开榜同口径的分。
# 这是对「用 89 题公开测试 bro2 以对齐榜单」的最小可执行单元。
#
# 已验证（constraints-scheduling）：bro2(gpt-oss-120b) 真实解题 → 官方 verifier 出 reward。
#   - 官方 solve.sh → reward=1（管线正确性）；bro2 真实产出 → reward=0（时段与已有日程冲突，真实能力表现）
#
# 四个适配点（均为测量侧，不改 src）：
#   1. workspace 对齐：bro2 默认把文件写到 data/workspace；必须设 config.permission.workspace=/app
#      （2.1 任务的工作目录与产出都在 /app）。
#   2. verifier 基础设施：官方 test.sh 从 github 下载 uv 在本环境不稳定；改用 apt 装 python3-pytest
#      后直接 `python3 -m pytest /tests/test_outputs.py`，判分器本身（test_outputs.py）原样使用。
#   3. 墙钟/预算：2 req/min 下每题 15–40 min，需在配置里放宽 maxSeconds（如 3600）/ maxTokens
#      （如 240000），否则被 budget 墙钟腰斩（与 v2.33 同款「显式放宽墙钟」）。
#   4. 限流：NODE_OPTIONS=--import ovh-throttle.mjs 给 ovhcloud 请求加 ≥31s 间隔 + 429 重试。
#
# 用法：bash examples/tb21-run-one.sh <taskName> [repeat]
#   例：bash examples/tb21-run-one.sh constraints-scheduling 1
#
# 依赖：docker、网络（pull 镜像 / 容器内 apt + ovhcloud 出网）、本仓库 bro2 源码。
set -euo pipefail

TASK="${1:?用法: tb21-run-one.sh <taskName> [repeat]}"
REPEAT="${2:-1}"
COMMIT="7131e4375048a0e408a8fb404b5f499d726b695b"          # terminal-bench-2-1 pinned 89 题
REPO="harbor-framework/terminal-bench-2-1"
BASE="https://raw.githubusercontent.com/${REPO}/${COMMIT}/tasks/${TASK}"
THROTTLE="$(cd "$(dirname "$0")" && pwd)/ovh-throttle.mjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

WORK="/tmp/tb21-${TASK}"
rm -rf "$WORK" && mkdir -p "$WORK/tests" "$WORK/bro2"
echo "==> [1/6] 拉取 2.1 任务文件：$TASK"
for f in task.toml instruction.md solution/solve.sh tests/test.sh tests/test_outputs.py; do
  out="$WORK/$(basename "$f")"; [ "$f" = "solution/solve.sh" ] && out="$WORK/solve.sh"
  [ "$f" = "tests/test.sh" ] && out="$WORK/tests/test.sh"
  [ "$f" = "tests/test_outputs.py" ] && out="$WORK/tests/test_outputs.py"
  code=$(curl -sL --max-time 60 -o "$out" -w "%{http_code}" "$BASE/$f")
  echo "    $f -> HTTP $code"
done

IMG=$(python3 -c "import re;print(re.search(r'docker_image\s*=\s*\"([^\"]+)\"',open('$WORK/task.toml').read()).group(1))")
echo "==> [2/6] 拉取已发布任务镜像：$IMG"
docker pull "$IMG"

echo "==> [3/6] 构建 bro2 wrapper 镜像"
cp -r "$ROOT/src" "$ROOT/bin" "$ROOT/agentos.config.json" "$ROOT/package.json" "$WORK/bro2/"
cp "$THROTTLE" "$WORK/bro2/ovh-throttle.mjs"
cat > "$WORK/Dockerfile" <<EOF
FROM $IMG
RUN apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y -qq nodejs && rm -rf /var/lib/apt/lists/*
COPY bro2/ /bro2/
COPY tests/ /tests/
RUN mkdir -p /logs/verifier /app/agent-out && node --version
# 测量侧：workspace 对齐到 /app，放宽墙钟/预算（不改 src）
RUN python3 - <<'PY'
import json
p='/bro2/agentos.config.json'; d=json.load(open(p)); b=d.setdefault('budget',{})
b['maxSeconds']=3600; b['maxSteps']=60; b['maxTokens']=240000
d.setdefault('permission',{})['workspace']='/app'
json.dump(d,open(p,'w'),indent=2)
PY
WORKDIR /bro2
EOF
docker build -t "bro2-tb21:${TASK}" "$WORK"

echo "==> [4/6] 运行 bro2(gpt-oss-120b) 解题，repeat=$REPEAT"
declare -a REWARDS=()
for r in $(seq 1 "$REPEAT"); do
  CID="tb21-${TASK}-${r}"
  docker run -d --name "$CID" -v "$WORK/instruction.md:/app/instruction.md:ro" "bro2-tb21:${TASK}" sleep 7200
  docker exec "$CID" bash -lc "cd /bro2 && AGENTOS_LIVE_PROVIDER=ovhcloud NODE_OPTIONS=\"--import /bro2/ovh-throttle.mjs\" node --experimental-strip-types --no-warnings bin/agentos.ts run --model ovhcloud --task \"\$(cat /app/instruction.md)\" --preset standard --auto-approve --quiet" > "$WORK/bro2-r${r}.log" 2>&1 || true
  # 把 bro2 实际产出（可能在 data/workspace）搬到 /app
  docker exec "$CID" bash -lc 'cp -f /bro2/data/workspace/*.ics /app/ 2>/dev/null || true'
  echo "    repeat $r: bro2 退出，见 $WORK/bro2-r${r}.log"
  docker rm -f "$CID" >/dev/null
  REWARDS+=("r${r}:skipped-verify")
done

echo "==> [5/6] 对每个 repeat 跑官方 verifier（apt pytest，不用 test.sh 的 uv 下载）"
i=0
for r in $(seq 1 "$REPEAT"); do
  CID="tb21-v-${TASK}-${r}"
  docker run -d --name "$CID" -v "$WORK/tests:/tests:ro" "bro2-tb21:${TASK}" sleep 600
  docker exec "$CID" bash -lc 'apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq python3-pytest >/dev/null 2>&1; cd /app && python3 -m pytest /tests/test_outputs.py -q >/tmp/v.out 2>&1; echo $?' >/dev/null
  RC=$(docker exec "$CID" bash -lc 'cd /app && python3 -m pytest /tests/test_outputs.py -q >/tmp/v.out 2>&1; echo $?')
  RW=$([ "$RC" = "0" ] && echo 1 || echo 0)
  REWARDS[$i]="r${r}:reward=${RW}"
  echo "    repeat $r -> reward=$RW (pytest rc=$RC)"
  docker cp "$CID:/tmp/v.out" "$WORK/verify-r${r}.log" 2>/dev/null || true
  docker rm -f "$CID" >/dev/null
  i=$((i+1))
done

echo "==> [6/6] 汇总"
echo "task=$TASK repeat=$REPEAT"
printf '  %s\n' "${REWARDS[@]}"
echo "reward.txt 列表：$WORK/rewards.json"
python3 -c "import json;json.dump({'task':'$TASK','repeat':$REPEAT,'rewards':$(python3 -c "import json;print(json.dumps([x.split(':')[1] for x in """${REWARDS[*]}""".split()]))")},open('$WORK/rewards.json','w'))"
echo "DONE"
