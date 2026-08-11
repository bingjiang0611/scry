import { qodercliAuth, query, type AccountInfo, type McpServerStatus, type PermissionUpdate, type Query, type SlashCommand, type UsageInfo } from '@qoder-ai/qoder-agent-sdk'
import { spawn } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { capabilityReady, capabilityUnknown, type AccountSnapshot, type McpSnapshot, type ProviderContext, type SkillMeta } from '../../shared/provider'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  exactSessionPermissionDescription,
  exactSessionPermissionSuggestions,
  normalizeAgentQuestionRequest,
  type AgentPermissionMode,
  type AgentRunControlCatalog
} from '../../shared/runtime'
import type { McpLiveStatus, TraceEvent } from '../../shared/trace'
import { resolveRuntimeCliBin, runtimeCliEnv, shellEnv } from '../claude-locate'
import { authorizedMcpServers, isRemoteMcpConfig, listProviderMcp } from '../mcp-config'
import { normalizeSdkMessage, type NormalizeCtx } from '../normalize'
import type { AuthorizedMcpExecution, McpAuthInteraction, ProviderAdapter, ProviderRunRequest, ProviderRunResult } from './types'
import { effortOption, permissionOptions } from './run-controls'
import { isSafeOAuthAuthorizationUrl } from '../oauth-loopback'
import { sanitizeMcpAuthError } from './mcp-auth-security'

interface Cached<T> {
  data: T
  observedAt: number
}

interface QoderControlSession {
  query: Query
  releasePrompt: () => void
  ready: ReturnType<Query['initializationResult']>
  active: number
  idleTimer?: NodeJS.Timeout
}

const PROBE_TTL_MS = 30_000
const CONTROL_READY_TIMEOUT_MS = 20_000
const CONTROL_READY_TIMEOUT_REASON = `Qoder 控制会话 ${CONTROL_READY_TIMEOUT_MS / 1000} 秒内未完成初始化`
const QODER_MCP_AUTH_TIMEOUT_MS = 120_000
const MAX_PROJECT_COMMAND_BYTES = 256 * 1024
let counter = 0
const newId = (): string => `qoder-${Date.now().toString(36)}-${(counter++).toString(36)}`

function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function qoderSkillScope(source: string): 'project' | 'user' | 'unknown' {
  const normalized = source.trim().toLowerCase()
  return normalized === 'project' || normalized === 'user' ? normalized : 'unknown'
}

function qoderAccountUsage(usage: UsageInfo | null): Omit<UsageInfo, 'session'> | undefined {
  if (!usage) return undefined
  const { session: _controlSession, ...accountUsage } = usage
  return Object.keys(accountUsage).length > 0 ? accountUsage : undefined
}

function firstNonBlank(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (normalized) return normalized
  }
  return undefined
}

function projectCommandMatch(prompt: string): RegExpMatchArray | null {
  return prompt.match(/^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:[ \t]+([\s\S]*))?$/)
}

function commandBody(source: string): string {
  const normalized = source.replace(/^\uFEFF/, '')
  const frontmatter = normalized.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  return normalized.slice(frontmatter?.[0].length ?? 0).trim()
}

function positionalArgs(source: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"' && index + 1 < source.length) {
        current += source[++index]
      } else {
        current += char
      }
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === '\\' && index + 1 < source.length) {
      current += source[++index]
      started = true
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

function applyCommandArgs(body: string, rawArgs: string): string {
  const args = positionalArgs(rawArgs)
  let replaced = false
  let expanded = body.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, rawIndex: string) => {
    replaced = true
    return args[Number(rawIndex)] ?? ''
  })
  expanded = expanded.replace(/\$(\d+)/g, (_match, rawIndex: string) => {
    replaced = true
    return args[Number(rawIndex)] ?? ''
  })
  expanded = expanded.replace(/\$ARGUMENTS/g, () => {
    replaced = true
    return rawArgs
  })
  return rawArgs && !replaced ? `${expanded}\n\nARGUMENTS: ${rawArgs}` : expanded
}

export async function expandQoderProjectCommand(prompt: string, cwd?: string): Promise<string> {
  const match = cwd ? projectCommandMatch(prompt) : null
  if (!cwd || !match) return prompt

  const qoderDir = join(cwd, '.qoder')
  const commandsDir = join(qoderDir, 'commands')
  const commandPath = join(commandsDir, `${match[1]}.md`)
  let qoderStat
  let commandsStat
  let commandStat
  try {
    [qoderStat, commandsStat, commandStat] = await Promise.all([
      lstat(qoderDir),
      lstat(commandsDir),
      lstat(commandPath)
    ])
  } catch (error) {
    if (missingFile(error)) return prompt
    throw error
  }
  if (qoderStat.isSymbolicLink() || !qoderStat.isDirectory() ||
      commandsStat.isSymbolicLink() || !commandsStat.isDirectory() ||
      commandStat.isSymbolicLink() || !commandStat.isFile()) {
    throw new Error(`Qoder 项目命令不是安全的常规文件：${commandPath}`)
  }
  if (commandStat.size > MAX_PROJECT_COMMAND_BYTES) {
    throw new Error(`Qoder 项目命令超过 ${MAX_PROJECT_COMMAND_BYTES} 字节：${commandPath}`)
  }
  const body = commandBody(await readFile(commandPath, 'utf8'))
  if (!body) throw new Error(`Qoder 项目命令内容为空：${commandPath}`)
  return applyCommandArgs(body, (match[2] ?? '').trim())
}

