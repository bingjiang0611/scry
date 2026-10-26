import { HOOK_ENV_KEYS } from '../core/turn-recorder/commit-environment.js'
import { PROTOCOL_VERSION } from '../core/turn-recorder/daemon.js'
import { object } from './workspace-files.js'


export type InitProvider = 'claude' | 'codex' | 'qoder' | 'opencode'
export const PROVIDERS = ['claude', 'codex', 'qoder', 'opencode'] as const
export const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'] as const
/**
 * Session-end hooks per Provider, registered only where the Provider really has the event. Claude
 * publishes `SessionEnd` in its SDK `HOOK_EVENTS`; Codex and Qoder expose no verified session-end
 * hook, and OpenCode has no session-end event at all, so they stay unregistered rather than pretend
 * parity. Without it those Providers rely on turn-end resolution instead of an earlier close.
 */
export const PROVIDER_SESSION_END_EVENTS: Record<Exclude<InitProvider, 'opencode'>, readonly string[]> = {
  claude: ['SessionEnd'],
  codex: [],
  qoder: []
}
/** Session end must only persist and enqueue, so it gets a much tighter budget than a turn end. */
export const SESSION_END_HOOK_TIMEOUT_SECONDS = 3

export function providerEvents(provider: Exclude<InitProvider, 'opencode'>): readonly string[] {
  return [...EVENTS, ...PROVIDER_SESSION_END_EVENTS[provider]]
}

export function isSessionEndEvent(provider: Exclude<InitProvider, 'opencode'>, event: string): boolean {
  return PROVIDER_SESSION_END_EVENTS[provider].includes(event)
}
export const HANDLER_ID = 'turn-recorder-v1'
export const CONFIG_PATHS: Record<Exclude<InitProvider, 'opencode'>, string> = {
  claude: '.claude/settings.local.json',
  codex: '.codex/hooks.json',
  qoder: '.qoder/settings.json'
}
export const PROJECT_DIR_ENV: Record<Exclude<InitProvider, 'opencode'>, string> = {
  claude: 'CLAUDE_PROJECT_DIR',
  codex: 'CODEX_PROJECT_DIR',
  qoder: 'QODER_PROJECT_DIR'
}

export function providerHookSource(): string {
  const environment = HOOK_ENV_KEYS.map(key =>
    `  if [ "\${${key}+x}" = x ]; then printf '%s\\0%s\\0' '${key}' "$${key}"; fi`
  ).join('\n')
  return `#!/bin/sh
set -u
unset SCRY_RECORDER_DAEMON_TRIED
workspace="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 0
# Failure-only diagnostics: the successful fast path starts no extra process.
skip() {
  # Invalid storage must not turn an observational error into a write outside this workspace.
  [ ! -L "$workspace/.scry" ] && [ ! -L "$workspace/.scry/logs" ] && [ ! -L "$workspace/.scry/logs/hook-skip.log" ] || exit 0
  (umask 077; mkdir -p "$workspace/.scry/logs" &&
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$provider" "$event" "$1" "\${2:-0}" >> "$workspace/.scry/logs/hook-skip.log") 2>/dev/null || :
  exit 0
}
provider="\${1:-unknown}"
event="\${2:-unknown}"
IFS= read -r scry_bin < "$workspace/.scry/cli-path" || skip cli_path_missing
IFS= read -r node_bin_dir < "$workspace/.scry/node-bin-dir" || skip node_bin_dir_missing
PATH="$node_bin_dir:$PATH"
export PATH SCRY_HANDLER_ID=${HANDLER_ID}
if [ "\${SCRY_RECORDER_MANAGED:-0}" = "1" ]; then
  [ -x "\${SCRY_CLI_PATH:-}" ] || skip managed_cli_invalid
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
    -H 'x-scry-protocol: ${PROTOCOL_VERSION}' -H "x-scry-provider: $1" -H "x-scry-event: $2" \
    -H 'content-type: application/octet-stream' --data-binary @- http://localhost/v1/hook 2>/dev/null)"
  rc=$?
  [ "$rc" = "0" ] && [ "$code" = "200" ] && exit 0
  case "$rc:$code" in
    7:*|0:4??)
      # Connection failed or the daemon rejected before apply: let the CLI retry normally.
      unset SCRY_RECORDER_DAEMON_TRIED ;;
    *)
      # Timeout, broken response or server failure may follow delivery; preserve for replay.
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

export function hookCommand(provider: Exclude<InitProvider, 'opencode'>, event: string): string {
  // Only shell builtins run on successful lookup. Stop at the nearest git boundary so a
  // nested repository cannot silently send its hooks to an enclosing workspace's recorder.
  const body = [
    `root="\${${PROJECT_DIR_ENV[provider]}:-$PWD}"`,
    'case "$root" in /*) ;; *) root="$PWD/$root" ;; esac',
    `while :; do if [ -x "$root/.scry/provider-hook.sh" ]; then exec "$root/.scry/provider-hook.sh" ${provider} ${event}; fi; [ -e "$root/.git" ] && break; [ "$root" = "/" ] && break; root="\${root%/*}"; [ -n "$root" ] || root="/"; done`,
    'state="${XDG_STATE_HOME:-${HOME:+$HOME/.local/state}}"',
    '[ -n "$state" ] || exit 0',
    '[ ! -L "$state" ] && [ ! -L "$state/scry" ] && [ ! -L "$state/scry/hook-skip.log" ] || exit 0',
    `(umask 077; mkdir -p "$state/scry" && printf "%s\\t${provider}\\t${event}\\tbridge_not_found\\t0\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$state/scry/hook-skip.log") 2>/dev/null || :`,
    'exit 0'
  ].join('; ')
  return `SCRY_HANDLER_ID=${HANDLER_ID} sh -c '${body}'`
}

export function mergeProviderSettings(
  source: string | null,
  path: string,
  provider: Exclude<InitProvider, 'opencode'>
): string {
  let settings: Record<string, unknown> = {}
  if (source != null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      throw new Error(`${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    const root = object(parsed)
    if (!root) throw new Error(`${path} 必须是 JSON object`)
    settings = root
  }
  if (settings.hooks === undefined) settings.hooks = {}
  const hooks = object(settings.hooks)
  if (!hooks) throw new Error(`${path}.hooks 必须是 JSON object`)
  for (const event of providerEvents(provider)) {
    const current = hooks[event] ?? []
    if (!Array.isArray(current)) throw new Error(`${path}.hooks.${event} 必须是 array`)
    const command = hookCommand(provider, event)
    const alreadyInstalled = current.some((group) => {
      const record = object(group)
      return Array.isArray(record?.hooks) && record.hooks.some((entry) => object(entry)?.command === command)
    })
    if (!alreadyInstalled) {
      const timeout = isSessionEndEvent(provider, event)
        ? SESSION_END_HOOK_TIMEOUT_SECONDS
        : event === 'UserPromptSubmit' || event === 'Stop' ? 15 : 10
      current.push({ hooks: [{ type: 'command', command, timeout }] })
    }
    hooks[event] = current
  }
  return `${JSON.stringify(settings, null, 2)}\n`
}

