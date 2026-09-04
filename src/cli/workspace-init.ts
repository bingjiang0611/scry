import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'
import { PROTOCOL_VERSION } from '../core/turn-recorder/daemon.js'
import { piIntegrationStatus } from './pi-integration.js'

export type InitProvider = 'claude' | 'codex' | 'qoder' | 'opencode'

export interface WorkspaceInitOptions {
  workspace: string
  providers?: string
  cliPath: string
  nodePath?: string
  env?: NodeJS.ProcessEnv
}

export interface WorkspaceInitResult {
  workspace: string
  providers: InitProvider[]
  changedFiles: string[]
  unchangedFiles: string[]
  codexTrustRequired: boolean
}

const execFileAsync = promisify(execFile)
const PROVIDERS = ['claude', 'codex', 'qoder', 'opencode'] as const
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'] as const
const HANDLER_ID = 'turn-recorder-v1'
const CONFIG_PATHS: Record<Exclude<InitProvider, 'opencode'>, string> = {
  claude: '.claude/settings.local.json',
  codex: '.codex/hooks.json',
  qoder: '.qoder/settings.json'
}
const PROJECT_DIR_ENV: Record<Exclude<InitProvider, 'opencode'>, string> = {
  claude: 'CLAUDE_PROJECT_DIR',
  codex: 'CODEX_PROJECT_DIR',
  qoder: 'QODER_PROJECT_DIR'
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function commandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (await executable(join(directory, command))) return true
  }
  return false
}

function parseProviders(source: string): InitProvider[] {
  const result: InitProvider[] = []
  for (const value of source.split(/[\s,]+/).filter(Boolean)) {
    if (!PROVIDERS.includes(value as InitProvider)) {
      throw new Error(`暂不支持 Provider：${value}（当前支持 ${PROVIDERS.join('、')}；Pi 请使用 scry integrations install-pi）`)
    }
    if (!result.includes(value as InitProvider)) result.push(value as InitProvider)
  }
  if (result.length === 0) throw new Error('--providers 不能为空')
  return result
}

/** Non-throwing detection shared by `init` and `status`. */
export async function detectWorkspaceProviders(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<InitProvider[]> {
  const checks: Array<[InitProvider, boolean]> = [
    ['claude', await exists(join(workspace, '.claude')) || await commandExists('claude', env)],
    ['codex', await exists(join(workspace, '.codex')) || await commandExists('codex', env)],
    ['qoder', await exists(join(workspace, '.qoder')) || await commandExists('qodercli', env) || await commandExists('qoder', env)],
    ['opencode', await exists(join(workspace, '.opencode')) || await commandExists('opencode', env)]
  ]
  return checks.filter(([, found]) => found).map(([provider]) => provider)
}

/**
 * Identify managed hooks by handler id rather than by exact command equality, so a changed
 * command shape is still recognised as installed instead of silently appending a duplicate.
 */
export async function providerHookInstalled(workspace: string, provider: InitProvider): Promise<boolean> {
  const path = provider === 'opencode'
    ? join(workspace, '.opencode/plugins/scry-recorder.js')
    : join(workspace, CONFIG_PATHS[provider])
  const source = await readFile(path, 'utf8').catch(() => null)
  return source != null && source.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)
}

async function detectProviders(workspace: string, env: NodeJS.ProcessEnv): Promise<InitProvider[]> {
  const providers = await detectWorkspaceProviders(workspace, env)
  if (providers.length === 0) {
    throw new Error(`没有检测到 Provider；请显式指定，例如：scry init --providers claude,codex`)
  }
  return providers
}

async function exactGitRoot(workspace: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(workspace)
  } catch {
    throw new Error(`目录不存在：${workspace}`)
  }
  let root: string
  try {
    const result = await execFileAsync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    root = await realpath(result.stdout.trim())
  } catch {
    throw new Error(`当前目录不是 Git 项目根目录：${canonical}`)
  }
  if (canonical !== root) throw new Error(`请在 Git 项目根目录执行：${root}`)
  return root
}

function workspaceId(workspace: string): string {
  return basename(workspace).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
}

function defaultConfig(workspace: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: workspaceId(workspace),
    dataDir: '.scry',
    repositories: { mode: 'discover-nested-git', maxDepth: 2 },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }, null, 2)}\n`
}

function providerHookSource(): string {
  return `#!/bin/sh