function heldPrompt(): { stream: AsyncIterable<never>; release: () => void } {
  let release = (): void => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    stream: (async function* (): AsyncIterable<never> {
      await wait
    })(),
    release
  }
}

function qoderOptions(
  cwd: string | undefined,
  resume?: string,
  onPid?: (pid: number) => void,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  permissionMode: AgentPermissionMode = 'default',
  managedRecorder = false,
  mcpExecution?: AuthorizedMcpExecution
): Record<string, unknown> {
  const executable = process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
  if (!executable) throw new Error('Qoder CLI 未找到')
  const permissions = permissionMode === 'full_access'
    ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
    : { permissionMode: permissionMode === 'auto_review' ? 'auto' : 'default' }
  return {
    auth: qodercliAuth(),
    cwd,
    resume,
    pathToQoderCLIExecutable: executable,
    env: {
      ...runtimeCliEnv(undefined, managedRecorder ? { managedRecorder: true } : {}),
      // Scry owns cancellation through the run's AbortController. Let Qoder wait for
      // background shell tasks instead of force-stopping them after ten minutes.
      QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0'
    },
    ...permissions,
    includePartialMessages: true,
    includeHookEvents: true,
    settingSources: ['user', 'project', 'local'],
    // Qoder must never discover MCP implicitly. Scry injects only the exact
    // fingerprinted configs approved in the native authorization dialog.
    strictMcpConfig: true,
    mcpServers: authorizedMcpServers(mcpExecution),
    controlRequestTimeoutMs: 30_000,
    ...(onPid
      ? {
          spawnQoderCLIProcess: (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
            const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
            if (child.pid) onPid(child.pid)
            child.once('exit', (code, signal) => onExit?.(code, signal))
            options.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
            return child
          }
        }
      : {})
  }
}

function fields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const pattern = /(\w+)=("(?:\\.|[^"])*"|\S+)/g
  for (const match of text.matchAll(pattern)) {
    const raw = match[2]
    if (raw.startsWith('"')) {
      try { out[match[1]] = JSON.parse(raw) as string } catch { out[match[1]] = raw.slice(1, -1) }
    } else out[match[1]] = raw
  }
  return out
}

export function parseQoderHookLog(runId: string, text: string, sessionId?: string): TraceEvent[] {
  const events: TraceEvent[] = []
  const pending = new Map<string, Array<Record<string, string>>>()
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+\S+\s+(?:\[([^\]]+)\]\s+)?hook\.(started|finished)\s+(.+)$/)
    if (!match) continue
    const context = fields(match[2] ?? '')
    const detail = fields(match[4])
    if (sessionId && context.session !== sessionId) continue
    const hookName = detail.hook_name ?? 'hook'
    const hookEvent = detail.hook_event_name ?? 'Hook'
    const key = [context.session ?? '', context.tool ?? '', hookName, hookEvent].join('|')
    if (match[3] === 'started') {
      const queue = pending.get(key) ?? []
      queue.push(detail)
      pending.set(key, queue)
      const hookId = `qoder-log:${key}:${detail.source ?? 'unknown'}:${detail.hook_index ?? queue.length}`
      events.push({
        id: `${hookId}:start`, runId, ts: new Date(match[1]).toISOString(), kind: 'hook', stage: 'hook_started',
        tool: hookName, name: hookEvent, hookId, hookName, hookEvent, hookCommand: detail.display_text,
        hookOutcome: 'started', toolUseId: context.tool,
        input: { sessionId: context.session, turnId: context.turn, source: detail.source, hookIndex: detail.hook_index },
        runtimeMetadata: { source: 'qoder_cli_log', hookSource: detail.source, hookIndex: detail.hook_index }
      })
      continue
    }
    const started = pending.get(key)?.shift() ?? {}
    const hookId = `qoder-log:${key}:${started.source ?? 'unknown'}:${started.hook_index ?? 'unknown'}`
    const success = detail.success === 'true'
    const exitCode = detail.exit_code == null ? undefined : Number(detail.exit_code)
    events.push({
      id: `${hookId}:response`, runId, ts: new Date(match[1]).toISOString(), kind: 'hook', stage: 'hook_response',
      tool: hookName, name: hookEvent, hookId, hookName, hookEvent, hookCommand: started.display_text,
      hookOutcome: success ? 'success' : 'error', hookExitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      toolUseId: context.tool, durationMs: detail.duration_ms == null ? undefined : Number(detail.duration_ms), isError: !success,
      input: { sessionId: context.session, turnId: context.turn, source: started.source, hookIndex: started.hook_index },
      runtimeMetadata: { source: 'qoder_cli_log', hookSource: started.source, hookIndex: started.hook_index }
    })
  }
  return events
}

