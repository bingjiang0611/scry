import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { type TraceEvent, type ModelUsageRow, type McpLiveStatus, classifyTool, fileOpOf, parseMcp } from '../shared/trace'
import type {
  AgentPermissionMode,
  AgentRuntimeEvent,
  RuntimeCapabilityWarning,
  RuntimeFailureBrief,
  RuntimeFailureStage,
  RuntimeObservedMcpServer,
  RuntimeProvider
} from '../shared/runtime'
import type { EmitFn, RunHandle } from './agent-runner'

let counter = 0
const newId = (): string => `ev-${Date.now().toString(36)}-${(counter++).toString(36)}`
const now = (): string => new Date().toISOString()
const PROBE_TIMEOUT_MS = 15_000

type JsonRecord = Record<string, unknown>

export class AgentRuntimeError extends Error {
  readonly brief: RuntimeFailureBrief

  constructor(message: string, brief: RuntimeFailureBrief) {
    super(message)
    this.name = 'AgentRuntimeError'
    this.brief = brief
  }
}

export interface CliRuntimeOpts {
  runtimeProvider: Exclude<RuntimeProvider, 'claude_sdk'>
  executablePath: string
  cwd?: string
  env?: Record<string, string>
  extraAllowedDirs?: string[]
  configArgs?: string[]
  mcpConfigPath?: string
  promptPrefix?: string
  capabilityMetadata?: Record<string, unknown>
  sampleRoot?: string
  timeoutMs?: number
  permissionMode?: AgentPermissionMode
  bypassHookTrust?: boolean
  onSessionId?: (sessionId: string) => void
}

interface UsageSnapshot {
  usage?: unknown
  costUsd?: number | null
  modelUsage?: unknown
  durationMs?: number
  stopReason?: string
  isError?: boolean
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberAt(input: unknown, keys: string[]): number | undefined {
  if (!isRecord(input)) return undefined
  for (const key of keys) {
    const value = asNumber(input[key])
    if (value != null) return value
  }
  return undefined
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function errorMessageFrom(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  if (isRecord(value)) {
    if (typeof value.message === 'string' && value.message.length > 0) return value.message
    if (typeof value.error === 'string' && value.error.length > 0) return value.error
    if (value.error) return errorMessageFrom(value.error, fallback)
    if (typeof value.detail === 'string' && value.detail.length > 0) return value.detail
  }
  return fallback
}

function safeParseJson(value: unknown): unknown {
  if (value == null || typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseRuntimeMcpServers(value: unknown): RuntimeObservedMcpServer[] | undefined {
  if (!Array.isArray(value)) return undefined
  const servers = value
    .map((item): RuntimeObservedMcpServer | null => {
      if (!isRecord(item)) return null
      const name =
        typeof item.name === 'string'
          ? item.name
          : typeof item.id === 'string'
            ? item.id
            : typeof item.server === 'string'
              ? item.server
              : ''
      if (!name) return null
      const status = typeof item.status === 'string' && item.status.trim() ? item.status : 'unknown'
      const tools =
        asNumber(item.tools) ??
        asNumber(item.tool_count) ??
        (Array.isArray(item.tools) ? item.tools.length : undefined)
      return {
        name,
        status,
        serverName:
          typeof item.serverName === 'string'
            ? item.serverName
            : typeof item.server_name === 'string'
              ? item.server_name
              : undefined,
        serverVersion:
          typeof item.serverVersion === 'string'
            ? item.serverVersion
            : typeof item.server_version === 'string'
              ? item.server_version
              : undefined,
        tools
      }
    })
    .filter((server): server is RuntimeObservedMcpServer => server !== null)
  return servers.length > 0 ? servers : undefined
}

function normalizeMcpLiveStatus(status: string): McpLiveStatus['status'] {
  if (status === 'connected' || status === 'failed' || status === 'needs-auth' || status === 'pending' || status === 'disabled') {
    return status
  }
  if (status === 'needs_auth' || status === 'auth_required') return 'needs-auth'
  if (status === 'disconnected') return 'failed'
  return 'pending'
}

function runtimeMcpLiveStatus(servers: RuntimeObservedMcpServer[] | undefined): McpLiveStatus[] | undefined {
  if (!servers?.length) return undefined
  return servers.map((server) => ({
    name: server.name,
    status: normalizeMcpLiveStatus(server.status),
    serverName: server.serverName,
    serverVersion: server.serverVersion,
    tools: server.tools
  }))
}

function commandSummary(file: string, args: string[]): string {
  return [file, ...args].join(' ')
}

function sampleProvider(runtimeProvider: CliRuntimeOpts['runtimeProvider']): 'codex' | 'qoder' {
  return runtimeProvider === 'codex_cli' ? 'codex' : 'qoder'
}

function replacePrefix(value: string, prefix: string | undefined, label: string): string {
  if (!prefix) return value
  const normalized = prefix.replace(/\/+$/, '')
  if (!normalized) return value
  if (value === normalized) return label
  if (value.startsWith(`${normalized}/`)) return `${label}${value.slice(normalized.length)}`
  return value
}

function redactSamplePath(value: string, opts: CliRuntimeOpts): string {
  let out = value
  out = replacePrefix(out, opts.sampleRoot, '$SCRY_LOCAL_SAMPLE_DIR')
  out = replacePrefix(out, tmpdir(), '$TMPDIR')
  out = replacePrefix(out, homedir(), '$HOME')
  return out
}

function redactSampleValue(value: unknown, opts: CliRuntimeOpts): unknown {
  if (typeof value === 'string') return redactSamplePath(value, opts)
  if (Array.isArray(value)) return value.map((item) => redactSampleValue(item, opts))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactSampleValue(item, opts)]))
  }
  return value
}