set -u
workspace="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 0
IFS= read -r scry_bin < "$workspace/.scry/cli-path" || exit 0
IFS= read -r node_bin_dir < "$workspace/.scry/node-bin-dir" || exit 0
PATH="$node_bin_dir:$PATH"
export PATH SCRY_HANDLER_ID=${HANDLER_ID}
if [ "\${SCRY_RECORDER_MANAGED:-0}" = "1" ]; then
  [ -x "\${SCRY_CLI_PATH:-}" ] || exit 0
  scry_bin="$SCRY_CLI_PATH"
  exec "$scry_bin" recorder hook --provider "$1" --event "$2" --workspace "$workspace" --stdin --quiet --managed
fi
# Read the payload once so the fallback can resend it: stdin cannot be replayed.
payload="$(cat)"
# Posting straight to a running daemon skips a Node start per event, which dominates hook cost.
# Anything other than HTTP 200 falls through to the CLI, so an old or wedged daemon cannot drop events.
socket="\${SCRY_RECORDER_SOCKET:-$workspace/.scry/recorder-v1.sock}"
if [ "\${SCRY_RECORDER_TRANSPORT:-}" != "direct" ] && [ -S "$socket" ] && command -v curl >/dev/null 2>&1; then
  case "$2" in
    UserPromptSubmit|Stop) deadline=4 ;;
    *) deadline=1 ;;
  esac
  code="$(printf '%s' "$payload" | curl -s -o /dev/null -w '%{http_code}' --max-time "$deadline" \
    --unix-socket "$socket" -X POST \
    -H 'x-scry-protocol: ${PROTOCOL_VERSION}' -H "x-scry-provider: $1" -H "x-scry-event: $2" \
    -H 'content-type: application/json' --data-binary @- http://localhost/v1/hook 2>/dev/null)" || code=""
  [ "$code" = "200" ] && exit 0
fi
[ -x "$scry_bin" ] || exit 0
printf '%s' "$payload" | "$scry_bin" recorder hook --provider "$1" --event "$2" --workspace "$workspace" --stdin --quiet
exit 0
`
}

function hookCommand(provider: Exclude<InitProvider, 'opencode'>, event: typeof EVENTS[number]): string {
  const body = `root="\${${PROJECT_DIR_ENV[provider]}:-$PWD}"; exec "$root/.scry/provider-hook.sh" ${provider} ${event}`
  return `SCRY_HANDLER_ID=${HANDLER_ID} sh -c '${body}'`
}

function mergeProviderSettings(
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
  for (const event of EVENTS) {
    const current = hooks[event] ?? []
    if (!Array.isArray(current)) throw new Error(`${path}.hooks.${event} 必须是 array`)
    const command = hookCommand(provider, event)
    const alreadyInstalled = current.some((group) => {
      const record = object(group)
      return Array.isArray(record?.hooks) && record.hooks.some((entry) => object(entry)?.command === command)
    })
    if (!alreadyInstalled) {
      current.push({
        hooks: [{ type: 'command', command, timeout: event === 'UserPromptSubmit' || event === 'Stop' ? 15 : 10 }]
      })
    }
    hooks[event] = current
  }
  return `${JSON.stringify(settings, null, 2)}\n`
}

function openCodePluginSource(): string {
  return `// Managed by scry init. SCRY_HANDLER_ID=${HANDLER_ID}
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hook = resolve(root, '.scry/provider-hook.sh')
const turns = new Map()

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const text = (parts) => Array.isArray(parts)
  ? parts.filter((part) => part?.type === 'text' && !part.ignored).map((part) => part.text).filter(Boolean).join('\\n')
  : ''

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
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0, cost_usd: 0 }
  for (const info of state?.usage?.values() ?? []) {
    totals.input_tokens += Number(info.tokens?.input ?? 0)
    totals.output_tokens += Number(info.tokens?.output ?? 0)
    totals.cache_read_input_tokens += Number(info.tokens?.cache?.read ?? 0)
    totals.cache_creation_input_tokens += Number(info.tokens?.cache?.write ?? 0)
    totals.reasoning_tokens += Number(info.tokens?.reasoning ?? 0)
    totals.cost_usd += Number(info.cost ?? 0)
  }
  return totals
}