export function parseQoderBackgroundTaskFailures(runId: string, text: string, sessionId?: string): TraceEvent[] {
  const backgrounded = new Map<string, { command?: string; ts: string }>()
  const events: TraceEvent[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+\S+\s+(?:\[([^\]]+)\]\s+)?tool\.shell\.(backgrounded|finished)\s+(.+)$/)
    if (!match) continue
    const context = fields(match[2] ?? '')
    const detail = fields(match[4])
    if (sessionId && context.session !== sessionId) continue
    if (!detail.pid) continue
    if (match[3] === 'backgrounded') {
      backgrounded.set(detail.pid, { command: detail.command, ts: match[1] })
      continue
    }
    const started = backgrounded.get(detail.pid)
    if (!started) continue
    const exitCode = detail.exit_code == null ? undefined : Number(detail.exit_code)
    const failed = detail.aborted === 'true' || detail.signal != null || (Number.isFinite(exitCode) && exitCode !== 0)
    if (!failed) continue
    const reason = [
      Number.isFinite(exitCode) ? `exit ${exitCode}` : undefined,
      detail.signal ? `signal ${detail.signal}` : undefined
    ].filter(Boolean).join(' · ')
    const durationMs = new Date(match[1]).getTime() - new Date(started.ts).getTime()
    const output = `后台 Bash 任务异常结束${reason ? `（${reason}）` : ''}`
    events.push({
      id: `qoder-log:background:${detail.pid}:${context.tool ?? 'unknown'}:response`,
      runId,
      ts: new Date(match[1]).toISOString(),
      kind: 'tool',
      stage: 'tool_result',
      tool: 'Bash',
      toolUseId: context.tool,
      input: started.command ? { command: started.command } : undefined,
      text: output,
      output,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
      isError: true,
      runtimeMetadata: {
        source: 'qoder_cli_log',
        backgroundTask: true,
        pid: Number(detail.pid),
        exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
        signal: detail.signal,
        aborted: detail.aborted === 'true'
      }
    })
  }
  return events
}

function hookFingerprint(event: TraceEvent): string {
  const source = event.runtimeMetadata?.source
  const command = event.hookCommand ?? (source === 'qoder_sdk' ? event.hookName : undefined)
  return [event.stage, event.hookEvent, command, event.toolUseId, event.hookOutcome].join('|')
}

export function qoderHookFallbackOnly(sdkHooks: TraceEvent[], fallback: TraceEvent[]): TraceEvent[] {
  const sdkCounts = new Map<string, number>()
  for (const event of sdkHooks) sdkCounts.set(hookFingerprint(event), (sdkCounts.get(hookFingerprint(event)) ?? 0) + 1)
  return fallback.filter((event) => {
    const key = hookFingerprint(event)
    const remaining = sdkCounts.get(key) ?? 0
    if (remaining === 0) return true
    sdkCounts.set(key, remaining - 1)
    return false
  })
}

function qoderProviderTurnId(message: Record<string, unknown>): string | undefined {
  for (const key of ['promptId', 'prompt_id']) {
    if (typeof message[key] === 'string' && message[key]) return message[key]
  }
  return undefined
}

function uniqueId(ids: Set<string>): string | undefined {
  return ids.size === 1 ? [...ids][0] : undefined
}

export function qoderProviderTurnIdFromLog(text: string, sessionId?: string): string | undefined {
  const sdkPromptIds = new Set<string>()
  const rootTurnIds = new Set<string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^\S+\s+\S+\s+\[([^\]]+)\]\s+(input\.prompt\.received|input\.prompt\.submitted|turn\.started)\s+(.+)$/)
    if (!match) continue
    const context = fields(match[1])
    const detail = fields(match[3])
    if (sessionId && context.session !== sessionId) continue
    if (!context.turn || context.turn === context.session) continue
    if (match[2] === 'input.prompt.received' && detail.query_source === 'sdk') {
      sdkPromptIds.add(context.turn)
    } else if (detail.is_subagent === 'false') {
      rootTurnIds.add(context.turn)
    }
  }
  return sdkPromptIds.size > 0 ? uniqueId(sdkPromptIds) : uniqueId(rootTurnIds)
}

async function qoderHookLog(pid: number): Promise<string> {
  const configDir = process.env.QODER_CONFIG_DIR ?? join(process.env.QODER_CLI_HOME ?? homedir(), '.qoder')
  const root = join(configDir, 'logs', 'runs')
  const entries = await readdir(root, { withFileTypes: true })
  const match = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(`-p${pid}`)).map((entry) => entry.name).sort().at(-1)
  if (!match) throw new Error(`Qoder log for pid ${pid} not found`)
  return readFile(join(root, match, 'qodercli.log'), 'utf8')
}

function qoderAuthenticationTargets(configured: McpSnapshot['configured']): string[] {
  const enabledNames = new Map<string, number>()
  for (const item of configured) {
    if (item.enabled) enabledNames.set(item.name, (enabledNames.get(item.name) ?? 0) + 1)
  }
  return configured
    .filter((item) => item.enabled && enabledNames.get(item.name) === 1 && item.transport === 'http' && item.targetId)
    .map((item) => item.targetId!)
}

function qoderMcpSnapshot(statuses: McpServerStatus[], configured?: McpSnapshot['configured']): McpSnapshot {
  const runtime: McpLiveStatus[] = statuses.map((server) => ({
    name: server.name,
    status: server.status,
    serverName: server.serverInfo?.name,
    serverVersion: server.serverInfo?.version,
    tools: server.tools?.length
  }))
  const snapshotConfigured: McpSnapshot['configured'] = configured ?? statuses.map((server) => {
    const config = server.config
    const transport = config && 'type' in config ? config.type ?? 'stdio' : 'stdio'
    const detail = config && 'url' in config ? config.url : config && 'command' in config ? config.command : server.error ?? server.status
    return { name: server.name, scope: server.scope ?? 'qoder', transport, detail, enabled: server.status !== 'disabled' }
  })
  return {
    configured: snapshotConfigured,
    runtime,
    operations: {
      authenticate: qoderAuthenticationTargets(snapshotConfigured)
    }
  }
}

