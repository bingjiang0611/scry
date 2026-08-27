#!/bin/sh
set -eu

fail() {
  printf 'Scry 初始化失败：%s\n' "$1" >&2
  exit 1
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
  registry="${SCRY_NPM_REGISTRY:-https://registry.anpm.alibaba-inc.com}"
  printf '安装 Scry CLI 到 %s/.local ...\n' "$HOME"
  npm install -g --prefix "$HOME/.local" @ali/scry-turn-recorder@latest \
    --registry="$registry" >/dev/null
  scry_bin="$HOME/.local/bin/scry"
fi

[ -f "$scry_bin" ] && [ -x "$scry_bin" ] || fail "Scry CLI 不可执行：$scry_bin"

config="$workspace/scry.config.json"
if [ ! -e "$config" ]; then
  workspace_id="$(basename "$workspace" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//')"
  [ -n "$workspace_id" ] || workspace_id="workspace"
  temporary="$config.tmp.$$"
  trap 'rm -f "$temporary"' EXIT HUP INT TERM
  umask 077
  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "enabled": true,\n'
    printf '  "workspaceId": "%s",\n' "$workspace_id"
    printf '  "dataDir": ".scry",\n'
    printf '  "repositories": { "mode": "discover-nested-git", "maxDepth": 2 },\n'
    printf '  "capture": {\n'
    printf '    "prompt": true,\n'
    printf '    "assistant": true,\n'
    printf '    "toolOutput": "summary",\n'
    printf '    "diff": true,\n'
    printf '    "hooks": true\n'
    printf '  }\n'
    printf '}\n'
  } > "$temporary"
  mv "$temporary" "$config"
  trap - EXIT HUP INT TERM
  printf '已创建 %s\n' "$config"
else
  printf '保留已有 %s\n' "$config"
fi

if git -C "$workspace" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exclude="$(git -C "$workspace" rev-parse --git-path info/exclude)"
  case "$exclude" in
    /*) ;;
    *) exclude="$workspace/$exclude" ;;
  esac
  mkdir -p "$(dirname "$exclude")"
  touch "$exclude"
  for entry in '.scry/' '.scry-disabled'; do
    grep -Fqx "$entry" "$exclude" || printf '%s\n' "$entry" >> "$exclude"
  done
fi

doctor_status=0
"$scry_bin" doctor --workspace "$workspace" || doctor_status=$?
case "$doctor_status" in
  0) ;;
  5) printf 'Scry 已可用，但现有记录有 pending、orphan 或 dropped，请按 doctor 输出排查。\n' >&2 ;;
  *) exit "$doctor_status" ;;
esac
printf '\nScry 工作区已就绪：%s\n' "$workspace"
printf 'CLI：%s\n' "$scry_bin"
case ":$PATH:" in
  *":$(dirname "$scry_bin"):"*) ;;
  *) printf '新终端若找不到 scry，请执行：export PATH="%s:$PATH"\n' "$(dirname "$scry_bin")" ;;
esac
printf '从 Scry App 打开这个目录后即可采集。直接运行其他 Agent 时，仍需接入对应 Provider Hook。\n'
