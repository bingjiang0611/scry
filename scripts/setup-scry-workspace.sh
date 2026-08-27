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
node_bin="$(absolute_executable "$(command -v node)")" || fail "Node.js 不可执行"

providers="${SCRY_PROVIDERS:-}"
if [ -z "$providers" ]; then
  command -v claude >/dev/null 2>&1 && providers="$providers claude"
  command -v codex >/dev/null 2>&1 && providers="$providers codex"
  if command -v qodercli >/dev/null 2>&1 || command -v qoder >/dev/null 2>&1; then
    providers="$providers qoder"
  fi
fi
[ -n "$providers" ] || fail "没有检测到 Claude、Codex 或 Qoder；可用 SCRY_PROVIDERS='claude codex' 指定"

installed=""
for provider in $providers; do
  case "$provider" in
    claude|codex|qoder) ;;
    *) fail "暂不支持 Provider：$provider（当前支持 claude、codex、qoder）" ;;
  esac
  case " $installed " in
    *" $provider "*) ;;
    *) installed="$installed $provider" ;;
  esac
done

if [ -n "${SCRY_CLI_PATH:-}" ]; then
  scry_bin="$SCRY_CLI_PATH"
elif command -v scry >/dev/null 2>&1; then
  scry_bin="$(command -v scry)"
elif [ -x "$HOME/.local/bin/scry" ]; then
  scry_bin="$HOME/.local/bin/scry"
else
  command -v npm >/dev/null 2>&1 || fail "缺少 npm，无法安装 Scry CLI"
  registry="${SCRY_NPM_REGISTRY:-https://registry.npmjs.org}"
  printf '1/3 安装 Scry CLI 到 %s/.local ...\n' "$HOME"
  npm install -g --prefix "$HOME/.local" scry-turn-recorder@latest \
    --registry="$registry" >/dev/null
  scry_bin="$HOME/.local/bin/scry"
fi
scry_bin="$(absolute_executable "$scry_bin")" || fail "Scry CLI 不可执行：$scry_bin"
printf '1/3 Scry CLI：%s\n' "$scry_bin"

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
  printf '2/3 已创建 %s\n' "$config"
else
  printf '2/3 保留已有 %s\n' "$config"
fi

mkdir -p "$workspace/.scry"
printf '%s\n' "$scry_bin" > "$workspace/.scry/cli-path"
printf '%s\n' "$(dirname "$node_bin")" > "$workspace/.scry/node-bin-dir"
hook="$workspace/.scry/provider-hook.sh"
hook_temporary="$hook.tmp.$$"
trap 'rm -f "$hook_temporary"' EXIT HUP INT TERM
{
  printf '#!/bin/sh\n'
  printf 'set -eu\n'
  printf 'workspace="$(cd "$(dirname "$0")/.." && pwd -P)"\n'
  printf 'IFS= read -r scry_bin < "$workspace/.scry/cli-path"\n'
  printf 'IFS= read -r node_bin_dir < "$workspace/.scry/node-bin-dir"\n'
  printf 'PATH="$node_bin_dir:$PATH"\n'
  printf 'export PATH SCRY_HANDLER_ID=turn-recorder-v1\n'
  printf 'if [ "${SCRY_RECORDER_MANAGED:-0}" = "1" ]; then\n'
  printf '  [ -x "${SCRY_CLI_PATH:-}" ] || exit 0\n'
  printf '  scry_bin="$SCRY_CLI_PATH"\n'
  printf '  exec "$scry_bin" recorder hook --provider "$1" --event "$2" --workspace "$workspace" --stdin --quiet --managed\n'
  printf 'fi\n'
  printf 'exec "$scry_bin" recorder hook --provider "$1" --event "$2" --workspace "$workspace" --stdin --quiet\n'
} > "$hook_temporary"
chmod 700 "$hook_temporary"
mv "$hook_temporary" "$hook"
trap - EXIT HUP INT TERM

node -e '
const fs = require("node:fs")
const path = require("node:path")

const [workspace, providerSource] = process.argv.slice(1)
const locations = {
  claude: ".claude/settings.local.json",
  codex: ".codex/hooks.json",
  qoder: ".qoder/settings.json"
}
const projectEnvs = {
  claude: "CLAUDE_PROJECT_DIR",
  codex: "CODEX_PROJECT_DIR",
  qoder: "QODER_PROJECT_DIR"
}
const quote = String.fromCharCode(39)
const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"]
const outputs = []

for (const provider of providerSource.split(/\s+/).filter(Boolean)) {
  const settingsPath = path.join(workspace, locations[provider])
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  let settings = {}
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error(`${settingsPath} must contain a JSON object`)
    }
  }
  if (settings.hooks === undefined) settings.hooks = {}
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error(`${settingsPath}.hooks must be a JSON object`)
  }

  for (const event of events) {
    const groups = settings.hooks[event] ?? []
    if (!Array.isArray(groups)) throw new Error(`${settingsPath}.hooks.${event} must be an array`)
    const marker = `${provider} ${event}${quote}`
    const exists = groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) =>
      typeof hook?.command === "string" && hook.command.endsWith(marker)
    ))
    if (!exists) {
      const body = `root="\${${projectEnvs[provider]}:-$PWD}"; exec "$root/.scry/provider-hook.sh" ${provider} ${event}`
      const command = `SCRY_HANDLER_ID=turn-recorder-v1 sh -c ${quote}${body}${quote}`
      groups.push({
        hooks: [{ type: "command", command, timeout: event === "UserPromptSubmit" || event === "Stop" ? 15 : 10 }]
      })
    }
    settings.hooks[event] = groups
  }

  outputs.push({ settingsPath, source: `${JSON.stringify(settings, null, 2)}\n` })
}

for (const { settingsPath, source } of outputs) {
  const temporary = `${settingsPath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, source, { mode: 0o600 })
  fs.renameSync(temporary, settingsPath)
}
' "$workspace" "${installed# }"
printf '3/3 已配置项目 Hook：%s\n' "${installed# }"

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

printf '\nScry 已配置完成。重新启动上述 Provider，执行一轮后运行：\n'
printf '  "%s" turns list --workspace "%s"\n' "$scry_bin" "$workspace"