function qoderTrace(event: TraceEvent): TraceEvent {
  if (event.kind === 'hook') {
    return {
      ...event,
      hookCommand: event.hookCommand ?? event.hookName,
      runtimeMetadata: { ...(event.runtimeMetadata ?? {}), source: 'qoder_sdk' }
    }
  }
  if (event.kind !== 'harness' || event.stage !== 'result') return event
  const reportedTokens = [event.tokensIn, event.tokensOut, event.cacheReadTokens, event.cacheCreationTokens, event.reasoningTokens]
  const reportedZeroUsage = reportedTokens.some((value) => value != null) && reportedTokens.every((value) => value == null || value === 0)
  return {
    ...event,
    tokensIn: reportedZeroUsage ? undefined : event.tokensIn,
    tokensOut: reportedZeroUsage ? undefined : event.tokensOut,
    cacheReadTokens: reportedZeroUsage ? undefined : event.cacheReadTokens,
    cacheCreationTokens: reportedZeroUsage ? undefined : event.cacheCreationTokens,
    reasoningTokens: reportedZeroUsage ? undefined : event.reasoningTokens,
    costUsd: undefined,
    costSource: undefined,
    costConfidence: undefined,
    costUnit: undefined,
    modelUsage: event.modelUsage?.map((usage) => {
      const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.reasoningTokens]
      const zero = values.some((value) => value != null) && values.every((value) => value == null || value === 0)
      return {
        ...usage,
        inputTokens: zero ? undefined : usage.inputTokens,
        outputTokens: zero ? undefined : usage.outputTokens,
        cacheReadTokens: zero ? undefined : usage.cacheReadTokens,
        cacheCreationTokens: zero ? undefined : usage.cacheCreationTokens,
        reasoningTokens: zero ? undefined : usage.reasoningTokens,
        costUsd: undefined,
        costSource: undefined,
        costConfidence: undefined,
        costUnit: undefined,
        billingProvider: 'qoder',
        upstreamProvider: 'qoder',
        usageSource: 'qoder_sdk'
      }
    }),
    runtimeMetadata: { ...(event.runtimeMetadata ?? {}), source: 'qoder_sdk', billingProvider: 'qoder', reportedZeroUsage },
    billingProvider: 'qoder',
    upstreamProvider: 'qoder',
    usageSource: 'qoder_sdk'
  }
}