interface RuntimeSampleRecorder {
  readonly path: string
  appendStdout(chunk: Buffer): void
  appendStderr(chunk: Buffer): void
  writeExit(exit: Record<string, unknown>): void
}

function createSampleRecorder(runId: string, opts: CliRuntimeOpts, args: string[]): RuntimeSampleRecorder | null {
  if (!opts.sampleRoot) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const samplePath = join(opts.sampleRoot, sampleProvider(opts.runtimeProvider), stamp)
  const redactedArgs = redactSampleValue(args, opts) as string[]
  mkdirSync(samplePath, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(samplePath, 'command-summary.json'),
    `${JSON.stringify(
      {
        runId,
        runtimeProvider: opts.runtimeProvider,
        createdAt: new Date().toISOString(),
        executablePath: redactSamplePath(opts.executablePath, opts),
        args: redactedArgs,
        commandSummary: commandSummary(redactSamplePath(opts.executablePath, opts), redactedArgs),
        cwd: opts.cwd ? redactSamplePath(opts.cwd, opts) : null,
        promptSource: 'stdin',
        promptCaptured: false
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(samplePath, 'environment-summary.json'),
    `${JSON.stringify(
      {
        envKeyCount: opts.env ? Object.keys(opts.env).length : 0,
        pathEntryCount: opts.env?.PATH?.split(':').filter(Boolean).length ?? 0,
        hasHome: !!opts.env?.HOME,
        hasShell: !!opts.env?.SHELL,
        capabilityMetadata: redactSampleValue(opts.capabilityMetadata ?? null, opts)
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(samplePath, 'redaction-notes.md'),
    [
      '# Redaction notes',
      '',
      '- The prompt is sent through stdin and is not written to command-summary.json.',
      '- Raw stdout/stderr are local evidence files under .local and may contain provider output.',
      '- Environment values are summarized by shape only; secret values are not written.'
    ].join('\n') + '\n'
  )
  let exitWritten = false
  return {
    path: samplePath,
    appendStdout(chunk: Buffer): void {
      appendFileSync(join(samplePath, 'stdout.raw.jsonl'), chunk)
    },
    appendStderr(chunk: Buffer): void {
      appendFileSync(join(samplePath, 'stderr.raw.log'), chunk)
    },
    writeExit(exit: Record<string, unknown>): void {
      if (exitWritten) return
      exitWritten = true
      writeFileSync(join(samplePath, 'exit.json'), `${JSON.stringify({ ...exit, recordedAt: new Date().toISOString() }, null, 2)}\n`)
    }
  }
}

interface ProbeCommandResult {
  args: string[]
  commandSummary: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  error?: string
}

function bufferString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function runProbeCommand(file: string, args: string[], env: Record<string, string> | undefined): ProbeCommandResult {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: env as NodeJS.ProcessEnv | undefined })
  return {
    args,
    commandSummary: commandSummary(file, args),
    exitCode: result.status,
    signal: result.signal,
    stdout: bufferString(result.stdout),
    stderr: bufferString(result.stderr),
    error: result.error?.message
  }
}

function inspectLocalCliFlags(file: string, requiredFlags: string[]): ProbeCommandResult {
  try {
    const text = readFileSync(file, 'utf8')
    const missing = missingFlags(text, requiredFlags)
    return {
      args: ['<local-flag-scan>'],
      commandSummary: `${file} <local-flag-scan>`,
      exitCode: missing.length === 0 ? 0 : 1,
      signal: null,
      stdout: JSON.stringify({
        present: requiredFlags.filter((flag) => !missing.includes(flag)),
        missing
      }),
      stderr: '',
      error: missing.length === 0 ? undefined : `missing flags: ${missing.join(', ')}`
    }
  } catch (err) {
    return {
      args: ['<local-flag-scan>'],
      commandSummary: `${file} <local-flag-scan>`,
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: '',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function probeCommandOk(result: ProbeCommandResult): boolean {
  return result.exitCode === 0 && !result.signal && !result.error
}

function createProbeEvidence(
  opts: CliRuntimeOpts,
  probes: ProbeCommandResult[],
  failureMessage: string
): string | undefined {
  if (!opts.sampleRoot) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const samplePath = join(opts.sampleRoot, sampleProvider(opts.runtimeProvider), stamp)
  mkdirSync(samplePath, { recursive: true, mode: 0o700 })
  const redactedProbes = redactSampleValue(probes, opts)
  writeFileSync(
    join(samplePath, 'command-summary.json'),
    `${JSON.stringify(
      {
        runtimeProvider: opts.runtimeProvider,
        phase: 'version_probe',
        createdAt: new Date().toISOString(),
        executablePath: redactSamplePath(opts.executablePath, opts),
        commandSummary: probes.map((probe) => commandSummary(redactSamplePath(opts.executablePath, opts), probe.args)),
        cwd: opts.cwd ? redactSamplePath(opts.cwd, opts) : null,
        promptSource: null,
        promptCaptured: false
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(samplePath, 'environment-summary.json'),
    `${JSON.stringify(
      {
        envKeyCount: opts.env ? Object.keys(opts.env).length : 0,
        pathEntryCount: opts.env?.PATH?.split(':').filter(Boolean).length ?? 0,
        hasHome: !!opts.env?.HOME,
        hasShell: !!opts.env?.SHELL
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(samplePath, 'probe-results.json'),
    `${JSON.stringify(
      {
        failureMessage,
        probes: redactedProbes
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(samplePath, 'redaction-notes.md'),
    [
      '# Redaction notes',
      '',
      '- This sample was created during CLI --version/--help probing.',
      '- No prompt was sent to the provider runtime.',
      '- Environment values are summarized by shape only; secret values are not written.'
    ].join('\n') + '\n'
  )
  return samplePath
}

export function buildCliArgs(opts: CliRuntimeOpts): string[] {
  const dirs = (opts.extraAllowedDirs ?? []).filter((d) => d.length > 0)
  if (opts.runtimeProvider === 'codex_cli') {
    const fullAccess = opts.permissionMode === 'full_access'
    const args = [
      'exec',
      ...(opts.configArgs ?? []),
      ...(opts.bypassHookTrust ? ['--dangerously-bypass-hook-trust'] : []),
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      fullAccess ? 'danger-full-access' : 'workspace-write',
      ...(fullAccess ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      '-c',
      'sandbox_workspace_write.network_access=true'
    ]
    if (opts.cwd) args.push('-C', opts.cwd)
    for (const dir of dirs) args.push('--add-dir', dir)
    return args
  }
  const permissionMode = opts.permissionMode === 'full_access'
    ? 'bypass_permissions'
    : opts.permissionMode === 'auto_review'
      ? 'auto'
      : 'default'
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--permission-mode', permissionMode,
    ...(opts.permissionMode === 'full_access' ? ['--dangerously-skip-permissions'] : [])
  ]
  if (opts.cwd) args.push('--cwd', opts.cwd)
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config')
  for (const dir of dirs) args.push('--add-dir', dir)
  return args
}

function missingFlags(text: string, flags: string[]): string[] {
  return flags.filter((flag) => !text.includes(flag))
}

export function assertRuntimeCliSurface(opts: CliRuntimeOpts): void {
  const probes: ProbeCommandResult[] = []
  try {
    const versionArgs = opts.runtimeProvider === 'qoder_cli' ? ['-v'] : ['--version']
    const versionProbe = runProbeCommand(opts.executablePath, versionArgs, opts.env)
    probes.push(versionProbe)
    if (!probeCommandOk(versionProbe)) {
      throw new Error(versionProbe.error || versionProbe.stderr.trim() || `${versionProbe.commandSummary} exited with ${versionProbe.exitCode ?? versionProbe.signal ?? 'unknown'}`)
    }
    const required =
      opts.runtimeProvider === 'codex_cli'
        ? [
            '--json', '--cd', '--add-dir', '--sandbox', '--skip-git-repo-check',
            '--ignore-user-config', '--dangerously-bypass-hook-trust'
          ]
        : [
            '--output-format', '--cwd', '--permission-mode', '--dangerously-skip-permissions',
            '--add-dir', '--mcp-config', '--strict-mcp-config'
          ]
    if (opts.runtimeProvider === 'codex_cli') {
      const helpProbe = runProbeCommand(opts.executablePath, ['exec', '--help'], opts.env)
      probes.push(helpProbe)
      if (!probeCommandOk(helpProbe)) {
        throw new Error(helpProbe.error || helpProbe.stderr.trim() || `${helpProbe.commandSummary} exited with ${helpProbe.exitCode ?? helpProbe.signal ?? 'unknown'}`)
      }
      const missing = missingFlags(helpProbe.stdout, required)
      if (missing.length > 0) throw new Error(`missing flags: ${missing.join(', ')}`)
    } else {
      const flagProbe = inspectLocalCliFlags(opts.executablePath, required)
      probes.push(flagProbe)
      if (!probeCommandOk(flagProbe)) throw new Error(flagProbe.error || `missing flags: ${required.join(', ')}`)
    }
  } catch (err) {
    const message = String((err as Error).message)
    const evidencePath = createProbeEvidence(opts, probes, message)
    throw errorFor(opts, 'version_probe', String((err as Error).message), {
      commandSummary:
        opts.runtimeProvider === 'codex_cli'
          ? `${opts.executablePath} --version && ${opts.executablePath} exec --help`
          : `${opts.executablePath} -v && ${opts.executablePath} <local-flag-scan>`,
      evidencePath
    })
  }
}

function errorFor(
  opts: CliRuntimeOpts,
  stage: RuntimeFailureStage,
  message: string,
  detail: Partial<RuntimeFailureBrief> = {}
): AgentRuntimeError {
  return new AgentRuntimeError(message, {
    provider: opts.runtimeProvider,
    stage,
    cwd: opts.cwd,
    nextAction: nextActionFor(stage, opts.runtimeProvider),
    ...detail
  })
}

function nextActionFor(stage: RuntimeFailureStage, provider: RuntimeProvider): string {
  if (stage === 'discovery') return provider === 'qoder_cli' ? '确认 qodercli 可执行文件位于登录 shell PATH 中' : '确认 CLI 在登录 shell PATH 中'
  if (stage === 'version_probe') return '运行 --version/--help，确认 CLI flag surface 与 adapter 匹配'
  if (stage === 'spawn') return '检查可执行权限、cwd 是否存在、以及 GUI 环境 PATH'
  if (stage === 'protocol') return '检查 CLI 是否支持 stdin prompt 与结构化输出参数组合'
  if (stage === 'parser') return '保存 raw JSONL 样本后更新 parser 映射'
  if (stage === 'capability') return '检查 MCP/skill 注入配置与 CLI 支持能力'
  return '查看 stderr/raw event，按失败层继续定位'
}

function textFromQoderBlock(block: unknown): string {
  if (!isRecord(block)) return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (typeof block.text === 'string') return block.text
  return ''
}

function normalizeTodoStatus(value: unknown): string {
  const status = typeof value === 'string' ? value.trim().toLowerCase().replace(/[-\s]+/g, '_') : ''
  if (status === 'completed' || status === 'complete' || status === 'done' || status.startsWith('completed')) return 'completed'
  if (status === 'in_progress' || status === 'doing' || status === 'active' || status.startsWith('in_progress')) return 'in_progress'
  if (
    status === 'stopped' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'canceled' ||
    status === 'cancelled' ||
    status.startsWith('stopped') ||
    status.startsWith('failed') ||
    status.startsWith('blocked') ||
    status.startsWith('canceled') ||
    status.startsWith('cancelled')
  ) {
    return 'stopped'
  }
  return 'pending'
}

function todoWriteInputFromItems(items: unknown): JsonRecord | null {
  if (!Array.isArray(items)) return null
  const todos = items
    .map((raw): JsonRecord | null => {
      if (!isRecord(raw)) return null
      const content =
        typeof raw.content === 'string'
          ? raw.content
          : typeof raw.label === 'string'
            ? raw.label
            : typeof raw.description === 'string'
              ? raw.description
              : typeof raw.text === 'string'
                ? raw.text
                : ''
      if (!content) return null
      return { content, status: raw.completed === true ? 'completed' : normalizeTodoStatus(raw.status) }
    })
    .filter((todo): todo is JsonRecord => todo !== null)
  return todos.length > 0 ? { todos } : null
}

function emitCodexTodoList(
  item: JsonRecord,
  emit: (event: AgentRuntimeEvent) => void,
  state: { codexToolUses: Set<string> }
): boolean {
  if (item.type !== 'todo_list' || typeof item.id !== 'string') return false
  const input = todoWriteInputFromItems(item.items)
  if (!input) return false
  if (!state.codexToolUses.has(item.id)) {
    state.codexToolUses.add(item.id)
    emit({ kind: 'tool_call', id: item.id, tool: 'TodoWrite', input })
  }
  return true
}

function emitCodexMcpToolCall(
  item: JsonRecord,
  emit: (event: AgentRuntimeEvent) => void,
  state: { codexToolUses: Set<string> }
): boolean {
  if (item.type !== 'mcp_tool_call' || typeof item.id !== 'string') return false
  const server = typeof item.server === 'string' ? item.server : ''
  const tool = typeof item.tool === 'string' ? item.tool : ''
  if (!server || !tool) return false
  const toolName = `mcp__${server}__${tool}`
  if (!state.codexToolUses.has(item.id)) {
    state.codexToolUses.add(item.id)
    emit({
      kind: 'tool_call',
      id: item.id,
      tool: toolName,
      input: item.arguments,
      mcpServer: server
    })
  }
  if (item.status === 'completed' || item.status === 'failed') {
    emit({
      kind: 'tool_result',
      id: item.id,
      output: item.error ?? item.result,
      isError: item.status === 'failed' || !!item.error
    })
  }
  return true
}

function parseCodexObject(obj: JsonRecord, emit: (event: AgentRuntimeEvent) => void, state: { codexToolUses: Set<string> }): boolean {
  if (obj.type === 'thread.started') {
    emit({
      kind: 'session_started',
      runtimeProvider: 'codex_cli',
      externalSessionId: typeof obj.thread_id === 'string' ? obj.thread_id : undefined
    })
    return true
  }
  if ((obj.type === 'item.started' || obj.type === 'item.updated') && isRecord(obj.item)) {
    if (emitCodexTodoList(obj.item, emit, state)) return true
    if (emitCodexMcpToolCall(obj.item, emit, state)) return true
  }
  if (obj.type === 'item.started' && isRecord(obj.item) && obj.item.type === 'command_execution' && typeof obj.item.id === 'string') {
    state.codexToolUses.add(obj.item.id)
    emit({
      kind: 'tool_call',
      id: obj.item.id,
      tool: 'Bash',
      input: { command: typeof obj.item.command === 'string' ? obj.item.command : '' }
    })
    return true
  }
  if (obj.type === 'item.completed' && isRecord(obj.item)) {
    if (emitCodexTodoList(obj.item, emit, state)) return true
    if (emitCodexMcpToolCall(obj.item, emit, state)) return true
    if (obj.item.type === 'command_execution' && typeof obj.item.id === 'string') {
      if (!state.codexToolUses.has(obj.item.id)) {
        state.codexToolUses.add(obj.item.id)
        emit({
          kind: 'tool_call',
          id: obj.item.id,
          tool: 'Bash',
          input: { command: typeof obj.item.command === 'string' ? obj.item.command : '' }
        })
      }
      emit({
        kind: 'tool_result',
        id: obj.item.id,
        output: stringify(obj.item.aggregated_output),
        isError: typeof obj.item.exit_code === 'number' ? obj.item.exit_code !== 0 : obj.item.status === 'failed'
      })
      return true
    }
    if (obj.item.type === 'agent_message' && typeof obj.item.text === 'string' && obj.item.text.length > 0) {
      emit({ kind: 'text_delta', delta: obj.item.text })
      return true
    }
  }
  if (obj.type === 'turn.completed') {
    emit({ kind: 'usage', usage: obj.usage ?? null, stopReason: typeof obj.reason === 'string' ? obj.reason : undefined })
    return true
  }
  if (obj.type === 'turn.failed' || obj.type === 'error') {
    emit({ kind: 'done', exitCode: 1, stopReason: errorMessageFrom(obj.error ?? obj.message, 'Codex run failed') })
    return true
  }
  return false
}

function parseQoderToolBlock(block: JsonRecord, emit: (event: AgentRuntimeEvent) => void): boolean {
  if (block.type === 'tool_use') {
    const id = typeof block.id === 'string' ? block.id : typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
    const tool =
      typeof block.name === 'string'
        ? block.name
        : typeof block.tool_name === 'string'
          ? block.tool_name
          : typeof block.tool === 'string'
            ? block.tool
            : undefined
    if (!tool) return false
    const parsedArgs = safeParseJson(block.arguments ?? block.parameters)
    emit({ kind: 'tool_call', id, tool, input: block.input ?? parsedArgs ?? block.arguments ?? block.parameters })
    return true
  }
  if (block.type === 'tool_result') {
    const id =
      typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : typeof block.id === 'string'
          ? block.id
          : typeof block.tool_call_id === 'string'
            ? block.tool_call_id
            : undefined
    emit({
      kind: 'tool_result',
      id,
      output: block.content ?? block.result ?? block.output,
      isError: block.is_error === true || block.status === 'error'
    })
    return true
  }
  return false
}

function parseQoderObject(obj: JsonRecord, rawLine: string, emit: (event: AgentRuntimeEvent) => void): boolean {
  if (obj.type === 'system' && obj.subtype === 'init') {
    emit({
      kind: 'session_started',
      runtimeProvider: 'qoder_cli',
      externalSessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      model: typeof obj.model === 'string' ? obj.model : undefined,
      mcpServers: parseRuntimeMcpServers(obj.mcp_servers)
    })
    return true
  }
  if (obj.type === 'assistant' && isRecord(obj.message)) {
    const content = Array.isArray(obj.message.content) ? obj.message.content : []
    let emittedText = false
    for (const block of content) {
      const text = textFromQoderBlock(block)
      if (text) {
        emittedText = true
        emit({ kind: 'text_delta', delta: text })
      }
      else if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string') {
        emit({ kind: 'thinking_delta', delta: block.thinking })
      } else if (isRecord(block)) {
        parseQoderToolBlock(block, emit)
      }
    }
    if (typeof obj.message.content === 'string') {
      emittedText = true
      emit({ kind: 'text_delta', delta: obj.message.content })
    }
    if (obj.error && !emittedText) {
      emit({ kind: 'done', exitCode: 1, stopReason: errorMessageFrom(obj.error, 'Qoder assistant error') })
    } else if (obj.error) emit({ kind: 'raw', line: rawLine })
    return true
  }
  if (obj.type === 'result') {
    const resultError = errorMessageFrom(obj.error ?? obj.message, typeof obj.stop_reason === 'string' ? obj.stop_reason : 'Qoder run failed')
    emit({
      kind: 'usage',
      usage: obj.usage ?? null,
      modelUsage: obj.modelUsage,
      costUsd: asNumber(obj.total_cost_usd) ?? null,
      durationMs: asNumber(obj.duration_ms),
      stopReason: obj.is_error === true ? resultError : typeof obj.stop_reason === 'string' ? obj.stop_reason : undefined,
      isError: obj.is_error === true
    })
    emit({ kind: 'done', exitCode: obj.is_error === true ? 1 : 0, stopReason: obj.is_error === true ? resultError : typeof obj.stop_reason === 'string' ? obj.stop_reason : undefined })
    return true
  }
  return false
}

function createRuntimeParser(runtimeProvider: CliRuntimeOpts['runtimeProvider'], emit: (event: AgentRuntimeEvent) => void) {
  let buffer = ''
  const state = { codexToolUses: new Set<string>() }
  const handleLine = (line: string): boolean => {
    try {
      const obj = JSON.parse(line) as unknown
      if (!isRecord(obj)) return false
      if (runtimeProvider === 'codex_cli') return parseCodexObject(obj, emit, state)
      return parseQoderObject(obj, line, emit)
    } catch {
      emit({ kind: 'raw', line })
      return false
    }
  }
  return {
    feed(chunk: Buffer | string): void {
      buffer += chunk.toString()
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) handleLine(line)
      }
    },
    flush(): void {
      const line = buffer.trim()
      buffer = ''
      if (line) handleLine(line)
    }
  }
}

function modelUsageRows(input: unknown): ModelUsageRow[] | undefined {
  if (!input) return undefined
  const rows: ModelUsageRow[] = []
  const push = (model: string, usage: unknown): void => {
    rows.push({
      model,
      inputTokens: numberAt(usage, ['inputTokens', 'input_tokens']),
      outputTokens: numberAt(usage, ['outputTokens', 'output_tokens']),
      cacheReadTokens: numberAt(usage, ['cacheReadInputTokens', 'cacheReadTokens', 'cache_read_input_tokens', 'cached_read_tokens']),
      cacheCreationTokens: numberAt(usage, [
        'cacheCreationInputTokens',
        'cacheCreationTokens',
        'cache_write_tokens',
        'cached_write_tokens',
        'cacheWriteTokens',
        'cache_creation_input_tokens'
      ]),
      reasoningTokens: numberAt(usage, ['reasoningTokens', 'reasoning_tokens', 'output_reasoning_tokens', 'reasoning_output_tokens', 'thought_tokens']),
      costUsd: numberAt(usage, ['costUSD', 'costUsd', 'cost_usd']),
      contextWindow: numberAt(usage, ['contextWindow', 'context_window'])
    })
  }
  if (Array.isArray(input)) {
    input.forEach((item, index) => push(isRecord(item) && typeof item.model === 'string' ? item.model : `model-${index}`, item))
  } else if (isRecord(input)) {
    for (const [model, usage] of Object.entries(input)) push(model, usage)
  }
  return rows.length > 0 ? rows : undefined
}

function traceFromRuntimeEvent(
  event: AgentRuntimeEvent,
  runId: string,
  runtimeProvider: RuntimeProvider
): TraceEvent | null {
  if (event.kind === 'text_delta') return { id: newId(), ts: now(), runId, kind: 'model', stage: 'text_delta', text: event.delta, runtimeProvider }
  if (event.kind === 'thinking_delta') return { id: newId(), ts: now(), runId, kind: 'model', stage: 'thinking', thinking: event.delta, runtimeProvider }
  if (event.kind === 'raw') {
    return { id: newId(), ts: now(), runId, kind: 'harness', stage: 'runtime:raw', text: event.line.slice(0, 2000), runtimeProvider }
  }
  if (event.kind === 'session_started') {
    return {
      id: newId(),
      ts: now(),
      runId,
      kind: 'harness',
      stage: 'runtime:init',
      text: event.externalSessionId,
      runtimeProvider,
      runtimeMetadata: { externalSessionId: event.externalSessionId, model: event.model, mcpServers: event.mcpServers ?? null }
    }
  }
  if (event.kind === 'tool_call') {
    const input = isRecord(event.input) ? event.input : event.input == null ? undefined : { value: event.input }
    const cls = classifyTool(event.tool, input)
    const parsedMcp = parseMcp(event.tool, input)
    const mcp = event.mcpServer ? { ...parsedMcp, isMcp: true, mcpServer: event.mcpServer, mcpTool: event.tool } : parsedMcp
    const fileOp = fileOpOf(event.tool, input)
    return {
      id: newId(),
      ts: now(),
      runId,
      kind: cls.kind,
      stage: `${cls.kind}:${cls.name}`,
      tool: event.tool,
      name: cls.name,
      toolUseId: event.id,
      input,
      runtimeProvider,
      ...mcp,
      ...fileOp
    }
  }
  if (event.kind === 'tool_result') {
    return {
      id: newId(),
      ts: now(),
      runId,
      kind: 'tool',
      stage: 'tool_result',
      toolUseId: event.id,
      text: stringify(event.output),
      output: stringify(event.output),
      isError: event.isError,
      runtimeProvider
    }
  }
  if (event.kind === 'file_op') {
    return {
      id: newId(),
      ts: now(),
      runId,
      kind: 'tool',
      stage: `file:${event.op}`,
      tool: 'FileOp',
      name: event.op,
      fileOp: event.op,
      filePath: event.path,
      runtimeProvider,
      runtimeMetadata: { confidence: event.confidence }
    }
  }
  return null
}

function capabilityWarningsFromObserved(
  runtimeProvider: RuntimeProvider,
  capabilityMetadata: Record<string, unknown> | undefined,
  observedMcpServers: RuntimeObservedMcpServer[] | undefined
): RuntimeCapabilityWarning[] {
  if (!observedMcpServers || observedMcpServers.length === 0) return []
  const configuredNames = new Set<string>()
  const mcpServers = isRecord(capabilityMetadata) && Array.isArray(capabilityMetadata.mcpServers) ? capabilityMetadata.mcpServers : []
  for (const item of mcpServers) {
    if (!isRecord(item) || item.injected === false) continue
    const name = typeof item.name === 'string' ? item.name : typeof item.id === 'string' ? item.id : ''
    if (name) configuredNames.add(name)
  }
  return observedMcpServers
    .filter((server) => server.status.toLowerCase() !== 'connected')
    .filter((server) => configuredNames.size === 0 || configuredNames.has(server.name))
    .map((server) => ({
      kind: 'mcp',
      runtimeProvider,
      name: server.name,
      reason:
        server.status.toLowerCase() === 'disconnected'
          ? 'runtime reported MCP server disconnected'
          : 'runtime reported MCP server not connected',
      expected: 'connected',
      observed: server.status,
      evidence: 'runtime:init.mcp_servers'
    }))
}

function resultTraceFromUsage(
  runId: string,
  runtimeProvider: RuntimeProvider,
  usage: UsageSnapshot | undefined,
  isError: boolean,
  capabilityMetadata?: Record<string, unknown>,
  samplePath?: string,
  failureBrief?: RuntimeFailureBrief,
  observedMcpServers?: RuntimeObservedMcpServer[]
): TraceEvent {
  const modelUsage = modelUsageRows(usage?.modelUsage)
  const rawUsage = usage?.usage
  const capabilityWarnings = capabilityWarningsFromObserved(runtimeProvider, capabilityMetadata, observedMcpServers)
  return {
    id: newId(),
    ts: now(),
    runId,
    kind: 'harness',
    stage: 'result',
    text: usage?.stopReason,
    costUsd: usage?.costUsd ?? modelUsage?.find((row) => row.costUsd != null)?.costUsd,
    costSource: usage?.costUsd != null || modelUsage?.some((row) => row.costUsd != null) ? 'provider_reported' : undefined,
    costConfidence: usage?.costUsd != null || modelUsage?.some((row) => row.costUsd != null) ? 'provider_reported' : undefined,
    costUnit: usage?.costUsd != null || modelUsage?.some((row) => row.costUsd != null) ? 'usd' : undefined,
    tokensIn: numberAt(rawUsage, ['input_tokens', 'inputTokens']),
    tokensOut: numberAt(rawUsage, ['output_tokens', 'outputTokens']),
    cacheReadTokens: numberAt(rawUsage, ['cached_input_tokens', 'cache_read_input_tokens', 'cacheReadTokens', 'cached_read_tokens']),
    cacheCreationTokens: numberAt(rawUsage, [
      'cache_creation_input_tokens',
      'cacheWriteTokens',
      'cache_write_tokens',
      'cached_write_tokens',
      'cacheCreationTokens'
    ]),
    reasoningTokens: numberAt(rawUsage, ['reasoning_tokens', 'output_reasoning_tokens', 'reasoning_output_tokens', 'thought_tokens']),
    durationMs: usage?.durationMs,
    modelUsage,
    isError: isError || usage?.isError === true,
    runtimeProvider,
    runtimeFailureStage: failureBrief?.stage,
    runtimeMetadata: {
      usage: rawUsage ?? null,
      stopReason: usage?.stopReason ?? null,
      capabilities: capabilityMetadata ?? null,
      observedMcpServers: observedMcpServers ?? null,
      capabilityWarnings,
      samplePath: samplePath ?? null,
      brief: failureBrief ?? null
    }
  }
}

export function runCliAgent(prompt: string, runId: string, emit: EmitFn, opts: CliRuntimeOpts): RunHandle {
  const args = buildCliArgs(opts)
  const summary = commandSummary(opts.executablePath, args)
  let stopped = false
  let sessionId: string | undefined
  let lastUsage: UsageSnapshot | undefined
  let structuredEvents = 0
  let rawEvents = 0
  let emittedResult = false
  let observedMcpServers: RuntimeObservedMcpServer[] | undefined
  let child: ReturnType<typeof spawn> | null = null
  let sample: RuntimeSampleRecorder | null = null
  const startedAt = Date.now()

  const emitResult = (isError: boolean, failureBrief?: RuntimeFailureBrief): void => {
    if (emittedResult) return
    emittedResult = true
    emit(resultTraceFromUsage(runId, opts.runtimeProvider, lastUsage, isError, opts.capabilityMetadata, sample?.path, failureBrief, observedMcpServers))
  }

  const parser = createRuntimeParser(opts.runtimeProvider, (event) => {
    if (event.kind === 'raw') rawEvents += 1
    else structuredEvents += 1
    if (event.kind === 'session_started') {
      if (event.externalSessionId && sessionId !== event.externalSessionId) {
        sessionId = event.externalSessionId
        opts.onSessionId?.(event.externalSessionId)
      }
      if (event.mcpServers) observedMcpServers = event.mcpServers
    }
    if (event.kind === 'usage') lastUsage = event
    if (event.kind === 'done' && event.exitCode && event.exitCode !== 0) {
      lastUsage = { ...lastUsage, stopReason: event.stopReason, isError: true }
    }
    const trace = traceFromRuntimeEvent(event, runId, opts.runtimeProvider)
    if (trace) emit(trace)
  })

  const promise = new Promise<{ sessionId?: string; stopped?: boolean; mcpStatus?: McpLiveStatus[] }>((resolve, reject) => {
    let stderr = ''
    let settled = false
    const finish = (fn: () => void, exit?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      if (exit) sample?.writeExit(exit)
      fn()
    }
    const timer = opts.timeoutMs ? setTimeout(() => {
      stopped = true
      try {
        child?.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      lastUsage = { ...lastUsage, stopReason: `${opts.runtimeProvider} timed out`, isError: true }
      const runtimeErr = errorFor(opts, 'runtime', `${opts.runtimeProvider} timed out`, {
        commandSummary: summary,
        evidencePath: sample?.path,
        timeoutMs: opts.timeoutMs
      })
      emitResult(true, runtimeErr.brief)
      finish(
        () =>
          reject(runtimeErr),
        {
          exitCode: null,
          signal: 'SIGTERM',
          stopped: true,
          durationMs: Date.now() - startedAt,
          structuredEvents,
          rawEvents,
          error: `${opts.runtimeProvider} timed out`
        }
      )
    }, opts.timeoutMs) : null

    try {
      sample = createSampleRecorder(runId, opts, args)
      if (opts.capabilityMetadata) {
        emit({
          id: newId(),
          ts: now(),
          runId,
          kind: 'harness',
          stage: 'runtime:capabilities',
          runtimeProvider: opts.runtimeProvider,
          runtimeMetadata: opts.capabilityMetadata
        })
      }
      child = spawn(opts.executablePath, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      if (timer) clearTimeout(timer)
      finish(
        () =>
          reject(
            errorFor(opts, 'spawn', String((err as Error).message), {
              commandSummary: summary,
              evidencePath: sample?.path
            })
          ),
        {
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          structuredEvents,
          rawEvents,
          error: String((err as Error).message)
        }
      )
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      sample?.appendStdout(chunk)
      parser.feed(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      sample?.appendStderr(chunk)
      stderr += chunk.toString()
    })
    child.on('error', (err: Error) => {
      if (timer) clearTimeout(timer)
      emitResult(true)
      finish(
        () =>
          reject(
            errorFor(opts, 'spawn', err.message, {
              commandSummary: summary,
              evidencePath: sample?.path
            })
          ),
        {
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          structuredEvents,
          rawEvents,
          error: err.message
        }
      )
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer)
      parser.flush()
      const failed = !!code || !!signal || lastUsage?.isError === true
      const exit = {
        exitCode: code,
        signal,
        stopped,
        durationMs: Date.now() - startedAt,
        structuredEvents,
        rawEvents,
        stderrTail: stderr.slice(-4000)
      }
      if (!failed && structuredEvents === 0 && rawEvents > 0) {
        finish(
          () =>
            reject(
              errorFor(opts, 'parser', `${opts.runtimeProvider} emitted only raw output`, {
                commandSummary: summary,
                evidencePath: sample?.path,
                exitCode: code,
                signal
              })
            ),
          exit
        )
        return
      }
      if (!failed && structuredEvents === 0 && rawEvents === 0) {
        finish(
          () =>
            reject(
              errorFor(opts, 'protocol', `${opts.runtimeProvider} produced no structured output`, {
                commandSummary: summary,
                evidencePath: sample?.path,
                exitCode: code,
                signal
              })
            ),
          exit
        )
        return
      }
      if (failed && stopped) {
        const message = lastUsage?.stopReason || `${opts.runtimeProvider} stopped`
        lastUsage = { ...lastUsage, stopReason: message, isError: true }
        const runtimeErr = errorFor(opts, 'runtime', message, {
          commandSummary: summary,
          evidencePath: sample?.path,
          exitCode: code,
          signal
        })
        emitResult(true, runtimeErr.brief)
        finish(() => resolve({ sessionId, stopped, mcpStatus: runtimeMcpLiveStatus(observedMcpServers) }), exit)
        return
      }
      emitResult(failed)
      if (failed && !stopped) {
        finish(
          () =>
            reject(
              errorFor(opts, 'runtime', stderr.trim() || lastUsage?.stopReason || `${opts.runtimeProvider} exited with ${code ?? signal}`, {
                commandSummary: summary,
                evidencePath: sample?.path,
                exitCode: code,
                signal
              })
            ),
          exit
        )
        return
      }
      finish(() => resolve({ sessionId, stopped, mcpStatus: runtimeMcpLiveStatus(observedMcpServers) }), exit)
    })
    child.stdin?.end([opts.promptPrefix, prompt].filter(Boolean).join('\n\n'))
  })

  return {
    promise,
    interrupt: () => {
      stopped = true
      try {
        child?.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    },
    getSessionId: () => sessionId
  }
}

export function captureCliMcpStatus(opts: CliRuntimeOpts): Promise<McpLiveStatus[]> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | null = null
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (status: McpLiveStatus[]): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        child?.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      resolve(status)
    }
    const parser = createRuntimeParser(opts.runtimeProvider, (event) => {
      if (event.kind === 'session_started') finish(runtimeMcpLiveStatus(event.mcpServers) ?? [])
    })
    timer = setTimeout(() => finish([]), Math.min(opts.timeoutMs ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS))
    try {
      child = spawn(opts.executablePath, buildCliArgs(opts), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      finish([])
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => parser.feed(chunk))
    child.on('error', () => finish([]))
    child.on('close', () => {
      parser.flush()
      finish([])
    })
    child.stdin?.end('Scry MCP status probe. Do not perform project work. Reply OK only.\n')
  })
}

export function runtimeFailureTrace(runId: string, err: AgentRuntimeError): TraceEvent {
  return {
    id: newId(),
    ts: now(),
    runId,
    kind: 'harness',
    stage: 'result',
    text: err.message,
    isError: true,
    runtimeProvider: err.brief.provider,
    runtimeFailureStage: err.brief.stage,
    runtimeMetadata: { brief: err.brief }
  }
}