export function openCodePluginSource(): string {
  return `// Managed by scry init. SCRY_HANDLER_ID=${HANDLER_ID}
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hook = resolve(root, '.scry/provider-hook.sh')
const turns = new Map()
// session.idle can repeat without new work. Retain only this instance's last 128 idle sessions;
// after eviction/reload the first unpaired idle is unknown and must still reach the recorder.
const idleSessions = new Set()

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const text = (parts) => Array.isArray(parts)
  ? parts.filter((part) => part?.type === 'text' && !part.ignored).map((part) => part.text).filter(Boolean).join('\\n')
  : ''

function utf8Prefix(value, limit) {
  const source = Buffer.from(String(value ?? ''))
  if (source.byteLength <= limit) return { value: source.toString('utf8') }
  let end = limit
  while (end > Math.max(0, limit - 4)) {
    try {
      const retained = new TextDecoder('utf-8', { fatal: true }).decode(source.subarray(0, end))
      return {
        value: retained,
        capture: { status: 'partial', reason: 'byte_limit', originalBytes: source.byteLength, retainedBytes: Buffer.byteLength(retained) }
      }
    } catch { end-- }
  }
  const retained = source.subarray(0, end).toString('utf8')
  return {
    value: retained,
    capture: { status: 'partial', reason: 'byte_limit', originalBytes: source.byteLength, retainedBytes: Buffer.byteLength(retained) }
  }
}

function sessionId(input) {
  const event = object(input?.event)
  const properties = object(event.properties)
  const info = object(first(input?.info, properties.info))
  return String(first(input?.sessionID, input?.sessionId, properties.sessionID, properties.sessionId, info.sessionID, info.sessionId, info.id, ''))
}

function tool(input, output = {}) {
  const raw = String(first(input?.tool, input?.tool_name, input?.name, ''))
  const args = object(first(output?.args, input?.args, input?.input, {}))
  if (raw === 'skill') return { name: 'Skill', input: { ...args, skill: first(args.skill, args.name) } }
  const aliases = { bash: 'Bash', edit: 'Edit', glob: 'Glob', grep: 'Grep', read: 'Read', task: 'Task', write: 'Write' }
  const builtins = new Set(['apply_patch', 'batch', 'bash', 'edit', 'glob', 'grep', 'list', 'read', 'skill', 'task', 'todoread', 'todowrite', 'webfetch', 'write'])
  const separator = raw.indexOf('_')
  if (separator > 0 && !builtins.has(raw)) {
    const server = raw.slice(0, separator).replaceAll('-', '_')
    return { name: 'mcp__' + server + '__' + raw.slice(separator + 1), input: args }
  }
  return { name: aliases[raw] ?? raw, input: args }
}

function usage(state) {
  const observed = [...(state?.usage?.values() ?? [])]
  if (observed.length === 0) return undefined
  const rows = observed.map((info) => {
    // Streaming assistant messages contain initialized zero counters, not terminal usage.
    if (typeof info.time?.completed !== 'number' || !Number.isFinite(info.time.completed)) return {}
    return Object.fromEntries(Object.entries({
      input_tokens: info.tokens?.input,
      output_tokens: info.tokens?.output,
      cache_read_input_tokens: info.tokens?.cache?.read,
      cache_creation_input_tokens: info.tokens?.cache?.write,
      reasoning_tokens: info.tokens?.reasoning,
      cost_usd: info.cost
    }).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0))
  })
  const totals = {}
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) totals[key] = (totals[key] ?? 0) + value
  }
  if (!Object.keys(totals).length) return undefined
  const required = new Set(['input_tokens', 'output_tokens', ...Object.keys(totals)])
  const complete = rows.every((row) => [...required].every((key) => key in row))
  return { totals, complete }
}

function deliver(event, payload) {
  const result = spawnSync(hook, ['opencode', event], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: event === 'Stop' ? 15000 : 10000
  })
  if (result.error) process.stderr.write('[scry-recorder] ' + event + ': ' + result.error.message + '\\n')
  return result
}

function payload(event, input, output = {}) {
  const call = tool(input, output)
  return {
    session_id: sessionId(input),
    hook_event_name: event,
    prompt: first(input?.prompt, text(input?.parts), text(output?.parts)),
    tool_name: call.name,
    tool_use_id: first(input?.callID, input?.callId, input?.tool_use_id),
    tool_input: call.input,
    tool_response: first(output?.output, output?.result, input?.result),
    cwd: root
  }
}

export const ScryRecorder = async () => ({
  'chat.message': async (input, output) => {
    const id = sessionId(input)
    const prompt = first(input?.prompt, text(input?.parts), text(output?.parts), '')
    idleSessions.delete(id)
    turns.set(id, { assistant: new Map(), assistantMessages: new Set(), usage: new Map() })
    deliver('UserPromptSubmit', { ...payload('UserPromptSubmit', input, output), prompt })
  },
  'tool.execute.before': async (input, output) => deliver('PreToolUse', payload('PreToolUse', input, output)),
  'tool.execute.after': async (input, output) => {
    const event = output?.error ? 'PostToolUseFailure' : 'PostToolUse'
    deliver(event, payload(event, input, output))
  },
  event: async (input) => {
    const envelope = object(input?.event)
    const properties = object(envelope.properties)
    const id = sessionId(input)
    const state = turns.get(id)
    const status = object(properties.status)
    if (envelope.type === 'session.status' && (status.type === 'busy' || status.type === 'retry')) idleSessions.delete(id)
    if (envelope.type === 'message.updated' && state) {
      const info = object(properties.info)
      if (info.role === 'assistant' && info.id) {
        state.assistantMessages.add(String(info.id))
        state.usage.set(String(info.id), info)
      }
    }
    if (envelope.type === 'message.part.updated' && state) {
      const part = object(properties.part)
      if (part.type === 'text' && part.text && !part.ignored && state.assistantMessages.has(String(part.messageID))) {
        state.assistant.set(String(first(part.id, state.assistant.size)), part.text)
      }
    }
    if (envelope.type === 'session.idle') {
      if (idleSessions.has(id)) return
      const assistant = utf8Prefix(state ? [...state.assistant.values()].join('\\n') : '', 262144)
      const observedUsage = usage(state)
      const delivered = deliver('Stop', {
        ...payload('Stop', input),
        assistant_response: assistant.value,
        ...(assistant.capture ? { scry_capture: { schemaVersion: 1, fields: { assistant_response: assistant.capture } } } : {}),
        ...(observedUsage ? {
          // Older recorders must see unavailable, never an exact partial sum.
          ...(observedUsage.complete ? { usage: observedUsage.totals } : { usage_partial: observedUsage.totals }),
          usage_complete: observedUsage.complete
        } : {})
      })
      turns.delete(id)
      // Failed dispatch is not evidence of a delivered terminal. Do not suppress a later retry.
      if (!delivered.error && delivered.status === 0) {
        idleSessions.add(id)
        if (idleSessions.size > 128) idleSessions.delete(idleSessions.values().next().value)
      }
    }
  }
})

export default ScryRecorder
`
}
