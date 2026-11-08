#!/bin/sh
# bro2 · 改进同步闭环（ship）
# ----------------------------------------------------------
# 把「一次改进」收敛为「提交 + 推送」的单一动作，避免只做本地提交而漏推远程。
# 推送统一走 push-remote.sh（唯一通道，复用仓库外 600 权限 PAT，凭证不入库）。
#
# 用法：
#   npm run ship                              提交当前工作区改进并推送
#   npm run ship -- --rounds 8 "<msg>"       先推进 8 轮真实迭代，再提交推送
#   npm run ship -- "<自定义提交信息>"        用指定信息提交并推送
#
# 设计约束：
#   - 迭代本身离线可复现，网络只出现在最后的推送环节；
#   - 提交前还原门禁/演示改写的运行时噪声，避免时间戳差异混进提交；
#   - 提交身份取仓库 .git/config 的干净身份，不引入任何 AI 痕迹；
#   - 推送完成后跑一次同步自检，漏推就地暴露。
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MSG="chore(evolve): 迭代水位推进与远程同步"
ROUNDS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rounds) ROUNDS="${2:-1}"; shift 2 ;;
    -*) echo "ship: 未知选项 $1" >&2; exit 2 ;;
    *) MSG="$1"; shift ;;
  esac
done

# 1) 可选：推进真实迭代（纯离线，不含网络）
if [ -n "$ROUNDS" ]; then
  node --experimental-strip-types --no-warnings bin/evolve-loop.ts --rounds "$ROUNDS"
fi

# 2) 还原运行时噪声（这些文件会被验收脚本顺带改写时间戳/延迟，提交它们只会制造假 diff）
for f in data/evolve/incidents.jsonl data/evolve/ledger.jsonl data/live-link-smoke.json data/eval-report.json; do
  if [ -f "$f" ]; then git restore -- "$f" 2>/dev/null || true; fi
done

# 3) 提交全部改进（凭证文件位于仓库外，绝不会被纳入）
git add -A
if git diff --cached --quiet; then
  echo "ship: 无待提交改动，仅执行推送"
else
  echo "ship: 本次提交文件"
  git diff --cached --name-status
  git commit -m "$MSG"
fi

# 4) 唯一推送通道 + 闭环自检
sh scripts/push-remote.sh
echo "--- 同步自检 ---"
node --experimental-strip-types --no-warnings scripts/remote-check.ts
