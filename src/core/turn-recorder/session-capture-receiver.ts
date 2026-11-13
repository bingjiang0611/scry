/**
 * The per-workspace session-capture receiver.
 *
 * CodeLens' guard runs on every host hook and must not pay a Node start per event, so `capture
 * start` publishes this small shell script. It posts the provider hook payload to the daemon's
 * versioned event path and only falls back to the CLI when the daemon could not have applied the
 * event. The path and version header are the same handshake ordinary hooks use, so a daemon from
 * another recorder version refuses before applying and the CLI replaces it instead of double
 * applying. Nothing is retried here: a timeout is reported as unknown delivery by exiting 0, and
 * the CLI queues that event rather than replaying it.
 */
export function captureReceiverSource(args: {
  socketPath: string
  workspace: string
  provider: string
  dataDir: string
  eventPath: string
  recorderVersion: string
  cli: { entry?: string; nodeDir?: string }
}): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  const fallback = args.cli.entry
    ? `if [ -n ${quote(args.cli.entry)} ]; then
  printf '%s' "$payload" | PATH=${quote(args.cli.nodeDir ?? '')}:"$PATH" "$scry_node" ${quote(args.cli.entry)} recorder hook \\
    --capture-mode session --event "$event" --workspace ${quote(args.workspace)} \\
    --provider "$capture_provider" --data-dir ${quote(args.dataDir)} --stdin --quiet
fi
`
    : ''
  const node = args.cli.entry && args.cli.nodeDir ? `${quote(args.cli.nodeDir)}/node` : 'node'
  return `#!/bin/sh
# Managed by scry. Session-capture receiver for codelens.session-capture.v1.
# Usage: receiver.sh <host> <event>
set -u
unset SCRY_RECORDER_DAEMON_TRIED
capture_provider=${quote(args.provider)}
scry_node=${node}
state_dir=${quote(args.dataDir)}/capture
socket=${quote(args.socketPath)}
provider="\${1:-}"
event="\${2:-}"
[ "$provider" = "$capture_provider" ] || exit 0
[ -n "$event" ] || exit 0
[ -d "$state_dir" ] || exit 0
payload="$(cat)" || exit 0
ack="$state_dir/.ack.$$"
if [ "\${SCRY_RECORDER_TRANSPORT:-}" != "direct" ] && [ -S "$socket" ] && command -v curl >/dev/null 2>&1; then
  case "$event" in
    UserPromptSubmit|Stop) deadline=4 ;;
    *) deadline=1 ;;
  esac
  code="$(printf '\\0%s' "$payload" | curl -s -o "$ack" -w '%{http_code}' --max-time "$deadline" \\
    --unix-socket "$socket" -X POST \\
    -H 'x-scry-protocol: 2' -H ${quote(`x-scry-recorder-version: ${args.recorderVersion}`)} \\
    -H 'x-scry-capture-mode: session' \\
    -H "x-scry-provider: $provider" -H "x-scry-event: $event" \\
    -H 'content-type: application/octet-stream' --data-binary @- \\
    "http://localhost${args.eventPath}" 2>/dev/null)"
  rc=$?
  if [ "$rc" = "0" ] && [ "$code" = "200" ] && grep -Eq '"status":"(accepted|ignored)"' "$ack" 2>/dev/null; then
    rm -f "$ack"
    exit 0
  fi
  rm -f "$ack"
  case "$rc:$code" in
    0:404|0:409)
      # An explicit pre-apply refusal: the daemon belongs to another recorder version. The CLI
      # replaces the owner and delivers once.
      unset SCRY_RECORDER_DAEMON_TRIED
      export SCRY_RECORDER_DAEMON_REJECTED=1 ;;
    7:*|0:4??)
      # No daemon or a refusal before applying: the CLI may still record it.
      unset SCRY_RECORDER_DAEMON_TRIED ;;
    *)
      # A timeout or broken response may follow delivery; never replay it blindly.
      export SCRY_RECORDER_DAEMON_TRIED=1 ;;
  esac
fi
${fallback}exit 0
`
}
