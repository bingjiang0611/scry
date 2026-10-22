import { ProcessTransport, forkSession, getSessionMessages, qodercliAuth, query, type McpServerStatus, type PermissionUpdate, type Query, type SDKUserMessage, type SlashCommand } from '@qoder-ai/qoder-agent-sdk'
import { spawn } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { capabilityReady, capabilityUnknown, type McpSnapshot, type ProviderContext, type SkillMeta } from '../../shared/provider'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  exactSessionPermissionDescription,
  exactSessionPermissionSuggestions,
  normalizeAgentQuestionRequest,
  type AgentPermissionMode,
  type AgentRunControlCatalog
} from '../../shared/runtime'
import { contextUsageEvidence, type McpLiveStatus, type TraceEvent } from '../../shared/trace'
import { resolveRuntimeCliBin, runtimeCliEnv, shellEnv } from '../claude-locate'
import { authorizedMcpServers, isRemoteMcpConfig, listProviderMcp } from '../mcp-config'
import { captureProcessIdentity, signalProcessTreeWithIdentity, type ProcessIdentity } from '../process-diagnostics'
import { extractUserText, normalizeAgentTaskStatus, type NormalizeCtx, type ParsedTurn } from '../normalize'
import { normalizeQoderMessage, QoderBackgroundTasks } from './qoder-messages'
import { QoderCreditCollector } from '../../shared/credit-usage'
import type { AuthorizedMcpExecution, McpAuthInteraction, ProviderAdapter, ProviderRunRequest, ProviderRunResult } from './types'
import { effortOption, permissionOptions } from './run-controls'
import { isSafeOAuthAuthorizationUrl } from '../oauth-loopback'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import { completedTranscriptTurnBoundary, isTranscriptUserPrompt } from './session-fork-boundary'
import { resolveQoderForkUserId } from './qoder-fork-identity'
import { QoderBackgroundMonitor } from './qoder-background-work'
import { QoderTaskControlTransport } from './qoder-task-control'
import type { QueryTransportCreateOptions } from '@qoder-ai/qoder-agent-sdk'

function explainQoderSessionAccessError(error: unknown): never {
  const failure = error as NodeJS.ErrnoException | null
  if (failure?.code !== 'EPERM' && failure?.code !== 'EACCES') throw error
  throw new Error(
    `Qoder 会话文件访问被系统拒绝（${failure.code}）${failure.path ? `：${failure.path}` : ''}。` +
    '请检查该文件及父目录权限；macOS 下同时检查 Scry 的文件访问授权，确认后重试。' +
    'Scry 未自动更改权限或重试创建分支。',
    { cause: error }
  )
}

interface Cached<T> {
  data: T
  observedAt: number
}

type QoderInitialization = Awaited<ReturnType<Query['initializationResult']>>

interface QoderInitializationEvidence {
  value: QoderInitialization
  observedAt: number
}

interface QoderControlRead<T> {
  value: T
  session: QoderControlSession
  initializedAt: number
}

interface QoderControlSession {
  key: string
  query: Query
  releasePrompt: () => void
  ready: Promise<QoderInitializationEvidence>
  active: number
  retired: boolean
  quiesced: Promise<void>
  resolveQuiesced: () => void
  closePromise?: Promise<void>
  startClose?: () => void
  closeStarted: boolean
  idleTimer?: NodeJS.Timeout
}

interface QoderControlRefresh {
  session: QoderControlSession
  promise: Promise<void>
  invalidated: boolean
}

const PROBE_TTL_MS = 30_000
const CONTROL_READY_TIMEOUT_MS = 20_000
const CONTROL_READY_TIMEOUT_REASON = `Qoder 控制会话 ${CONTROL_READY_TIMEOUT_MS / 1000} 秒内未完成初始化`
const CONTROL_CONTEXT_INVALIDATED_REASON = 'Qoder control context invalidated'
const QODER_MCP_AUTH_TIMEOUT_MS = 120_000
const QODER_CONTEXT_USAGE_TIMEOUT_MS = 2_000
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

interface QoderSkillDescriptor {
  name: string
  description: string
  source: string
  location: string
}

function qoderRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function qoderSkillCatalog(
  initialized: unknown,
  usage: unknown,
  commands: SlashCommand[]
): { skills: QoderSkillDescriptor[]; total: number; included: number } {
  const descriptions = new Map(commands.map((command) => [command.name, command.description]))
  const initializedSkills = qoderRecord(initialized).skills
  const usageSkills = qoderRecord(qoderRecord(usage).skills)
  const legacySkills = Array.isArray(usageSkills.skillFrontmatter) ? usageSkills.skillFrontmatter : []
  const modernSkills = Array.isArray(usageSkills.items) ? usageSkills.items : []
  const rows = [
    ...(Array.isArray(initializedSkills) ? initializedSkills : []),
    ...legacySkills,
    ...modernSkills
  ].map(qoderRecord)
  const byName = new Map<string, QoderSkillDescriptor>()
  for (const row of rows) {
    if (typeof row.name !== 'string' || !row.name) continue
    const current = byName.get(row.name)
    const location = [row.path, row.location, row.dir].find((value): value is string => typeof value === 'string')
    byName.set(row.name, {
      name: row.name,
      description: typeof row.description === 'string'
        ? row.description
        : current?.description ?? descriptions.get(row.name) ?? '',
      source: typeof row.source === 'string' ? row.source : current?.source ?? 'unknown',
      location: location ?? current?.location ?? ''
    })
  }
  const skills = [...byName.values()]
  const legacyTotal = typeof usageSkills.totalSkills === 'number' ? usageSkills.totalSkills : undefined
  const modernTotal = typeof usageSkills.count === 'number' ? usageSkills.count : undefined
  const total = Math.max(skills.length, legacyTotal ?? 0, modernTotal ?? 0)
  const included = Array.isArray(initializedSkills)
    ? skills.length
    : typeof usageSkills.includedSkills === 'number'
      ? Math.min(usageSkills.includedSkills, skills.length)
      : skills.length
  return { skills, total, included }
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

function livePrompt(text: string): { stream: AsyncIterable<SDKUserMessage>; release: () => void } {
  let release = (): void => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    stream: (async function* (): AsyncIterable<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null
      } as SDKUserMessage
      await wait
    })(),
    release
  }
}

