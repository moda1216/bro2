#!/bin/sh
# bro2 · 外部公开任务输入通道（可复现、带指纹校验）
#
# 作用：按 UPSTREAM.json 固定的 commit 从 Terminal-Bench 公开仓库拉取 3 个任务的
#       指令 / 输入 / 官方解 / 公开评分器，落到 data/bench/external/upstream/。
#       upstream/ 不入库（.gitignore），本仓库只分发坐标与 SHA256SUMS。
#
# 运行：sh examples/fetch-external-tasks.sh
# 依赖：curl、sha256sum（系统自带）；无需 API Key / GPU / Docker。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXT="$ROOT/data/bench/external"
DEST="$EXT/upstream"
SUMS="$EXT/SHA256SUMS"
COMMIT=$(sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' "$EXT/UPSTREAM.json" | head -1)
BASE="https://raw.githubusercontent.com/laude-institute/terminal-bench/$COMMIT/original-tasks"

if [ -z "$COMMIT" ]; then echo "无法从 UPSTREAM.json 读取 commit" >&2; exit 1; fi
echo "上游 commit : $COMMIT"
echo "目标目录   : $DEST"

# 清单即文件列表：第一列 sha256，第二列 ./<task>/<path>
while IFS= read -r line; do
  [ -z "$line" ] && continue
  sum=$(printf '%s\n' "$line" | awk '{print $1}')
  rel=$(printf '%s\n' "$line" | awk '{print $2}')
  path=${rel#./}
  mkdir -p "$DEST/$(dirname "$path")"
  if [ -f "$DEST/$path" ]; then
    actual=$(sha256sum "$DEST/$path" | awk '{print $1}')
    if [ "$actual" = "$sum" ]; then echo "  ✓ 已存在  $path"; continue; fi
  fi
  echo "  ↓ 拉取    $path"
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 --max-time 180 \
    "$BASE/$path" -o "$DEST/$path"
done < "$SUMS"

echo "指纹校验："
(cd "$DEST" && sha256sum -c "$SUMS")
echo "✓ 上游任务就绪。下一步：AGENTOS_LIVE_PROVIDER=kilo npm run external:measure"