function deliver(event, payload) {
  const result = spawnSync(hook, ['opencode', event], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: event === 'Stop' ? 15000 : 10000
  })
  if (result.error) process.stderr.write('[scry-recorder] ' + event + ': ' + result.error.message + '\\n')
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
    if (envelope.type === 'message.updated' && state) {
      const info = object(properties.info)
      if (info.role === 'assistant' && info.id) {
        state.assistantMessages.add(String(info.id))
        if (info.tokens) state.usage.set(String(info.id), info)
      }
    }
    if (envelope.type === 'message.part.updated' && state) {
      const part = object(properties.part)
      if (part.type === 'text' && part.text && !part.ignored && state.assistantMessages.has(String(part.messageID))) {
        state.assistant.set(String(first(part.id, state.assistant.size)), part.text)
      }
    }
    if (envelope.type === 'session.idle') {
      deliver('Stop', {
        ...payload('Stop', input),
        assistant_response: state ? [...state.assistant.values()].join('\\n').slice(0, 262144) : '',
        usage: usage(state)
      })
      turns.delete(id)
    }
  }
})

export default ScryRecorder
`
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeAtomic(path: string, source: string, mode = 0o600): Promise<boolean> {
  const current = await readOptional(path)
  if (current === source) return false
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, source, { mode })
  await chmod(temporary, mode)
  await rename(temporary, path)
  return true
}

async function gitExcludePath(workspace: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' })
  const value = result.stdout.trim()
  return value.startsWith('/') ? value : resolve(workspace, value)
}

function mergeExclude(source: string | null): string {
  const lines = source?.split(/\r?\n/) ?? []
  for (const entry of ['.scry/', '.scry-disabled']) {
    if (!lines.includes(entry)) lines.push(entry)
  }
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\n').replace(/\n+$/, '')}\n`
}

export async function initWorkspace(options: WorkspaceInitOptions): Promise<WorkspaceInitResult> {
  const env = options.env ?? process.env
  const workspace = await exactGitRoot(resolve(options.workspace))
  const providers = options.providers ? parseProviders(options.providers) : await detectProviders(workspace, env)
  const cliPath = await realpath(options.cliPath).catch(() => options.cliPath)
  if (!await executable(cliPath)) throw new Error(`Scry CLI 不可执行：${cliPath}`)
  const nodePath = await realpath(options.nodePath ?? process.execPath).catch(() => options.nodePath ?? process.execPath)

  const planned = new Map<string, { source: string; mode?: number }>()
  const configPath = join(workspace, 'scry.config.json')
  const existingConfig = await readOptional(configPath)
  if (existingConfig == null) {
    planned.set(configPath, { source: defaultConfig(workspace) })
  } else {
    const location = await resolveRecorderLocation(workspace)
    if (!location.valid) throw new Error(`${configPath} 无效：${location.detail ?? location.reason}`)
  }

  for (const provider of providers) {
    if (provider === 'opencode') {
      const path = join(workspace, '.opencode/plugins/scry-recorder.js')
      const current = await readOptional(path)
      if (current != null && !current.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)) {
        throw new Error(`${path} 已存在且不由 Scry 管理，请先改名或移除`)
      }
      planned.set(path, { source: openCodePluginSource() })
      continue
    }
    const path = join(workspace, CONFIG_PATHS[provider])
    planned.set(path, { source: mergeProviderSettings(await readOptional(path), path, provider) })
  }

  planned.set(join(workspace, '.scry/cli-path'), { source: `${cliPath}\n` })
  planned.set(join(workspace, '.scry/node-bin-dir'), { source: `${dirname(nodePath)}\n` })
  planned.set(join(workspace, '.scry/provider-hook.sh'), { source: providerHookSource(), mode: 0o700 })
  const excludePath = await gitExcludePath(workspace)
  planned.set(excludePath, { source: mergeExclude(await readOptional(excludePath)) })

  const changedFiles: string[] = []
  const unchangedFiles: string[] = []
  await mkdir(join(workspace, '.scry'), { recursive: true, mode: 0o700 })
  await chmod(join(workspace, '.scry'), 0o700)
  for (const [path, value] of planned) {
    const changed = await writeAtomic(path, value.source, value.mode)
    ;(changed ? changedFiles : unchangedFiles).push(path)
  }

  return {
    workspace,
    providers,
    changedFiles,
    unchangedFiles,
    codexTrustRequired: providers.includes('codex')
  }
}