/**
 * 按身份给 Qoder CLI 进程树发信号。
 *
 * 这里只有一个裸 PID（SDK 回调给出，不是活的 child 句柄），进程可能已经退出并被
 * 别人复用。所以 spawn 时采集 `(pid, 启动时间, 命令行)`，发信号前重新核对；
 * 核对不上就不发，win32 上没有进程组语义时自动退化为单进程信号。
 */
function signalProcessTree(identity: ProcessIdentity | undefined, signal: NodeJS.Signals): void {
  if (!identity) return
  if (process.platform === 'win32') {
    try { process.kill(identity.pid, signal) } catch { /* already gone */ }
    return
  }
  signalProcessTreeWithIdentity({ identity, signal })
}

export function resolveQoderSdkExecutable(executable: string): string {
  try {
    return realpathSync(executable)
  } catch {
    return executable
  }
}

function qoderOptions(
  cwd: string | undefined,
  resume?: string,
  onPid?: (pid: number, identity: ProcessIdentity | undefined) => void,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  permissionMode: AgentPermissionMode = 'default',
  managedRecorder = false,
  mcpExecution?: AuthorizedMcpExecution,
  managedIdentity?: ProviderRunRequest['managedRecorderIdentity']
): Record<string, unknown> {
  const detectedExecutable = process.env.SCRY_QODERCLI_PATH?.trim() || resolveRuntimeCliBin('qoder')
  if (!detectedExecutable) throw new Error('Qoder CLI 未找到')
  // Corporate EDR blocks the qodercli symlink entry from reading ~/.qoder/.auth/user.
  // Resolving the same signed CLI to its JavaScript bundle lets the SDK launch it
  // through Node, preserving the original config/auth/session paths.
  const executable = resolveQoderSdkExecutable(detectedExecutable)
  const runtimeEnv = runtimeCliEnv(
    undefined,
    managedRecorder ? { managedRecorder: true, providerId: 'qoder' } : { providerId: 'qoder' }
  )
  delete runtimeEnv.SCRY_MANAGED_RUN_ID
  delete runtimeEnv.SCRY_MANAGED_PROMPT_HASH
  const permissions = permissionMode === 'full_access'
    ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
    : {
        permissionMode: permissionMode === 'auto_review'
          ? 'auto'
          // Qoder SDK 与 Claude 同源，acceptEdits 是原生档位。
          : permissionMode === 'auto_accept_edits' ? 'acceptEdits' : 'default'
      }
  return {
    auth: qodercliAuth(),
    cwd,
    resume,
    pathToQoderCLIExecutable: executable,
    env: {
      ...runtimeEnv,
      ...(managedRecorder && managedIdentity ? {
        SCRY_MANAGED_RUN_ID: managedIdentity.runId,
        SCRY_MANAGED_PROMPT_HASH: managedIdentity.promptHash
      } : {}),
      // Waiting is visible in Scry, with explicit user-controlled cancellation.
      // Silence must not trigger the CLI's destructive background wait ceiling.
      QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0'
    },
    ...permissions,
    includePartialMessages: true,
    includeHookEvents: true,
    settingSources: ['user', 'project', 'local'],
    // Qoder SDK mode disables the cross-agent compatibility directory by default.
    // Enable discovery only; Qoder's native folder trust still gates project skills.
    settings: { skills: { loadFromAgentsDirectory: true } },
    // Qoder must never discover MCP implicitly. Scry injects only the exact
    // fingerprinted configs that passed Scry's Guard and execution checks.
    strictMcpConfig: true,
    mcpServers: authorizedMcpServers(mcpExecution),
    controlRequestTimeoutMs: 30_000,
    ...(onPid
      ? {
          spawnQoderCLIProcess: (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env as NodeJS.ProcessEnv,
              detached: process.platform !== 'win32',
              stdio: ['pipe', 'pipe', 'pipe']
            })
            // 立刻采集身份：进程还活着时采到的启动时间才能作为后续核对基准。
            const identity = captureProcessIdentity(child.pid)
            if (child.pid) onPid(child.pid, identity)
            child.once('exit', (code, signal) => onExit?.(code, signal))
            options.signal.addEventListener('abort', () => signalProcessTree(identity, 'SIGTERM'), { once: true })
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
  const pending = new Map<string, Array<{ detail: Record<string, string>; startedAt: number }>>()
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
      queue.push({ detail, startedAt: new Date(match[1]).getTime() })
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
    const queue = pending.get(key) ?? []
    const finishedAt = new Date(match[1]).getTime()
    const durationMs = detail.duration_ms == null ? Number.NaN : Number(detail.duration_ms)
    // finished 日志不带 source/index；用它上报的 duration 反推 started，避免并发 Hook 按完成顺序串位。
    const expectedStart = finishedAt - durationMs
    const matchedIndex = Number.isFinite(expectedStart) && queue.length > 1
      ? queue.reduce((best, candidate, index) =>
          Math.abs(candidate.startedAt - expectedStart) < Math.abs(queue[best].startedAt - expectedStart) ? index : best, 0)
      : 0
    const started = queue.splice(matchedIndex, 1)[0]?.detail ?? {}
    if (queue.length === 0) pending.delete(key)
    const hookId = `qoder-log:${key}:${started.source ?? 'unknown'}:${started.hook_index ?? 'unknown'}`
    const success = detail.success === 'true'
    const exitCode = detail.exit_code == null ? undefined : Number(detail.exit_code)
    events.push({
      id: `${hookId}:response`, runId, ts: new Date(match[1]).toISOString(), kind: 'hook', stage: 'hook_response',
      tool: hookName, name: hookEvent, hookId, hookName, hookEvent, hookCommand: started.display_text,
      hookOutcome: success ? 'success' : 'error', hookExitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      toolUseId: context.tool, durationMs: Number.isFinite(durationMs) ? durationMs : undefined, isError: !success,
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

export function parseQoderSubagentTerminals(runId: string, text: string, sessionId?: string): TraceEvent[] {
  const events: TraceEvent[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+)\s+\S+\s+debug\.message\s+\[SubagentRun\]\s+error\s+(.+)$/)
    if (!match) continue
    const detail = fields(match[2])
    if (sessionId && detail.sessionId !== sessionId) continue
    if (!detail.parentToolUseId || !detail.taskId) continue
    const stopped = /AbortError|cancelled|canceled|closing|SIGTERM|terminated/i.test(match[2])
    const agentStatus = stopped ? 'stopped' : 'failed'
    const output = stopped ? '后台 Agent 已停止' : '后台 Agent 失败'
    events.push({
      id: `qoder-log:agent:${detail.taskId}:${detail.parentToolUseId}:response`,
      runId,
      ts: new Date(match[1]).toISOString(),
      kind: 'tool',
      stage: 'tool_result',
      tool: 'Agent',
      toolUseId: detail.parentToolUseId,
      text: output,
      output,
      isError: !stopped,
      runtimeMetadata: {
        source: 'qoder_cli_log',
        agentStatus,
        taskId: detail.taskId,
        qoderAgentId: detail.agentId
      }
    })
  }
  return events
}

function observedAgentStatus(event: TraceEvent): string | undefined {
  const status = event.runtimeMetadata?.agentStatus
  return typeof status === 'string' ? status : undefined
}

function isAgentLaunchStatus(status: string | undefined): boolean {
  return status === 'async_launched' || status === 'remote_launched' || status === 'running' || status === 'in_progress'
}

function isAgentTerminalStatus(status: string | undefined): boolean {
  return normalizeAgentTaskStatus(status) !== undefined
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
  const notificationTurnIds = new Set<string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^\S+\s+\S+\s+\[([^\]]+)\]\s+(input\.prompt\.received|input\.prompt\.submitted|turn\.started)\s+(.+)$/)
    if (!match) continue
    const context = fields(match[1])
    const detail = fields(match[3])
    if (sessionId && context.session !== sessionId) continue
    if (!context.turn || context.turn === context.session) continue
    if (match[2] === 'input.prompt.received' && detail.command_mode === 'task-notification') {
      notificationTurnIds.add(context.turn)
    } else if (match[2] === 'input.prompt.received' && detail.query_source === 'sdk') {
      sdkPromptIds.add(context.turn)
    } else if (detail.is_subagent === 'false') {
      rootTurnIds.add(context.turn)
    }
  }
  // Qoder 后台任务通知也标 query_source=sdk / is_subagent=false，但属于原请求的
  // 后续处理，不是新的用户轮次。全量收集后排除它的生命周期 ID，避免 fallback 再引入。
  // 仍要求用户请求 ID 唯一，不能用“取第一个”掩盖真正的多请求歧义。
  for (const id of notificationTurnIds) {
    sdkPromptIds.delete(id)
    rootTurnIds.delete(id)
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
    tools: server.tools?.length,
    toolNames: server.tools?.map((tool) => tool.name)
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

interface QoderContextEvidence {
  contextTokens: number
  contextWindow: number
  model?: string
  percentage?: number
  rawContextWindow?: number
  source: 'qoder_control' | 'qoder_native_transcript'
  quality: 'exact' | 'inferred'
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function qoderControlContext(value: unknown): QoderContextEvidence | undefined {
  const raw = qoderRecord(value)
  const contextTokens = finiteNumber(raw.totalTokens)
  const contextWindow = finiteNumber(raw.maxTokens)
  if (contextTokens == null || contextTokens < 0 || contextWindow == null || contextWindow <= 0) return undefined
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined
  return {
    contextTokens,
    contextWindow,
    ...(model ? { model } : {}),
    ...(finiteNumber(raw.percentage) != null ? { percentage: finiteNumber(raw.percentage) } : {}),
    ...(finiteNumber(raw.rawMaxTokens) != null ? { rawContextWindow: finiteNumber(raw.rawMaxTokens) } : {}),
    source: 'qoder_control',
    quality: 'exact'
  }
}

function qoderContextTokensFromUsage(value: unknown): number {
  return finiteNumber(qoderRecord(value).input_tokens) ?? 0
}

function qoderTranscriptContexts(messages: unknown[]): Array<QoderContextEvidence & { ts: number }> {
  const contexts: Array<QoderContextEvidence & { ts: number }> = []
  for (const value of messages) {
    const raw = qoderRecord(value)
    if (raw.type !== 'assistant') continue
    const ts = typeof raw.timestamp === 'string' ? new Date(raw.timestamp).getTime() : finiteNumber(raw.timestamp)
    if (ts == null || !Number.isFinite(ts)) continue
    const message = qoderRecord(raw.message)
    const usage = qoderRecord(message.usage)
    // Qoder 的 input_tokens 已是当前完整 prompt；cache_read_input_tokens 是其中的复用子集，
    // 与 input_tokens 相加会重复计算。原生 context_usage_ratio 也直接以 input_tokens 为分子。
    const contextTokens = finiteNumber(usage.input_tokens)
    const ratio = finiteNumber(usage.context_usage_ratio)
    if (contextTokens == null || contextTokens < 0 || ratio == null || ratio <= 0) continue
    const contextWindow = Math.round(contextTokens / ratio)
    if (contextWindow <= 0) continue
    const model = typeof message.model === 'string' && message.model.trim() ? message.model.trim() : undefined
    contexts.push({
      ts,
      contextTokens,
      contextWindow,
      ...(model ? { model } : {}),
      percentage: ratio * 100,
      source: 'qoder_native_transcript',
      quality: 'inferred'
    })
  }
  return contexts
}

function withQoderContext(event: TraceEvent, evidence: QoderContextEvidence | undefined): TraceEvent {
  if (!evidence || event.kind !== 'harness' || event.stage !== 'result') return event
  const existing = contextUsageEvidence(event)
  const genericSource = event.contextUsageSource === 'provider_usage' || event.contextUsageSource === 'provider_transcript'
  if (evidence.quality === 'inferred' && !genericSource && (existing || event.contextUsageQuality === 'exact')) return event
  const rows = event.modelUsage?.length
    ? event.modelUsage
    : [{ model: evidence.model ?? 'unknown' }]
  let attached = false
  const canAttachWithoutModel = !evidence.model && rows.length === 1
  const modelUsage = rows.map((row) => {
    if (attached || (!canAttachWithoutModel && row.model !== evidence.model)) return row
    attached = true
    return { ...row, contextWindow: evidence.contextWindow }
  })
  if (!attached && evidence.model) modelUsage.push({ model: evidence.model, contextWindow: evidence.contextWindow })
  return {
    ...event,
    contextTokens: evidence.contextTokens,
    contextModel: evidence.model ?? (modelUsage.length === 1 ? modelUsage[0].model : undefined),
    contextUsageSource: evidence.source,
    contextUsageQuality: evidence.quality,
    modelUsage,
    runtimeMetadata: {
      ...(event.runtimeMetadata ?? {}),
      ...(evidence.percentage != null ? { contextUsagePercentage: evidence.percentage } : {}),
      ...(evidence.rawContextWindow != null ? { rawContextWindow: evidence.rawContextWindow } : {})
    }
  }
}

function enrichQoderHistory(turns: ParsedTurn[], messages: unknown[]): ParsedTurn[] {
  const contexts = qoderTranscriptContexts(messages)
  if (contexts.length === 0) return turns
  let previousEnd = Number.NEGATIVE_INFINITY
  return turns.map((turn) => {
    const timestamps = turn.items.map((event) => new Date(event.ts).getTime()).filter(Number.isFinite)
    if (timestamps.length === 0) return turn
    const end = Math.max(...timestamps)
    const evidence = [...contexts].reverse().find((context) => context.ts > previousEnd && context.ts <= end)
    previousEnd = end
    if (!evidence) return turn
    return {
      ...turn,
      items: turn.items.map((event) => withQoderContext(event, evidence))
    }
  })
}

async function qoderLiveContext(query: Query): Promise<QoderContextEvidence | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      query.getContextUsage(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), QODER_CONTEXT_USAGE_TIMEOUT_MS)
      })
    ])
    return qoderControlContext(value)
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function qoderTrace(event: TraceEvent, contextEvidence?: QoderContextEvidence): TraceEvent {
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
  const normalized = {
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
        billingProvider: 'qoder' as const,
        upstreamProvider: 'qoder',
        usageSource: 'qoder_sdk'
      }
    }),
    contextProvider: event.contextTokens != null ? 'qoder' : undefined,
    contextUsageSource: event.contextTokens != null ? 'qoder_sdk_usage' : undefined,
    contextUsageQuality: event.contextTokens != null ? 'exact' as const : undefined,
    runtimeMetadata: { ...(event.runtimeMetadata ?? {}), source: 'qoder_sdk', billingProvider: 'qoder', reportedZeroUsage },
    billingProvider: 'qoder' as const,
    upstreamProvider: 'qoder',
    usageSource: 'qoder_sdk'
  }
  return withQoderContext(normalized, contextEvidence)
}