export function createQoderAdapter(homeDir = homedir()): ProviderAdapter {
  const controls = new Map<string, QoderControlSession>()
  const skillCache = new Map<string, Cached<{ data: SkillMeta[]; total: number; included: number }>>()
  const commandCache = new Map<string, Cached<{ commands: SlashCommand[]; skillNames?: Set<string>; reason?: string }>>()
  const modelCache = new Map<string, Cached<AgentRunControlCatalog>>()
  const accountCache = new Map<string, Cached<{ usage: UsageInfo | null; account: AccountInfo }>>()
  let lastHookFallbackError: string | undefined
  let hookFallbackObserved = false

  const closeControl = (key: string, session: QoderControlSession): void => {
    if (controls.get(key) !== session) return
    controls.delete(key)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.releasePrompt()
    void Promise.resolve(session.query.close()).catch(() => {})
  }

  const controlFor = (context: ProviderContext): [string, QoderControlSession] => {
    const key = context.cwd ?? ''
    const existing = controls.get(key)
    if (existing) return [key, existing]
    const prompt = heldPrompt()
    const q = query({ prompt: prompt.stream, options: qoderOptions(context.cwd) as never })
    const session: QoderControlSession = {
      query: q,
      releasePrompt: prompt.release,
      ready: q.initializationResult(),
      active: 0
    }
    controls.set(key, session)
    return [key, session]
  }

  const withControl = async <T>(
    context: ProviderContext,
    read: (q: Query, initialized: Awaited<ReturnType<Query['initializationResult']>>) => Promise<T>
  ): Promise<T> => {
    const [key, session] = controlFor(context)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.active++
    try {
      const initialized = await Promise.race([
        session.ready,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(CONTROL_READY_TIMEOUT_REASON)), CONTROL_READY_TIMEOUT_MS)
          void session.ready.catch(() => {}).finally(() => clearTimeout(timer))
        })
      ])
      return await read(session.query, initialized)
    } catch (error) {
      const message = String((error as Error).message)
      // 初始化没完成的会话不会自愈：留在 controls 里会让后续读取一直 await 同一个死 promise。
      if (message === CONTROL_READY_TIMEOUT_REASON || /transport|closed|process|broken pipe/i.test(message)) {
        closeControl(key, session)
      }
      throw error
    } finally {
      session.active--
      if (controls.get(key) === session && session.active === 0) {
        session.idleTimer = setTimeout(() => closeControl(key, session), 5_000)
      }
    }
  }

  return {
    id: 'qoder',
    runtimeProvider: 'qoder_cli',
    describe: async () => {
      const path = process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
      return {
        id: 'qoder',
        label: 'Qoder',
        runtimeProvider: 'qoder_cli',
        transport: 'Qoder Agent SDK',
        available: !!path,
        path,
        capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'read' },
        health: lastHookFallbackError
          ? { state: 'degraded', transport: 'Qoder Agent SDK', lastError: lastHookFallbackError }
          : { state: !path ? 'unavailable' : hookFallbackObserved ? 'ready' : 'unknown', transport: 'Qoder Agent SDK' }
      }
    },
    run: (request: ProviderRunRequest) => {
      if (/^\/plugins\s+reload\s*$/i.test(request.prompt)) {
        const controller = new AbortController()
        const prompt = heldPrompt()
        let stopped = false
        let externalSessionId = request.resume
        let q: Query | undefined
        const ctx: NormalizeCtx = { runId: request.runId, cwd: request.cwd, newId, now: () => new Date().toISOString() }
        const promise: Promise<ProviderRunResult> = (async () => {
          q = query({
            prompt: prompt.stream,
            options: {
              ...qoderOptions(
                request.cwd,
                request.resume,
                undefined,
                undefined,
                request.permissionMode,
                request.managedRecorder === true,
                request.mcpExecution
              ),
              abortController: controller
            } as never
          })
          const events = (async () => {
            for await (const message of q!) {
              const raw = message as unknown as Record<string, unknown>
              if (typeof raw.session_id === 'string' && raw.session_id !== externalSessionId) {
                externalSessionId = raw.session_id
                request.onExternalSessionId?.(raw.session_id)
              }
              for (const event of normalizeSdkMessage(message, ctx)) request.emit(qoderTrace(event))
            }
          })()
          let providerResult: ProviderRunResult
          try {
            const result = await q.reloadPlugins()
            commandCache.clear()
            skillCache.clear()
            const errorCount = Number(result.error_count ?? 0)
            const text = `插件已重载：${result.plugins.length} 个插件，${result.commands.length} 条命令${errorCount > 0 ? `，${errorCount} 个错误` : ''}`
            request.emit({
              id: newId(), runId: request.runId, ts: new Date().toISOString(),
              kind: 'model', stage: 'text', text,
              runtimeMetadata: { source: 'qoder_sdk_control', localCommand: '/plugins reload' }
            })
            request.emit(qoderTrace({
              id: newId(), runId: request.runId, ts: new Date().toISOString(),
              kind: 'harness', stage: 'result', text,
              isError: errorCount > 0,
              runtimeMetadata: { source: 'qoder_sdk_control', localCommand: '/plugins reload' }
            }))
            providerResult = {
              stopped,
              status: stopped ? 'interrupted' : errorCount > 0 ? 'failed' : 'completed',
              mcp: qoderMcpSnapshot(result.mcpServers)
            }
          } catch (error) {
            if (!stopped) throw error
            providerResult = { stopped: true, status: 'interrupted' }
          } finally {
            prompt.release()
            await q.close().catch(() => {})
            await events
          }
          return { ...providerResult, externalSessionId }
        })()
        return {
          promise,
          interrupt: () => {
            stopped = true
            controller.abort()
            void q?.interrupt().catch(() => {})
          },
          getExternalSessionId: () => externalSessionId,
          getProviderTurnId: () => undefined
        }
      }
      const controller = new AbortController()
      let stopped = false
      let externalSessionId = request.resume
      let providerTurnId: string | undefined
      let providerTurnIdAmbiguous = false
      let providerStatus: 'completed' | 'failed' = 'completed'
      const observeProviderTurnId = (value: string | undefined): void => {
        if (!value || providerTurnIdAmbiguous) return
        if (!providerTurnId) providerTurnId = value
        else if (providerTurnId !== value) providerTurnIdAmbiguous = true
      }
      const currentProviderTurnId = (): string | undefined => providerTurnIdAmbiguous ? undefined : providerTurnId
      let q: Query | undefined
      let qoderPid: number | undefined
      let streamSettled = false
      let exitTimer: ReturnType<typeof setTimeout> | undefined
      let rejectUnexpectedExit: (error: Error) => void = () => {}
      const unexpectedExit = new Promise<never>((_resolve, reject) => {
        rejectUnexpectedExit = reject
      })
      let providerFailureSeen = false
      let streamedText = ''
      const sdkHooks: TraceEvent[] = []
      const ctx: NormalizeCtx = { runId: request.runId, cwd: request.cwd, newId, now: () => new Date().toISOString() }
      const promise: Promise<ProviderRunResult> = (async () => {
        const providerPrompt = request.cwd && projectCommandMatch(request.prompt)
          ? await expandQoderProjectCommand(request.prompt, request.cwd)
          : request.prompt
        q = query({
          prompt: providerPrompt,
          options: {
            ...qoderOptions(
              request.cwd,
              request.resume,
              (pid) => { qoderPid = pid },
              (code, signal) => {
                if (stopped || streamSettled) return
                exitTimer = setTimeout(() => {
                  rejectUnexpectedExit(new Error(`Qoder CLI 已退出，但 SDK 事件流未结束（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`))
                }, 1000)
              },
              request.permissionMode,
              request.managedRecorder === true,
              request.mcpExecution
            ),
            ...(request.model && !request.effort ? { model: request.model.id } : {}),
            ...(request.model && request.effort
              ? {
                  resolveModel: () => ({
                    model: request.model!.id,
                    parameters: { reasoningEffort: request.effort }
                  })
                }
              : {}),
            ...(request.requestUserInput
              ? {
                  canUseTool: async (
                    toolName: string,
                    input: Record<string, unknown>,
                    permission: {
                      signal: AbortSignal
                      toolUseID: string
                      agentID?: string
                      suggestions?: PermissionUpdate[]
                      title?: string
                      description?: string
                    }
                  ) => {
                    if (toolName === 'AskUserQuestion') {
                      const question = normalizeAgentQuestionRequest(
                        request.runId,
                        permission.toolUseID,
                        input,
                        permission.agentID,
                        'qoder:AskUserQuestion'
                      )
                      if (!question) {
                        return { behavior: 'deny' as const, message: 'Scry 收到的提问格式无效', interrupt: false }
                      }
                      const response = await request.requestUserInput!(question, permission.signal)
                      if (response.behavior === 'cancelled') {
                        return {
                          behavior: 'deny' as const,
                          message: '用户取消了提问',
                          interrupt: false,
                          decisionClassification: 'user_reject' as const
                        }
                      }
                      return {
                        behavior: 'allow' as const,
                        updatedInput: { ...input, answers: response.answers },
                        decisionClassification: 'user_temporary' as const
                      }
                    }
                    if ((request.permissionMode ?? 'default') === 'full_access') return { behavior: 'allow' as const }
                    const sessionSuggestions = exactSessionPermissionSuggestions(permission.suggestions)
                    const sessionDescription = exactSessionPermissionDescription(sessionSuggestions)
                    const question = agentPermissionQuestion(
                      request.runId,
                      permission.toolUseID,
                      permission.title ?? '权限请求',
                      `允许 ${toolName} 执行这项操作吗？`,
                      permission.description ?? JSON.stringify(input).slice(0, 1_200),
                      sessionDescription !== undefined,
                      `qoder:permission:${toolName}`,
                      sessionDescription
                    )
                    const response = await request.requestUserInput!(question, permission.signal)
                    const decision = agentPermissionDecision(question, response)
                    if (decision === 'reject') {
                      return {
                        behavior: 'deny' as const,
                        message: '用户拒绝了操作',
                        interrupt: false,
                        decisionClassification: 'user_reject' as const
                      }
                    }
                    const applySessionSuggestions = decision === 'session' && sessionDescription !== undefined
                    return {
                      behavior: 'allow' as const,
                      ...(applySessionSuggestions
                        ? { updatedPermissions: sessionSuggestions }
                        : {}),
                      decisionClassification: applySessionSuggestions ? 'user_permanent' as const : 'user_temporary' as const
                    }
                  }
                }
              : {}),
            abortController: controller
          } as never
        })
        let statuses: McpServerStatus[] | undefined
        let terminalError: unknown
        try {
          try {
            await Promise.race([
              (async () => {
                for await (const message of q!) {
                  const raw = message as unknown as Record<string, unknown>
                  observeProviderTurnId(qoderProviderTurnId(raw))
                  if (typeof raw.session_id === 'string' && raw.session_id !== externalSessionId) {
                    externalSessionId = raw.session_id
                    request.onExternalSessionId?.(raw.session_id)
                  }
                  if (raw.type === 'system' && raw.subtype === 'init' && Array.isArray(raw.mcp_servers)) {
                    statuses = (raw.mcp_servers as Array<{ name: string; status: McpServerStatus['status'] }>).map((server) => ({
                      name: server.name,
                      status: server.status
                    }))
                  }
                  if (raw.type === 'result' && (raw.subtype !== 'success' || raw.is_error === true)) {
                    providerStatus = 'failed'
                  }
                  for (const rawEvent of normalizeSdkMessage(message, ctx)) {
                    const event = qoderTrace(rawEvent)
                    if (event.kind === 'harness' && event.stage === 'result' && event.isError) providerFailureSeen = true
                    if (event.kind === 'hook') sdkHooks.push(event)
                    if (event.kind === 'model' && event.stage === 'text_delta') {
                      streamedText += event.text ?? ''
                      request.emit(event)
                    } else if (event.kind === 'model' && event.stage === 'text' && streamedText) {
                      const full = event.text ?? ''
                      const remainder = full.startsWith(streamedText) ? full.slice(streamedText.length) : full
                      streamedText = ''
                      if (remainder) request.emit({ ...event, text: remainder })
                    } else {
                      request.emit(event)
                    }
                  }
                }
              })(),
              unexpectedExit
            ])
          } catch (error) {
            if (!providerFailureSeen) terminalError = error
          }
        } finally {
          streamSettled = true
          if (exitTimer) clearTimeout(exitTimer)
          try {
            await q.close()
          } catch (error) {
            if (!providerFailureSeen && terminalError == null) terminalError = error
          }
        }
        const logHooksEnabled = process.env.SCRY_QODER_LOG_HOOKS?.trim() !== '0'
        if ((request.managedRecorder === true || logHooksEnabled) && qoderPid) {
          try {
            const log = await qoderHookLog(qoderPid)
            observeProviderTurnId(qoderProviderTurnIdFromLog(log, externalSessionId))
            const backgroundFailures = parseQoderBackgroundTaskFailures(request.runId, log, externalSessionId)
            for (const event of backgroundFailures) request.emit(event)
            if (backgroundFailures.length > 0) providerStatus = 'failed'
            if (logHooksEnabled) {
              const fallback = parseQoderHookLog(request.runId, log, externalSessionId)
              for (const event of qoderHookFallbackOnly(sdkHooks, fallback)) request.emit(event)
              hookFallbackObserved = true
            }
            lastHookFallbackError = undefined
          } catch (error) {
            lastHookFallbackError = String((error as Error).message)
            request.emit({
              id: newId(), runId: request.runId, ts: new Date().toISOString(),
              kind: 'harness', stage: 'runtime:telemetry_degraded', text: lastHookFallbackError,
              runtimeMetadata: { source: 'qoder_cli_log', capability: 'hooks' }
            })
          }
        } else if ((request.managedRecorder === true || logHooksEnabled) && !qoderPid) {
          lastHookFallbackError = 'Qoder log fallback could not identify the current CLI process'
        }
        if (terminalError != null) throw terminalError
        return {
          externalSessionId,
          providerTurnId: currentProviderTurnId(),
          stopped,
          status: stopped ? 'interrupted' : providerStatus,
          mcp: statuses ? qoderMcpSnapshot(statuses) : undefined
        }
      })()
      const interrupt = (): void => {
        stopped = true
        controller.abort()
        void q?.interrupt().catch(() => {})
      }
      return {
        promise,
        interrupt,
        getExternalSessionId: () => externalSessionId,
        getProviderTurnId: currentProviderTurnId
      }
    },
    mcp: {
      snapshot: async (context, refresh = false, execution) => {
        const configured = listProviderMcp('qoder', context.cwd, homeDir, shellEnv())
        const operations = { authenticate: qoderAuthenticationTargets(configured) }
        const base: McpSnapshot = { configured, runtime: null, operations }
        if (!refresh) {
          return {
            ...capabilityReady(context, 'read', base),
            state: 'degraded',
            reason: '配置已读取；刷新后才会启动已授权 MCP 并读取 Qoder 原生运行状态'
          }
        }
        if (!configured.some((item) => item.enabled)) {
          return capabilityReady(context, 'read', { configured, runtime: [], operations })
        }
        if (!execution) {
          return capabilityUnknown<McpSnapshot>(context, 'read', '缺少已确认的 Qoder MCP 执行快照')
        }
        const prompt = heldPrompt()
        const q = query({ prompt: prompt.stream, options: qoderOptions(context.cwd, undefined, undefined, undefined, 'default', false, execution) as never })
        try {
          await q.initializationResult()
          return capabilityReady(context, 'read', qoderMcpSnapshot(await q.mcpServerStatus(), configured))
        } catch (error) {
          return capabilityUnknown<McpSnapshot>(context, 'read', sanitizeMcpAuthError(error))
        } finally {
          prompt.release()
          await Promise.resolve(q.close()).catch(() => {})
        }
      },
      reauthenticate: async (context, targetId, execution, interaction: McpAuthInteraction) => {
        const failed = (error: unknown, authenticated = false) => capabilityReady(context, 'read', {
          ok: false,
          status: authenticated ? 'authenticated-unverified' as const : 'failed' as const,
          error: sanitizeMcpAuthError(error)
        })
        if (!execution) return failed('缺少绑定当前配置快照的 MCP 执行授权')
        if (execution.cwd !== context.cwd) return failed('MCP 执行授权与当前工作目录不匹配')
        const target = execution.targets.find((item) => item.targetId === targetId)
        if (!target) return failed('已确认的 Qoder MCP 执行快照中不存在该目标')
        if (!target.enabled) return failed(`Qoder MCP ${target.name} 当前已停用`)
        if (!isRemoteMcpConfig(target.config)) return failed('stdio MCP 不支持 OAuth 重新认证')
        if (execution.targets.some((item) => item.targetId !== targetId && item.enabled && item.name === target.name)) {
          return failed(`Qoder 存在多个同名 MCP ${target.name}，无法安全绑定认证目标`)
        }

        let loopback: Awaited<ReturnType<McpAuthInteraction['prepareLoopbackCallback']>>
        try {
          loopback = await interaction.prepareLoopbackCallback()
        } catch (error) {
          return failed(error)
        }

        const prompt = heldPrompt()
        const q = query({
          prompt: prompt.stream,
          options: {
            ...qoderOptions(context.cwd, undefined, undefined, undefined, 'default', false, {
              ...execution,
              targets: [target]
            }),
            persistSession: false
          } as never
        })
        let authenticated = false
        let timedOut = false
        let timer: NodeJS.Timeout | undefined
        const assertActive = (): void => {
          if (timedOut) throw new Error('等待 Qoder MCP 浏览器认证超时')
        }
        try {
          return await Promise.race([
            (async () => {
              await q.initializationResult()
              assertActive()
              const auth = await q.mcpAuthenticate(target.name, loopback.redirectUri)
              assertActive()
              if (auth.requiresUserAction) {
                if (!auth.authUrl) throw new Error('Qoder 未返回 OAuth 授权地址')
                if (!isSafeOAuthAuthorizationUrl(auth.authUrl)) throw new Error('Qoder 返回了不安全的 OAuth 授权地址')
                await interaction.openExternal(auth.authUrl)
                assertActive()
                await q.mcpSubmitOAuthCallbackUrl(target.name, await loopback.waitForCallback())
                assertActive()
              }
              authenticated = true
              const status = (await q.mcpServerStatus()).find((server) => server.name === target.name)
              assertActive()
              if (status?.status !== 'connected') {
                throw new Error(status?.error || `Qoder MCP ${target.name} 认证后状态为 ${status?.status ?? 'unknown'}`)
              }
              return capabilityReady(context, 'read', { ok: true, status: 'authenticated' as const })
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true
                reject(new Error('等待 Qoder MCP 浏览器认证超时'))
              }, QODER_MCP_AUTH_TIMEOUT_MS)
              timer.unref()
            })
          ])
        } catch (error) {
          return failed(error, authenticated)
        } finally {
          if (timer) clearTimeout(timer)
          try {
            loopback.close()
          } finally {
            prompt.release()
            const close = Promise.resolve(q.close()).catch(() => {})
            if (timedOut) void close
            else await close
          }
        }
      }
    },
    skills: {
      list: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = skillCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            const catalog = await withControl(context, async (q) => {
              const [usage, commands] = await Promise.all([q.getContextUsage(), q.supportedCommands()])
              const descriptions = new Map(commands.map((command) => [command.name, command.description]))
              const skills = usage.skills
              return {
                data: (skills?.skillFrontmatter ?? []).map((skill) => ({
                  name: skill.name,
                  dir: skill.source,
                  scope: qoderSkillScope(skill.source),
                  description: descriptions.get(skill.name) ?? '',
                  enabled: true
                })),
                total: skills?.totalSkills ?? 0,
                included: skills?.includedSkills ?? 0
              }
            })
            value = { data: catalog, observedAt: Date.now() }
            skillCache.set(key, value)
          }
          const ready = capabilityReady(context, 'read', value.data.data, value.observedAt)
          return value.data.included < value.data.total
            ? { ...ready, state: 'degraded' as const, reason: `Qoder 仅返回 ${value.data.included}/${value.data.total} 个已加载 Skill 的元数据` }
            : ready
        } catch (error) {
          return capabilityUnknown<SkillMeta[]>(context, 'read', String((error as Error).message))
        }
      }
    },
    commands: {
      list: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = commandCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            value = {
              data: await withControl(context, async (q) => {
                const commands = await q.supportedCommands()
                try {
                  const usage = await q.getContextUsage()
                  const skills = usage.skills
                  return {
                    commands,
                    skillNames: new Set((skills?.skillFrontmatter ?? []).map((skill) => skill.name)),
                    ...(skills && skills.includedSkills < skills.totalSkills
                      ? { reason: `Qoder 仅返回 ${skills.includedSkills}/${skills.totalSkills} 个已加载 Skill，其他命令来源保持未知` }
                      : {})
                  }
                } catch (error) {
                  return { commands, reason: `Qoder Skill catalog 读取失败，命令来源保持未知：${String((error as Error).message)}` }
                }
              }),
              observedAt: Date.now()
            }
            commandCache.set(key, value)
          }
          const ready = capabilityReady(
            context,
            'read',
            value.data.commands.map((command) => ({
              name: command.name,
              description: command.description,
              argumentHint: command.argumentHint || undefined,
              source: value.data.skillNames?.has(command.name) ? 'skill' as const : undefined
            })),
            value.observedAt
          )
          return value.data.reason ? { ...ready, state: 'degraded' as const, reason: value.data.reason } : ready
        } catch (error) {
          return capabilityUnknown(context, 'read', String((error as Error).message))
        }
      }
    },
    account: {
      read: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = accountCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            const [usage, account] = await withControl(context, (q) => Promise.all([q.getUsageInfo(), q.accountInfo()]))
            value = { data: { usage, account }, observedAt: Date.now() }
            accountCache.set(key, value)
          }
          const accountLabel = firstNonBlank(value.data.account.email, value.data.account.name, value.data.account.userId)
          const plan = firstNonBlank(value.data.account.subscriptionType, value.data.usage?.userType)
          const usage = qoderAccountUsage(value.data.usage)
          if (!accountLabel && !plan && !usage) {
            return capabilityUnknown<AccountSnapshot>(context, 'read', 'Qoder 未返回账号或用量证据')
          }
          const data: AccountSnapshot = {
            ...(accountLabel ? { accountLabel } : {}),
            ...(plan ? { plan } : {}),
            ...(usage ? { usage } : {})
          }
          return capabilityReady(context, 'read', data, value.observedAt)
        } catch (error) {
          return capabilityUnknown<AccountSnapshot>(context, 'read', String((error as Error).message))
        }
      }
    },
    runControls: {
      read: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = modelCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            const models = await withControl(context, (q, initialized) => {
              const cached = Array.isArray(initialized.models) ? initialized.models : []
              return cached.length > 0
                ? Promise.resolve(cached)
                : q.getAvailableModels({ fetchStrategy: 'live' })
            })
            value = {
              observedAt: Date.now(),
              data: {
                models: models
                  .filter((model) => model.isEnabled !== false)
                  .map((model) => ({
                    model: { id: model.value },
                    label: model.displayName,
                    description: model.description,
                    isDefault: model.isDefault,
                    efforts: (model.efforts ?? []).map((effort) =>
                      effortOption(effort, undefined, effort === model.defaultEffort)
                    )
                  })),
                permissions: permissionOptions()
              }
            }
            modelCache.set(key, value)
          }
          return capabilityReady(context, 'read', value.data, value.observedAt)
        } catch (error) {
          return {
            ...capabilityReady(context, 'read', { models: [], permissions: permissionOptions() }),
            state: 'degraded' as const,
            reason: String((error as Error).message)
          }
        }
      }
    },
    dispose: () => {
      for (const [key, session] of controls) closeControl(key, session)
    }
  }
}
