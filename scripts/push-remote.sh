#!/bin/sh
# bro2 远程同步：复用仓库外、600 权限的 fine-grained PAT 凭证。
# 设计约束（对应发布红线）：
#   - 凭证只从环境变量指定的文件读取，绝不硬编码、绝不写入仓库、绝不回显；
#   - 用一次性 askpass 通过 stdin 交给 git，绕过系统 GitHub App credential helper
#     （该 helper 的令牌对仓库写操作返回 403）；
#   - 屏蔽全局/系统 git 配置，避免 helper 抢先提供错误凭证；
#   - 用法：sh scripts/push-remote.sh [ref ...]
#     无参数时推送 main + 全部本地 tags；有参数时逐个推送指定 ref。
set -eu

PAT_FILE="${BRO2_GITHUB_PAT_FILE:-$HOME/.codebuddy/credentials/bro2-github-pat}"
if [ ! -r "$PAT_FILE" ]; then
  echo "push-remote: 缺少可读的 PAT 凭证文件: $PAT_FILE" >&2
  echo "            可通过 BRO2_GITHUB_PAT_FILE 指定路径" >&2
  exit 1
fi

ASKPASS="$(mktemp "${TMPDIR:-/tmp}/bro2-askpass.XXXXXX")"
chmod 700 "$ASKPASS"
trap 'rm -f "$ASKPASS"' EXIT INT TERM

# askpass 内容不含明文、也不内嵌凭证路径：仅按环境变量读取凭证文件
cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\n' x-access-token ;;
  *[Pp]assword*) /bin/cat "$BRO2_PAT_PATH" ;;
  *) printf '\n' ;;
esac
EOF
chmod 700 "$ASKPASS"

export BRO2_PAT_PATH="$PAT_FILE"
export GIT_ASKPASS="$ASKPASS"
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

if [ "$#" -eq 0 ]; then
  git push origin main
  git push origin --tags
else
  for ref in "$@"; do
    git push origin "$ref"
  done
fi

echo "push-remote: 同步完成（凭证未回显、未写入仓库）"