export interface ProviderIntegrationDiff {
  provider: InitProvider
  path: string
  present: boolean
  /** Lifecycle events that carry a managed entry, identified by handler id. */
  managedEvents: string[]
  missingEvents: string[]
  /** Events whose managed entry appears more than once (drift from command reshapes). */
  duplicateEvents: string[]
  /** Entries written by someone else; uninstall must preserve them. */
  foreignEntries: number
  detail?: string
}

export interface ArtifactDiff {
  path: string
  kind: 'opencode-plugin' | 'hook-script' | 'cli-path' | 'node-bin-dir' | 'git-exclude' | 'config' | 'records'
  status: 'managed' | 'present' | 'absent' | 'unmanaged'
  detail?: string
}

export interface IntegrationsDiffResult {
  workspace: string
  providers: ProviderIntegrationDiff[]
  artifacts: ArtifactDiff[]
  pi: { installed: boolean; scope: 'user-global'; detail: string }
}

function managedCommand(value: unknown): boolean {
  const entry = object(value)
  return typeof entry?.command === 'string' && entry.command.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)
}

async function providerDiff(workspace: string, provider: Exclude<InitProvider, 'opencode'>): Promise<ProviderIntegrationDiff> {
  const path = join(workspace, CONFIG_PATHS[provider])
  const source = await readOptional(path)
  if (source == null) {
    return {
      provider,
      path,
      present: false,
      managedEvents: [],
      missingEvents: [...EVENTS],
      duplicateEvents: [],
      foreignEntries: 0
    }
  }
  let hooks: Record<string, unknown> | null
  try {
    hooks = object(object(JSON.parse(source))?.hooks)
  } catch (error) {
    return {
      provider,
      path,
      present: true,
      managedEvents: [],
      missingEvents: [...EVENTS],
      duplicateEvents: [],
      foreignEntries: 0,
      detail: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    }
  }
  const managedEvents: string[] = []
  const duplicateEvents: string[] = []
  let foreignEntries = 0
  for (const event of EVENTS) {
    const groups = hooks?.[event]
    if (!Array.isArray(groups)) continue
    let managed = 0
    for (const group of groups) {
      const entries = object(group)?.hooks
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (managedCommand(entry)) managed++
        else foreignEntries++
      }
    }
    if (managed > 0) managedEvents.push(event)
    if (managed > 1) duplicateEvents.push(event)
  }
  return {
    provider,
    path,
    present: true,
    managedEvents,
    missingEvents: EVENTS.filter((event) => !managedEvents.includes(event)),
    duplicateEvents,
    foreignEntries
  }
}

