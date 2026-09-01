#!/bin/sh
set -eu

fail() {
  printf 'Scry 初始化失败：%s\n' "$1" >&2
  exit 1
}

absolute_executable() {
  candidate="$1"
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
  directory="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$directory" "$(basename "$candidate")"
}

workspace="${1:-$PWD}"
[ -d "$workspace" ] || fail "目录不存在：$workspace"
workspace="$(cd "$workspace" && pwd -P)"

command -v node >/dev/null 2>&1 || fail "缺少 Node.js 20 或更高版本"
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
case "$node_major" in
  ''|*[!0-9]*) fail "无法读取 Node.js 版本" ;;
esac
[ "$node_major" -ge 20 ] || fail "Node.js 版本过低，需要 20 或更高版本"

if [ -n "${SCRY_CLI_PATH:-}" ]; then
  scry_bin="$SCRY_CLI_PATH"
elif command -v scry >/dev/null 2>&1; then
  scry_bin="$(command -v scry)"
elif [ -x "$HOME/.local/bin/scry" ]; then
  scry_bin="$HOME/.local/bin/scry"
else
  command -v npm >/dev/null 2>&1 || fail "缺少 npm，无法安装 Scry CLI"
  registry="${SCRY_NPM_REGISTRY:-https://registry.npmjs.org}"
  printf '安装 Scry CLI 到 %s/.local ...\n' "$HOME"
  npm install -g --prefix "$HOME/.local" scry-turn-recorder@latest \
    --registry="$registry" >/dev/null
  scry_bin="$HOME/.local/bin/scry"
fi
scry_bin="$(absolute_executable "$scry_bin")" || fail "Scry CLI 不可执行：$scry_bin"

if [ -n "${SCRY_PROVIDERS:-}" ]; then
  exec "$scry_bin" init --workspace "$workspace" --providers "$SCRY_PROVIDERS"
fi
exec "$scry_bin" init --workspace "$workspace"
