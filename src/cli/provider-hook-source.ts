import { HOOK_ENV_KEYS } from '../core/turn-recorder/commit-environment.js'
import { HOOK_EVENT_PATH, PROTOCOL_VERSION, RECORDER_VERSION_HEADER } from '../core/turn-recorder/daemon.js'
import { RECORDER_VERSION } from '../core/turn-recorder/store.js'

/**
 * 投递未成功的退出码。Provider 的 hook 仍然 exit 0（观测失败不能阻断 Agent）；只有 OpenCode 插件
 * 需要区分“真的送达”和“跳过了”，否则一次失败的 Stop 会被当成终态已交付。
 */
export const HANDLER_ID = 'turn-recorder-v1'
export const HOOK_UNDELIVERED_STATUS = 3

export function providerHookSource(): string {
  const environment = HOOK_ENV_KEYS.map(key =>
    `  if [ "\${${key}+x}" = x ]; then printf '%s\\0%s\\0' '${key}' "$${key}"; fi`
  ).join('\n')
  return `#!/bin/sh
set -u
unset SCRY_RECORDER_DAEMON_TRIED SCRY_RECORDER_DAEMON_REJECTED
workspace="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 0
# Failure-only diagnostics: the successful fast path starts no extra process.
not_delivered() {
  # OpenCode 的插件是本脚本唯一的调用方：它必须知道这次没有送达，才会保留暂存的终态错误并在下一次
  # session.idle 重试。Provider 自己的 hook 一律 exit 0——观测失败绝不能阻断 Agent 运行。
  [ "$provider" = opencode ] && exit ${HOOK_UNDELIVERED_STATUS}
  exit 0
}
skip() {
  # Invalid storage must not turn an observational error into a write outside this workspace.
  [ ! -L "$workspace/.scry" ] && [ ! -L "$workspace/.scry/logs" ] && [ ! -L "$workspace/.scry/logs/hook-skip.log" ] || not_delivered
  (umask 077; mkdir -p "$workspace/.scry/logs" &&
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$provider" "$event" "$1" "\${2:-0}" >> "$workspace/.scry/logs/hook-skip.log") 2>/dev/null || :
  not_delivered
}
provider="\${1:-unknown}"
event="\${2:-unknown}"
IFS= read -r scry_bin < "$workspace/.scry/cli-path" || skip cli_path_missing
IFS= read -r node_bin_dir < "$workspace/.scry/node-bin-dir" || skip node_bin_dir_missing
PATH="$node_bin_dir:$PATH"
export PATH SCRY_HANDLER_ID=${HANDLER_ID}
if [ "\${SCRY_RECORDER_MANAGED:-0}" = "1" ]; then
  [ -x "\${SCRY_CLI_PATH:-}" ] || skip managed_cli_invalid
  case "$provider:$event" in
    claude:PreToolUse|claude:PostToolUse|claude:PostToolUseFailure)
      if [ -n "\${SCRY_MANAGED_RUN_ID:-}" ] && [ -n "\${SCRY_MANAGED_PROMPT_HASH:-}" ]; then
        # Managed tool evidence comes from the App's canonical trace, not these hooks.
        # Keep lifecycle delivery for identity, health, queued replay and notifications;
        # activity counts only events actually delivered, never synthetic tool heartbeats.
        # Drain large payloads before exiting so the Provider does not see a broken pipe.
        cat >/dev/null || skip payload_read_failed
        exit 0
      fi ;;
  esac
  scry_bin="$SCRY_CLI_PATH"
  "$scry_bin" recorder hook --provider "$provider" --event "$event" --workspace "$workspace" --stdin --quiet --managed
  result=$?
  [ "$result" = "0" ] || skip managed_cli_failed "$result"
  exit 0
fi
# Read the payload once so the fallback can resend it: stdin cannot be replayed.
payload="$(cat)" || skip payload_read_failed
post_body() {
${environment}
  printf '\\0%s' "$payload"
}
# Posting straight to a running daemon skips a Node start per event, which dominates hook cost.
# Anything other than HTTP 200 falls through to the CLI, so an old or wedged daemon cannot drop events.
socket="\${SCRY_RECORDER_SOCKET:-$workspace/.scry/recorder-v1.sock}"
if [ -n "\${SCRY_RECORDER_SOCKET:-}" ]; then
  case "$socket" in /*) ;; *) socket="$workspace/$socket" ;; esac
elif [ -r "$workspace/.scry/recorder-socket-path" ]; then
  IFS= read -r recorded_socket < "$workspace/.scry/recorder-socket-path" || recorded_socket=""
  [ -S "$recorded_socket" ] && [ -O "$recorded_socket" ] && socket="$recorded_socket"
fi
if [ "\${SCRY_RECORDER_TRANSPORT:-}" != "direct" ] && [ -S "$socket" ] && command -v curl >/dev/null 2>&1; then
  case "$2" in
    UserPromptSubmit|Stop) deadline=4 ;;
    *) deadline=1 ;;
  esac
  code="$(post_body | curl -s -o /dev/null -w '%{http_code}' --max-time "$deadline" \
    --unix-socket "$socket" -X POST \
    -H 'x-scry-protocol: ${PROTOCOL_VERSION}' -H '${RECORDER_VERSION_HEADER}: ${RECORDER_VERSION}' \
    -H "x-scry-provider: $1" -H "x-scry-event: $2" \
    -H 'content-type: application/octet-stream' --data-binary @- http://localhost${HOOK_EVENT_PATH} 2>/dev/null)"
  rc=$?
  [ "$rc" = "0" ] && [ "$code" = "200" ] && exit 0
  case "$rc:$code" in
    0:404|0:409)
      # A completed 404/409 proves the daemon refused before apply (legacy path or version
      # handshake): the CLI replaces the owner and delivers once.
      unset SCRY_RECORDER_DAEMON_TRIED
      export SCRY_RECORDER_DAEMON_REJECTED="$code" ;;
    7:*|0:4??)
      # No daemon was reached, or the request itself was refused: deliver directly.
      unset SCRY_RECORDER_DAEMON_TRIED SCRY_RECORDER_DAEMON_REJECTED ;;
    *)
      # Timeout, broken response or server failure may follow delivery; replay instead of resending.
      export SCRY_RECORDER_DAEMON_TRIED=1 ;;
  esac
fi
[ -x "$scry_bin" ] || skip cli_not_executable
printf '%s' "$payload" | "$scry_bin" recorder hook --provider "$provider" --event "$event" --workspace "$workspace" --stdin --quiet
result=$?
[ "$result" = "0" ] || skip cli_failed "$result"
exit 0
`
}