export async function integrationsDiff(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<IntegrationsDiffResult> {
  const root = resolve(workspace)
  const providers: ProviderIntegrationDiff[] = []
  for (const provider of PROVIDERS) {
    if (provider === 'opencode') continue
    providers.push(await providerDiff(root, provider))
  }
  const pluginPath = join(root, '.opencode/plugins/scry-recorder.js')
  const plugin = await readOptional(pluginPath)
  providers.push({
    provider: 'opencode',
    path: pluginPath,
    present: plugin != null,
    managedEvents: plugin?.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`) ? [...EVENTS] : [],
    missingEvents: plugin?.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`) ? [] : [...EVENTS],
    duplicateEvents: [],
    foreignEntries: plugin != null && !plugin.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`) ? 1 : 0,
    ...(plugin != null && !plugin.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)
      ? { detail: '插件已存在但不由 Scry 管理' }
      : {})
  })

  const artifacts: ArtifactDiff[] = []
  const hookScript = join(root, '.scry/provider-hook.sh')
  const hookSource = await readOptional(hookScript)
  artifacts.push({
    path: hookScript,
    kind: 'hook-script',
    status: hookSource == null ? 'absent' : hookSource.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`) ? 'managed' : 'unmanaged'
  })
  for (const [relative, kind] of [['.scry/cli-path', 'cli-path'], ['.scry/node-bin-dir', 'node-bin-dir']] as const) {
    artifacts.push({
      path: join(root, relative),
      kind,
      status: await exists(join(root, relative)) ? 'managed' : 'absent'
    })
  }
  artifacts.push({
    path: join(root, 'scry.config.json'),
    kind: 'config',
    status: await exists(join(root, 'scry.config.json')) ? 'present' : 'absent',
    detail: 'uninstall 保留；删除后 recorder 会 fail closed'
  })
  artifacts.push({
    path: join(root, '.scry/records'),
    kind: 'records',
    status: await exists(join(root, '.scry/records')) ? 'present' : 'absent',
    detail: 'uninstall 保留；轮次记录属于你，不要手删单个文件（会制造 sequence gap）'
  })
  const excludePath = await gitExcludePath(root).catch(() => null)
  if (excludePath) {
    const exclude = await readOptional(excludePath)
    artifacts.push({
      path: excludePath,
      kind: 'git-exclude',
      status: exclude?.includes('.scry/') ? 'managed' : 'absent',
      detail: 'uninstall 保留：记录仍在仓库内，移除忽略会导致误提交'
    })
  }
  const pi = await piIntegrationStatus({ home: env.HOME }).catch(() => null)
  return {
    workspace: root,
    providers,
    artifacts,
    pi: {
      installed: pi?.installed === true,
      scope: 'user-global',
      detail: 'Pi 集成是用户级扩展，不属于本 workspace；需单独处理'
    }
  }
}

export interface IntegrationsUninstallResult {
  workspace: string
  rewritten: string[]
  removed: string[]
  retained: Array<{ path: string; reason: string }>
  skipped: Array<{ path: string; reason: string }>
}

/**
 * Remove only entries carrying our handler id. Foreign hooks in the same group survive, and a
 * group is dropped solely when it becomes empty. Records, config and the Git exclude entry are
 * retained on purpose and reported, so uninstall never silently discards a team's evidence.
 */