export function createQoderAdapter(homeDir = homedir()): ProviderAdapter {
  const controls = new Map<string, QoderControlSession>()
  const closingControls = new Map<string, Promise<void>>()
  const refreshingControls = new Map<string, QoderControlRefresh>()
  const ownedControls = new Set<QoderControlSession>()
  const skillCache = new Map<string, Cached<{ data: SkillMeta[]; total: number; included: number }>>()
  const commandCache = new Map<string, Cached<{ commands: SlashCommand[]; skillNames?: Set<string>; reason?: string }>>()
  const modelCache = new Map<string, Cached<AgentRunControlCatalog>>()
  const contextGenerations = new Map<string, number>()
  let disposed = false
  let disposePromise: Promise<void> | undefined
  let lastHookFallbackError: string | undefined
  let lastControlCloseError: string | undefined
  let hookFallbackObserved = false

  const recordControlCloseFailure = (error: unknown): void => {
    lastControlCloseError = sanitizeMcpAuthError(error)
  }

  const closeControl = (key: string, session: QoderControlSession, mode: 'graceful' | 'cancel' = 'graceful'): Promise<void> => {
    if (session.closePromise) {
      if (mode === 'cancel') session.startClose?.()
      return session.closePromise
    }
    session.retired = true
    if (controls.get(key) === session) controls.delete(key)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (session.active === 0) session.resolveQuiesced()
    let startClose!: () => void
    const closePromise = new Promise<void>((resolve, reject) => {
      startClose = () => {
        if (session.closeStarted) return
        session.closeStarted = true
        session.releasePrompt()
        void Promise.resolve().then(() => session.query.close()).then(
          () => {
            ownedControls.delete(session)
            if (closingControls.get(key) === closePromise) closingControls.delete(key)
            resolve()
          },
          (error) => {
            recordControlCloseFailure(error)
            reject(error)
          }
        )
      }
    })
    session.closePromise = closePromise
    session.startClose = startClose
    closingControls.set(key, closePromise)
    if (mode === 'cancel') startClose()
    else void session.quiesced.then(startClose)
    closePromise.then(() => {}, () => {})
    return closePromise
  }

  const waitForControlClose = async (key: string): Promise<void> => {
    const closing = closingControls.get(key)
    if (closing) await closing
  }

  const controlFor = (context: ProviderContext): QoderControlSession => {
    const key = context.cwd ?? ''
    const existing = controls.get(key)
    if (existing && !existing.retired) return existing
    if (disposed) throw new Error('Qoder adapter 已释放')
    const prompt = heldPrompt()
    const q = query({
      prompt: prompt.stream,
      options: { ...qoderOptions(context.cwd), persistSession: false } as never
    })
    let resolveQuiesced!: () => void
    const quiesced = new Promise<void>((resolve) => { resolveQuiesced = resolve })
    const ready = Promise.resolve(q.initializationResult()).then((value) => ({ value, observedAt: Date.now() }))
    const session: QoderControlSession = {
      key,
      query: q,
      releasePrompt: prompt.release,
      ready,
      active: 0,
      retired: false,
      quiesced,
      resolveQuiesced,
      closeStarted: false
    }
    controls.set(key, session)
    ownedControls.add(session)
    return session
  }

  const refreshControl = (context: ProviderContext, session: QoderControlSession): Promise<void> => {
    const key = context.cwd ?? ''
    const existing = refreshingControls.get(key)
    if (existing) return existing.promise
    const state = { session, invalidated: false } as QoderControlRefresh
    state.promise = (async () => {
      if (controls.get(key) === session) await closeControl(key, session)
      await waitForControlClose(key)
    })()
    refreshingControls.set(key, state)
    return state.promise
  }

  const acquireControl = async (context: ProviderContext, expectedGeneration: number): Promise<[string, QoderControlSession]> => {
    const key = context.cwd ?? ''
    while (true) {
      if ((contextGenerations.get(key) ?? 0) !== expectedGeneration) throw new Error(CONTROL_CONTEXT_INVALIDATED_REASON)
      const refresh = refreshingControls.get(key)
      if (refresh) {
        await refresh.promise
        if (refresh.invalidated || (contextGenerations.get(key) ?? 0) !== expectedGeneration) {
          if (refreshingControls.get(key) === refresh) refreshingControls.delete(key)
          throw new Error(CONTROL_CONTEXT_INVALIDATED_REASON)
        }
        if (refreshingControls.get(key) === refresh) refreshingControls.delete(key)
        const current = controls.get(key)
        if (current && !current.retired && !disposed) {
          if (current.idleTimer) clearTimeout(current.idleTimer)
          current.active++
          return [key, current]
        }
        const created = controlFor(context)
        created.active++
        return [key, created]
      }
      await waitForControlClose(key)
      if ((contextGenerations.get(key) ?? 0) !== expectedGeneration) throw new Error(CONTROL_CONTEXT_INVALIDATED_REASON)
      const current = controls.get(key)
      if (current && !current.retired && !disposed) {
        if (current.idleTimer) clearTimeout(current.idleTimer)
        current.active++
        return [key, current]
      }
      const created = controlFor(context)
      created.active++
      return [key, created]
    }
  }

  const awaitReady = async (session: QoderControlSession): Promise<QoderInitializationEvidence> =>
    Promise.race([
      session.ready,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(CONTROL_READY_TIMEOUT_REASON)), CONTROL_READY_TIMEOUT_MS)
        void session.ready.catch(() => {}).finally(() => clearTimeout(timer))
      })
    ])

  const withControl = async <T>(
    context: ProviderContext,
    read: (q: Query, initialized: QoderInitialization) => Promise<T>,
    options: { requireFreshInitialization?: boolean } = {}
  ): Promise<QoderControlRead<T>> => {
    const key = context.cwd ?? ''
    const expectedGeneration = contextGenerations.get(key) ?? 0
    const requireFreshInitialization = options.requireFreshInitialization !== false
    while (true) {
      const [currentKey, session] = await acquireControl(context, expectedGeneration)
      let refresh = false
      let result: T | undefined
      let initializedAt = 0
      try {
        const initialization = await awaitReady(session)
        initializedAt = initialization.observedAt
        refresh = session.retired || controls.get(currentKey) !== session || disposed ||
          (requireFreshInitialization && Date.now() - initialization.observedAt >= PROBE_TTL_MS)
        if (!refresh) result = await read(session.query, initialization.value)
      } catch (error) {
        const message = String((error as Error).message)
        if (message === CONTROL_READY_TIMEOUT_REASON || /transport|closed|process|broken pipe/i.test(message)) {
          void closeControl(currentKey, session, 'cancel').catch(recordControlCloseFailure)
        }
        throw error
      } finally {
        session.active--
        if (session.active === 0) {
          if (session.retired) session.resolveQuiesced()
          else if (controls.get(currentKey) === session) {
            session.idleTimer = setTimeout(() => { void closeControl(currentKey, session).catch(recordControlCloseFailure) }, 5_000)
          }
        }
      }
      if (refresh) {
        if (disposed) throw new Error('Qoder adapter 已释放')
        await refreshControl(context, session)
        continue
      }
      return { value: result as T, session, initializedAt }
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
        capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' },
        health: lastHookFallbackError || lastControlCloseError
          ? { state: 'degraded', transport: 'Qoder Agent SDK', lastError: lastHookFallbackError || lastControlCloseError }
          : { state: !path ? 'unavailable' : hookFallbackObserved ? 'ready' : 'unknown', transport: 'Qoder Agent SDK' }
      }
    },
    forkLastTurn: {
      async fork(request) {
        const messages = await getSessionMessages(request.sourceSessionId, {
          dir: request.cwd,
          includeSystemMessages: true
        }).catch(explainQoderSessionAccessError)
        const nativeIndex = messages.findIndex((message) =>
          typeof (message as { uuid?: unknown }).uuid === 'string' &&
          (message as { uuid: string }).uuid === request.replaceForkTurnId
        )
        const promptIndex = messages.findLastIndex((message) => {
          const payload = message.message && typeof message.message === 'object' && !Array.isArray(message.message)
            ? (message.message as { content?: unknown }).content
            : message.message
          return message.type === 'user' && message.parent_tool_use_id == null &&
            extractUserText(payload).trim() === request.originalPrompt.trim()
        })
        const index = nativeIndex >= 0 ? nativeIndex : promptIndex
        const boundary = index > 0 ? (messages[index - 1] as { uuid?: unknown }).uuid : undefined
        if (typeof boundary !== 'string' || !boundary) throw new Error('Qoder 会话无法定位待替换消息的前一边界')
        const forked = await forkSession(request.sourceSessionId, {
          dir: request.cwd,
          upToMessageId: boundary,
          title: 'Edited branch'
        }).catch(explainQoderSessionAccessError)
        return { externalSessionId: forked.sessionId }
      }
    },
    forkSession: {
      async fork(request) {
        const messages = await getSessionMessages(request.sourceSessionId, {
          dir: request.cwd,
          includeSystemMessages: true
        }).catch(explainQoderSessionAccessError)
        const activeUserIds = new Set(messages.filter(isTranscriptUserPrompt).map((message) => message.uuid))
        // Older Scry archives copied promptId into forkTurnId. Never treat it as a UUID
        // or guess by prompt text; recover the exact native mapping when it is absent.
        const sourceUserId = activeUserIds.has(request.sourceForkTurnId)
          ? request.sourceForkTurnId
          : request.sourceForkTurnId === request.sourceProviderTurnId
            ? await resolveQoderForkUserId({
                projectsDir: join(process.env.QODER_CONFIG_DIR ||
                  join(process.env.QODER_CLI_HOME || homedir(), '.qoder'), 'projects'),
                sessionId: request.sourceSessionId,
                cwd: request.cwd,
                promptId: request.sourceProviderTurnId,
                activeUserIds
              }).catch(explainQoderSessionAccessError)
            : request.sourceForkTurnId
        const boundary = completedTranscriptTurnBoundary(messages, sourceUserId, 'Qoder')
        const forked = await forkSession(request.sourceSessionId, {
          dir: request.cwd,
          upToMessageId: boundary,
          title: 'Scry branch'
        }).catch(explainQoderSessionAccessError)
        return { externalSessionId: forked.sessionId }
      }
    },
    run: (request: ProviderRunRequest) => {
      if (/^\/plugins\s+reload\s*$/i.test(request.prompt)) {
        const controller = new AbortController()
        const prompt = heldPrompt()
        let stopped = false
        let externalSessionId = request.resume
        let q: Query | undefined
        let qoderIdentity: ProcessIdentity | undefined
        const ctx: NormalizeCtx = {
          runId: request.runId,
          cwd: request.cwd,
          newId,
          now: () => new Date().toISOString(),
          contextTokensFromUsage: qoderContextTokensFromUsage
        }
        const promise: Promise<ProviderRunResult> = (async () => {
          q = query({
            prompt: prompt.stream,
            options: {
              ...qoderOptions(
                request.cwd,
                request.resume,
                (_pid, identity) => { qoderIdentity = identity },
                undefined,
                request.permissionMode,
                request.managedRecorder === true,
                request.mcpExecution,
                request.managedRecorderIdentity
              ),
              abortController: controller
            } as never
          })
          const events = (async () => {
            for await (const message of q!) {
              const raw = message as unknown as Record<string, unknown>
              request.recordNative?.(typeof raw.type === 'string' ? raw.type : 'unknown', raw)
              if (typeof raw.session_id === 'string' && raw.session_id !== externalSessionId) {
                externalSessionId = raw.session_id
                request.onExternalSessionId?.(raw.session_id)
              }
              for (const event of normalizeQoderMessage(message, ctx)) request.emit(qoderTrace(event))
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
          forceKill: () => signalProcessTree(qoderIdentity, 'SIGKILL'),
          // qoderPid 是本轮 spawn 的 CLI 进程树：硬杀不会波及其他 run。
          forceKillScope: 'run_scoped',
          getExternalSessionId: () => externalSessionId,
          getProviderTurnId: () => undefined
        }
      }
      const controller = new AbortController()
      let stopped = false
      let externalSessionId = request.resume
      let providerTurnId: string | undefined
      let forkTurnId: string | undefined
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
      let qoderIdentity: ProcessIdentity | undefined
      let streamSettled = false
      let exitTimer: ReturnType<typeof setTimeout> | undefined
      let rejectUnexpectedExit: (error: Error) => void = () => {}
      const unexpectedExit = new Promise<never>((_resolve, reject) => {
        rejectUnexpectedExit = reject
      })
      let providerFailureSeen = false
      let streamedText = ''
      let releaseProviderPrompt = (): void => {}
      const sdkHooks: TraceEvent[] = []
      const credits = new QoderCreditCollector()
      const activeAgentCalls = new Set<string>()
      const terminalAgentCalls = new Set<string>()
      const backgroundTasks = new QoderBackgroundTasks()
      let taskControl: QoderTaskControlTransport | undefined
      const backgroundMonitor = new QoderBackgroundMonitor(backgroundTasks, () => !stopped && !streamSettled && taskControl?.canStopTask === true, (backgroundWork) => {
        request.emit({
          id: newId(), runId: request.runId, ts: new Date().toISOString(), kind: 'harness',
          stage: 'runtime:background_work', backgroundWork,
          runtimeMetadata: { source: 'qoder_background_observation' }
        })
      })
      const waitForUser = async <T>(action: () => Promise<T>): Promise<T> => {
        backgroundMonitor.pause()
        try { return await action() } finally { backgroundMonitor.resume() }
      }
      const hasPendingBackgroundWork = (): boolean => activeAgentCalls.size > 0 || backgroundTasks.pending
      const ctx: NormalizeCtx = {
        runId: request.runId,
        cwd: request.cwd,
        newId,
        now: () => new Date().toISOString(),
        contextTokensFromUsage: qoderContextTokensFromUsage
      }
      const observeAgentEvent = (event: TraceEvent, hasTerminalEvidence = true): void => {
        if (!event.toolUseId || terminalAgentCalls.has(event.toolUseId)) return
        const status = observedAgentStatus(event)
        if (event.stage === 'agent_activity' || isAgentLaunchStatus(status)) {
          activeAgentCalls.add(event.toolUseId)
          return
        }
        if (event.tool === 'Agent' && event.stage === 'tool_result' && isAgentTerminalStatus(status)) {
          activeAgentCalls.delete(event.toolUseId)
          terminalAgentCalls.add(event.toolUseId)
          if (hasTerminalEvidence) backgroundTasks.settleCall(event.toolUseId, 'Agent')
        }
      }
      const emitAgentFallback = (event: TraceEvent, hasTerminalEvidence: boolean): void => {
        if (!event.toolUseId || terminalAgentCalls.has(event.toolUseId)) return
        observeAgentEvent(event, hasTerminalEvidence)
        request.emit(event)
      }
      const settleUnreportedAgents = (agentStatus: 'failed' | 'stopped', source: string): void => {
        for (const toolUseId of activeAgentCalls) {
          emitAgentFallback({
            id: `qoder-fallback:agent:${request.runId}:${toolUseId}:${agentStatus}`,
            runId: request.runId,
            ts: new Date().toISOString(),
            kind: 'tool',
            stage: 'tool_result',
            tool: 'Agent',
            toolUseId,
            text: agentStatus === 'stopped' ? '后台 Agent 已停止' : '后台 Agent 在 Qoder 结束前未返回终态',
            output: agentStatus === 'stopped' ? '后台 Agent 已停止' : '后台 Agent 在 Qoder 结束前未返回终态',
            isError: agentStatus === 'failed',
            runtimeMetadata: { source, agentStatus }
          }, false)
        }
      }
      const promise: Promise<ProviderRunResult> = (async () => {
        const forkBaseline = new Set<string>()
        if (request.resume) {
          try {
            for (const message of await getSessionMessages(request.resume, { dir: request.cwd, includeSystemMessages: true })) {
              if (message.uuid) forkBaseline.add(message.uuid)
            }
          } catch {
            // Fork identity is optional for this turn; the Provider run itself must remain usable.
          }
        }
        const providerPrompt = request.cwd && projectCommandMatch(request.prompt)
          ? await expandQoderProjectCommand(request.prompt, request.cwd)
          : request.prompt
        const prompt = livePrompt(providerPrompt)
        releaseProviderPrompt = prompt.release
        q = query({
          // Keep control-response stdin open while Qoder-owned Agents or Bash
          // tasks are active, including model-policy requests on notification turns.
          prompt: prompt.stream,
          options: {
            transport: {
              create(options: QueryTransportCreateOptions) {
                taskControl = new QoderTaskControlTransport(new ProcessTransport(options))
                return taskControl
              }
            },
            ...qoderOptions(
              request.cwd,
              request.resume,
              (pid, identity) => { qoderPid = pid; qoderIdentity = identity },
              (code, signal) => {
                if (stopped || streamSettled) return
                exitTimer = setTimeout(() => {
                  rejectUnexpectedExit(new Error(`Qoder CLI 已退出，但 SDK 事件流未结束（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`))
                }, 1000)
              },
              request.permissionMode,
              request.managedRecorder === true,
              request.mcpExecution,
              request.managedRecorderIdentity
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
                      const response = await waitForUser(() => request.requestUserInput!(question, permission.signal))
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
                    const response = await waitForUser(() => request.requestUserInput!(question, permission.signal))
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
                  request.recordNative?.(typeof raw.type === 'string' ? raw.type : 'unknown', raw)
                  credits.observe(raw)
                  backgroundTasks.observe(raw)
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
                  let contextEvidence: QoderContextEvidence | undefined
                  if (raw.type === 'result' && !hasPendingBackgroundWork() && typeof q!.getContextUsage === 'function') {
                    contextEvidence = await qoderLiveContext(q!)
                  }
                  for (const rawEvent of normalizeQoderMessage(message, ctx)) {
                    const event = qoderTrace(rawEvent, contextEvidence)
                    // Qoder flushes queued progress and duplicate terminals at query
                    // end. A settled Agent must not reopen in either host state or UI.
                    if (event.tool === 'Agent' && event.toolUseId && terminalAgentCalls.has(event.toolUseId) &&
                        (event.stage === 'agent_activity' || event.stage === 'tool_result')) continue
                    observeAgentEvent(event)
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
                  // A launch result is not terminal while background work remains.
                  // Release only on the root result following the last notification.
                  backgroundMonitor.observe(raw, hasPendingBackgroundWork())
                  if (raw.type === 'result' && !hasPendingBackgroundWork()) releaseProviderPrompt()
                }
              })(),
              unexpectedExit
            ])
          } catch (error) {
            if (!providerFailureSeen) terminalError = error
          }
        } finally {
          request.emit({
            id: `credits:${request.runId}`, runId: request.runId, ts: new Date().toISOString(),
            kind: 'harness', stage: 'credit_usage', runtimeProvider: 'qoder_cli',
            creditUsage: credits.evidence()
          })
          streamSettled = true
          // Stop diagnostics/controls now, but converge native log terminals before
          // publishing the final snapshot. Host interruption is not task evidence.
          backgroundMonitor.pause()
          releaseProviderPrompt()
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
            for (const event of backgroundFailures) {
              if (event.toolUseId) backgroundTasks.settleCall(event.toolUseId, 'Bash')
              request.emit(event)
            }
            if (backgroundFailures.length > 0) providerStatus = 'failed'
            const subagentTerminals = parseQoderSubagentTerminals(request.runId, log, externalSessionId)
            const missingSubagentTerminals = subagentTerminals.filter(
              (event) => event.toolUseId && !terminalAgentCalls.has(event.toolUseId)
            )
            for (const event of missingSubagentTerminals) emitAgentFallback(event, true)
            if (!stopped && missingSubagentTerminals.some((event) => observedAgentStatus(event) !== 'completed')) {
              providerStatus = 'failed'
            }
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
        if (backgroundTasks.pending && !stopped) {
          providerStatus = 'failed'
          request.emit({
            id: newId(), runId: request.runId, ts: new Date().toISOString(), kind: 'harness',
            stage: 'runtime:background_unresolved',
            text: 'Qoder 连接已结束，但后台任务未返回终态；任务完成情况未知，请先核验文件，勿直接重试写入。',
            runtimeMetadata: { source: 'qoder_transport_ended', pendingTaskIds: backgroundTasks.tasks.map((task) => task.taskId) }
          })
        }
        if (activeAgentCalls.size > 0) {
          if (stopped) {
            settleUnreportedAgents('stopped', 'qoder_host_interruption')
          } else {
            settleUnreportedAgents('failed', 'qoder_transport_ended')
            providerStatus = 'failed'
          }
        }
        backgroundMonitor.dispose()
        if (externalSessionId) {
          try {
            const messages = await getSessionMessages(externalSessionId, { dir: request.cwd, includeSystemMessages: true })
            const candidates = messages.filter((message) =>
              isTranscriptUserPrompt(message) && !forkBaseline.has(message.uuid)
            )
            if (candidates.length === 1) forkTurnId = candidates[0].uuid
          } catch {
            // The completed turn remains valid even when its optional fork identity is unavailable.
          }
        }
        if (terminalError != null) throw terminalError
        return {
          externalSessionId,
          providerTurnId: currentProviderTurnId(),
          forkTurnId,
          stopped,
          status: stopped ? 'interrupted' : providerStatus,
          mcp: statuses ? qoderMcpSnapshot(statuses) : undefined
        }
      })()
      const interrupt = (): void => {
        stopped = true
        backgroundMonitor.pause()
        releaseProviderPrompt()
        controller.abort()
        void q?.interrupt().catch(() => {})
      }
      return {
        promise,
        stopBackgroundTask: async (taskId) => {
          const task = backgroundTasks.tasks.find((task) => task.taskId === taskId)
          if (stopped || streamSettled || !task || task.stopState) {
            return { status: 'rejected', message: '该任务不属于当前活动轮次、已结束或已请求停止。' }
          }
          if (!taskControl?.canStopTask) return { status: 'unavailable', message: '当前 Qoder 版本不支持已验证的单任务停止，请使用停止本轮。' }
          backgroundTasks.markStop(taskId, 'requested')
          backgroundMonitor.refresh()
          const result = await taskControl.stopTask(taskId)
          backgroundTasks.markStop(taskId, result.status === 'unknown' ? 'unconfirmed' : result.status === 'requested' ? 'requested' : undefined)
          backgroundMonitor.refresh()
          return result
        },
        interrupt,
        forceKill: () => signalProcessTree(qoderIdentity, 'SIGKILL'),
        // qoderPid 是本轮 spawn 的 CLI 进程树：硬杀不会波及其他 run。
        forceKillScope: 'run_scoped',
        getExternalSessionId: () => externalSessionId,
        getProviderTurnId: currentProviderTurnId,
        getForkTurnId: () => forkTurnId
      }
    },
    sessionEvidence: {
      async enrich(context, turns) {
        if (!context.externalSessionId) return turns
        try {
          const messages = await getSessionMessages(context.externalSessionId, {
            dir: context.cwd,
            includeSystemMessages: true
          })
          return enrichQoderHistory(turns, messages)
        } catch {
          return turns
        }
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
    async invalidateContext(context) {
      const key = context.cwd ?? ''
      contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1)
      skillCache.delete(key)
      commandCache.delete(key)
      modelCache.delete(key)
      const refresh = refreshingControls.get(key)
      if (refresh) {
        refresh.invalidated = true
        void closeControl(key, refresh.session, 'cancel').catch(recordControlCloseFailure)
        let failure: unknown
        try {
          await refresh.promise
        } catch (error) {
          failure = error
        }
        const replacement = controls.get(key)
        if (replacement) await closeControl(key, replacement, 'cancel')
        else await waitForControlClose(key)
        if (refreshingControls.get(key) === refresh) refreshingControls.delete(key)
        if (failure) throw failure
        return
      }
      const control = controls.get(key)
      if (control) await closeControl(key, control, 'cancel')
      else await waitForControlClose(key)
    },
    skills: {
      list: async (context) => {
        try {
          const key = context.cwd ?? ''
          const generation = contextGenerations.get(key) ?? 0
          let value = skillCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            const result = await withControl(context, async (q, initialized) => {
              const [usage, commands] = await Promise.all([q.getContextUsage(), q.supportedCommands()])
              const catalog = qoderSkillCatalog(initialized, usage, commands)
              return {
                data: catalog.skills.map((skill) => ({
                  name: skill.name,
                  dir: skill.location,
                  scope: qoderSkillScope(skill.source),
                  description: skill.description,
                  enabled: true
                })),
                total: catalog.total,
                included: catalog.included
              }
            })
            const catalog = result.value
            value = { data: catalog, observedAt: result.initializedAt }
            if (
              (contextGenerations.get(key) ?? 0) === generation &&
              controls.get(key) === result.session &&
              !result.session.retired
            ) {
              skillCache.delete(key)
              skillCache.set(key, value)
              while (skillCache.size > 16) {
                const oldest = skillCache.keys().next().value
                if (oldest === undefined) break
                skillCache.delete(oldest)
              }
            }
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
          const generation = contextGenerations.get(key) ?? 0
          let value = commandCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            const result = await withControl(context, async (q, initialized) => {
              const commands = await q.supportedCommands()
              try {
                const catalog = qoderSkillCatalog(initialized, await q.getContextUsage(), commands)
                return {
                  commands,
                  skillNames: new Set(catalog.skills.map((skill) => skill.name)),
                  ...(catalog.included < catalog.total
                    ? { reason: `Qoder 仅返回 ${catalog.included}/${catalog.total} 个已加载 Skill，其他命令来源保持未知` }
                    : {})
                }
              } catch (error) {
                const initializedCatalog = qoderSkillCatalog(initialized, undefined, commands)
                return {
                  commands,
                  skillNames: new Set(initializedCatalog.skills.map((skill) => skill.name)),
                  reason: `Qoder Skill catalog 读取失败，命令来源按初始化证据分类：${String((error as Error).message)}`
                }
              }
            })
            value = { data: result.value, observedAt: result.initializedAt }
            if (
              (contextGenerations.get(key) ?? 0) === generation &&
              controls.get(key) === result.session &&
              !result.session.retired
            ) {
              commandCache.delete(key)
              commandCache.set(key, value)
              while (commandCache.size > 16) {
                const oldest = commandCache.keys().next().value
                if (oldest === undefined) break
                commandCache.delete(oldest)
              }
            }
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
    runControls: {
      read: async (context) => {
        try {
          const key = context.cwd ?? ''
          const generation = contextGenerations.get(key) ?? 0
          let value = modelCache.get(key)
          if (!value || Date.now() - value.observedAt >= PROBE_TTL_MS) {
            const result = await withControl(context, (q) =>
              q.getAvailableModels({ fetchStrategy: 'live' }),
              { requireFreshInitialization: false }
            )
            value = {
              observedAt: Date.now(),
              data: {
                models: result.value
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
                permissions: permissionOptions({ autoAcceptEdits: true, autoReview: true })
              }
            }
            if (
              (contextGenerations.get(key) ?? 0) === generation &&
              controls.get(key) === result.session &&
              !result.session.retired
            ) {
              modelCache.delete(key)
              modelCache.set(key, value)
              while (modelCache.size > 16) {
                const oldest = modelCache.keys().next().value
                if (oldest === undefined) break
                modelCache.delete(oldest)
              }
            }
          }
          return capabilityReady(context, 'read', value.data, value.observedAt)
        } catch (error) {
          return {
            ...capabilityReady(context, 'read', { models: [], permissions: permissionOptions({ autoAcceptEdits: true, autoReview: true }) }),
            state: 'degraded' as const,
            reason: String((error as Error).message)
          }
        }
      }
    },
    dispose: () => {
      if (disposePromise) return disposePromise
      disposed = true
      disposePromise = (async () => {
        const sessions = [...ownedControls]
        const closes = sessions.map((session) => closeControl(session.key, session, 'cancel'))
        const results = await Promise.allSettled(closes)
        skillCache.clear()
        commandCache.clear()
        modelCache.clear()
        contextGenerations.clear()
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure) throw failure.reason
      })()
      return disposePromise
    }
  }
}