export async function integrationsUninstall(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<IntegrationsUninstallResult> {
  const root = resolve(workspace)
  const rewritten: string[] = []
  const removed: string[] = []
  const retained: Array<{ path: string; reason: string }> = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const provider of PROVIDERS) {
    if (provider === 'opencode') continue
    const path = join(root, CONFIG_PATHS[provider])
    const source = await readOptional(path)
    if (source == null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      skipped.push({ path, reason: '不是合法 JSON，未修改' })
      continue
    }
    const settings = object(parsed)
    const hooks = object(settings?.hooks)
    if (!settings || !hooks) continue
    let changed = false
    for (const event of EVENTS) {
      const groups = hooks[event]
      if (!Array.isArray(groups)) continue
      const keptGroups: unknown[] = []
      for (const group of groups) {
        const record = object(group)
        const entries = record?.hooks
        if (!Array.isArray(entries)) {
          keptGroups.push(group)
          continue
        }
        const keptEntries = entries.filter((entry) => !managedCommand(entry))
        if (keptEntries.length !== entries.length) changed = true
        if (keptEntries.length === 0) continue
        keptGroups.push(keptEntries.length === entries.length ? group : { ...record, hooks: keptEntries })
      }
      if (keptGroups.length === 0) delete hooks[event]
      else hooks[event] = keptGroups
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks
    if (!changed) continue
    const mode = await stat(path).then((info) => info.mode & 0o777).catch(() => 0o600)
    await writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`, mode)
    rewritten.push(path)
  }

  const pluginPath = join(root, '.opencode/plugins/scry-recorder.js')
  const plugin = await readOptional(pluginPath)
  if (plugin != null) {
    if (plugin.includes(`SCRY_HANDLER_ID=${HANDLER_ID}`)) {
      await rm(pluginPath, { force: true })
      removed.push(pluginPath)
    } else {
      skipped.push({ path: pluginPath, reason: '不由 Scry 管理，未删除' })
    }
  }

  for (const relative of ['.scry/provider-hook.sh', '.scry/cli-path', '.scry/node-bin-dir']) {
    const path = join(root, relative)
    if (!await exists(path)) continue
    await rm(path, { force: true })
    removed.push(path)
  }

  if (await exists(join(root, '.scry/records'))) {
    retained.push({ path: join(root, '.scry/records'), reason: '轮次记录归你所有，不自动删除' })
  }
  if (await exists(join(root, 'scry.config.json'))) {
    retained.push({ path: join(root, 'scry.config.json'), reason: '保留以便重新 init；删除后 recorder fail closed' })
  }
  const excludePath = await gitExcludePath(root).catch(() => null)
  if (excludePath && (await readOptional(excludePath))?.includes('.scry/')) {
    retained.push({ path: excludePath, reason: '保留 .scry/ 忽略，避免记录被误提交' })
  }
  const pi = await piIntegrationStatus({ home: env.HOME }).catch(() => null)
  if (pi?.installed) {
    retained.push({ path: pi.target, reason: 'Pi 用户级扩展，不属于本 workspace；需手动移除' })
  }
  return { workspace: root, rewritten, removed, retained, skipped }
}

export interface IntegrationsRepairResult {
  workspace: string
  providers: InitProvider[]
  rewritten: string[]
  unchanged: string[]
}

/**
 * Re-apply managed hooks for providers that are already installed. Managed entries are stripped
 * by handler id and rewritten in canonical form, which repairs duplicates left by an earlier
 * command reshape; foreign hooks and providers that were never installed are left alone.
 */
export async function integrationsRepair(options: {
  workspace: string
  cliPath: string
  nodePath?: string
  env?: NodeJS.ProcessEnv
}): Promise<IntegrationsRepairResult> {
  const env = options.env ?? process.env
  const root = resolve(options.workspace)
  const cliPath = await realpath(options.cliPath).catch(() => options.cliPath)
  if (!await executable(cliPath)) throw new Error(`Scry CLI 不可执行：${cliPath}`)
  const nodePath = await realpath(options.nodePath ?? process.execPath).catch(() => options.nodePath ?? process.execPath)

  const diff = await integrationsDiff(root, env)
  const installed = diff.providers
    .filter((row) => row.present && row.managedEvents.length > 0)
    .map((row) => row.provider)
  if (installed.length === 0) {
    return { workspace: root, providers: [], rewritten: [], unchanged: [] }
  }

  const planned = new Map<string, { source: string; mode?: number }>()
  for (const provider of installed) {
    if (provider === 'opencode') {
      planned.set(join(root, '.opencode/plugins/scry-recorder.js'), { source: openCodePluginSource() })
      continue
    }
    const path = join(root, CONFIG_PATHS[provider])
    const stripped = stripManagedHooks(await readOptional(path), path)
    planned.set(path, { source: mergeProviderSettings(stripped, path, provider) })
  }
  planned.set(join(root, '.scry/cli-path'), { source: `${cliPath}\n` })
  planned.set(join(root, '.scry/node-bin-dir'), { source: `${dirname(nodePath)}\n` })
  planned.set(join(root, '.scry/provider-hook.sh'), { source: providerHookSource(), mode: 0o700 })

  const rewritten: string[] = []
  const unchanged: string[] = []
  await mkdir(join(root, '.scry'), { recursive: true, mode: 0o700 })
  for (const [path, value] of planned) {
    const mode = value.mode ?? await stat(path).then((info) => info.mode & 0o777).catch(() => 0o600)
    ;(await writeAtomic(path, value.source, mode) ? rewritten : unchanged).push(path)
  }
  return { workspace: root, providers: installed, rewritten, unchanged }
}

/** Drop every managed entry so the canonical merge cannot append a duplicate. */
function stripManagedHooks(source: string | null, path: string): string | null {
  if (source == null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const settings = object(parsed)
  const hooks = object(settings?.hooks)
  if (!settings || !hooks) return source
  for (const event of EVENTS) {
    const groups = hooks[event]
    if (!Array.isArray(groups)) continue
    const kept: unknown[] = []
    for (const group of groups) {
      const record = object(group)
      const entries = record?.hooks
      if (!Array.isArray(entries)) {
        kept.push(group)
        continue
      }
      const keptEntries = entries.filter((entry) => !managedCommand(entry))
      if (keptEntries.length > 0) kept.push(keptEntries.length === entries.length ? group : { ...record, hooks: keptEntries })
    }
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  return `${JSON.stringify(settings, null, 2)}\n`
}
