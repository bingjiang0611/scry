import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import {
  capabilityReady,
  capabilityUnknown,
  type McpSnapshot,
  type ProviderContext,
  type SkillMeta
} from '../../shared/provider'
import type { BillingProvider } from '../../shared/billing'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  classifyRunTermination,
  normalizeAgentQuestionRequest,
  type AgentPermissionMode,
  type AgentRunControlCatalog
} from '../../shared/runtime'
import {
  classifyTool,
  fileOpOf,
  mcpPayloadFailed,
  parseMcp,
  type ModelUsageRow,
  type ParsedMcp,
  type TraceEvent
} from '../../shared/trace'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'
import { resolveRuntimeCliBin, shellEnv } from '../claude-locate'
import { AgentRuntimeError } from '../cli-runtime'
import { isRemoteMcpConfig, listProviderMcp } from '../mcp-config'
import {
  OpenCodeServerManager,
  OpenCodeProjectPluginSecurityError,
  openCodeHookTraceCursor,
  readOpenCodeHookTrace,
  sanitizeOpenCodeServerLog,
  type OpenCodeHookTraceRecord,
  type OpenCodeServerState
} from './opencode-server'
import { effortOption, permissionOptions } from './run-controls'
import type { AuthorizedMcpExecution, ProviderAdapter, ProviderRunRequest } from './types'
import type { OpenCodeProjectPluginAuthorization } from '../opencode-plugin-trust'
import { sanitizeMcpAuthError } from './mcp-auth-security'

let counter = 0
const OPEN_CODE_MCP_AUTH_TIMEOUT_MS = 120_000
const OPEN_CODE_MCP_VERIFY_TIMEOUT_MS = 15_000
const newEvent = (
  runId: string,
  fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>,
  ts = new Date().toISOString()
): TraceEvent => ({
  id: `opencode-${Date.now().toString(36)}-${(counter++).toString(36)}`,
  runId,
  ts,
  ...fields
})

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

interface OpenCodeEventState {
  starts: Set<string>
  results: Set<string>
  compactions: Set<string>
  hookResults: Set<string>
  mcpByToolUseId: Map<string, ParsedMcp>
  toolStartedAt: Map<string, number>
  streamedTextByMessageId: Map<string, string>
  clearedTextMessageIds: Set<string>
  messages: Map<string, Record<string, unknown>>
}

const eventStates = new WeakMap<ProviderRunRequest, OpenCodeEventState>()

const eventState = (request: ProviderRunRequest): OpenCodeEventState => {
  const existing = eventStates.get(request)
  if (existing) return existing
  const created = {
    starts: new Set<string>(),
    results: new Set<string>(),
    compactions: new Set<string>(),
    hookResults: new Set<string>(),
    mcpByToolUseId: new Map<string, ParsedMcp>(),
    toolStartedAt: new Map<string, number>(),
    streamedTextByMessageId: new Map<string, string>(),
    clearedTextMessageIds: new Set<string>(),
    messages: new Map<string, Record<string, unknown>>()
  }
  eventStates.set(request, created)
  return created
}

const canonicalExistingPath = async (path: string): Promise<string | undefined> => {
  if (!isAbsolute(path)) return undefined
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

const pathInside = (root: string, candidate: string): boolean => {
  const suffix = relative(root, candidate)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

export async function openCodeSkillScope(
  cwd: string,
  location: string,
  homeDir = homedir()
): Promise<'project' | 'user' | 'unknown'> {
  const [canonicalCwd, canonicalLocation, canonicalHome] = await Promise.all([
    canonicalExistingPath(cwd),
    canonicalExistingPath(location),
    canonicalExistingPath(homeDir)
  ])
  if (!canonicalLocation) return 'unknown'
  if (canonicalCwd && pathInside(canonicalCwd, canonicalLocation)) return 'project'
  if (canonicalHome && pathInside(canonicalHome, canonicalLocation)) return 'user'
  return 'unknown'
}

export function emitOpenCodeHookEvents(
  request: ProviderRunRequest,
  records: OpenCodeHookTraceRecord[],
  sessionId: string,
  tracePath: string
): void {
  const state = eventState(request)
  const pending = new Map<string, OpenCodeHookTraceRecord>()
  const invalid = new Set<string>()
  const completed = new Set<string>()
  const pairs = new Map<string, { start: OpenCodeHookTraceRecord; response: OpenCodeHookTraceRecord }>()
  for (const record of records) {
    if (record.sessionId !== sessionId) continue
    const key = `${record.sessionId}\0${record.callId}\0${record.tool}`
    if (invalid.has(key) || state.hookResults.has(key)) continue
    if (completed.has(key)) {
      completed.delete(key)
      pairs.delete(key)
      invalid.add(key)
      continue
    }
    if (record.stage === 'hook_started') {
      if (!pending.has(key)) pending.set(key, record)
      else {
        pending.delete(key)
        invalid.add(key)
      }
      continue
    }
    const start = pending.get(key)
    if (!start) {
      invalid.add(key)
      continue
    }
    pending.delete(key)
    completed.add(key)
    pairs.set(key, { start, response: record })
  }
  for (const { start, response } of pairs.values()) {
    const key = `${start.sessionId}\0${start.callId}\0${start.tool}`
    if (invalid.has(key) || state.hookResults.has(key)) continue
    state.hookResults.add(key)
    const hookId = `opencode:${start.sessionId}:${start.callId}`
    request.emit(newEvent(request.runId, {
      kind: 'hook',
      stage: 'hook_started',
      tool: start.tool,
      name: 'ToolExecute',
      hookId,
      hookName: `OpenCode:${start.tool}`,
      hookEvent: 'ToolExecute',
      hookOutcome: 'started',
      toolUseId: start.callId,
      runtimeMetadata: {
        source: 'opencode_native_plugin_hook',
        sourceTracePath: tracePath,
        sourceRecordSha256: start.recordSha256,
        sourceRecordHashBasis: 'jsonl_utf8_with_lf',
        nativeHookEvent: 'tool.execute.before'
      }
    }, start.timestamp))
    request.emit(newEvent(request.runId, {
      kind: 'hook',
      stage: 'hook_response',
      tool: response.tool,
      name: 'ToolExecute',
      hookId,
      hookName: `OpenCode:${response.tool}`,
      hookEvent: 'ToolExecute',
      hookOutcome: 'success',
      toolUseId: response.callId,
      runtimeMetadata: {
        source: 'opencode_native_plugin_hook',
        sourceTracePath: tracePath,
        sourceRecordSha256: response.recordSha256,
        sourceRecordHashBasis: 'jsonl_utf8_with_lf',
        nativeHookEvent: 'tool.execute.after'
      }
    }, response.timestamp))
  }
}

function normalizeOpenCodeTool(rawName: string, rawInput: unknown): {
  toolName: string
  input: Record<string, unknown>
} {
  const source = record(rawInput)
  const input = { ...source }
  if (typeof input.filePath === 'string' && input.file_path === undefined) input.file_path = input.filePath
  const aliases: Record<string, string> = {
    bash: 'Bash', edit: 'Edit', glob: 'Glob', grep: 'Grep', read: 'Read', skill: 'Skill', task: 'Task', write: 'Write'
  }
  if (rawName === 'skill' && typeof input.name === 'string') input.skill = input.name
  return { toolName: aliases[rawName] ?? rawName, input }
}

function errorText(value: unknown): string {
  const item = record(value)
  return String(record(item.data).message ?? item.message ?? JSON.stringify(value))
}

function safeErrorDetail(value: unknown): string | undefined {
  const base = sanitizeOpenCodeServerLog(errorText(value))
  const details: string[] = []
  let current: unknown = value
  for (let depth = 0; depth < 3; depth++) {
    const item = record(current)
    const code = typeof item.code === 'string' ? item.code : undefined
    const message = typeof item.message === 'string' ? item.message : undefined
    const detail = [code, message].filter(Boolean).join(': ')
    if (detail && !details.includes(detail)) details.push(detail)
    current = item.cause
    if (!current) break
  }
  const summary = details.filter((detail) => detail !== base).join(' → ')
  return summary ? sanitizeOpenCodeServerLog(summary).slice(0, 500) : undefined
}

function nestedErrorCode(value: unknown): string | undefined {
  let current: unknown = value
  for (let depth = 0; depth < 3; depth++) {
    const item = record(current)
    if (typeof item.code === 'string' && item.code) return item.code
    current = item.cause
    if (!current) break
  }
  return undefined
}

function requestSummary(result: Record<string, unknown>): { method?: string; path?: string; status?: number } {
  const request = result.request instanceof Request ? result.request : undefined
  const response = result.response instanceof Response ? result.response : undefined
  let path: string | undefined
  if (request) {
    try {
      path = new URL(request.url).pathname.replace(/^(\/session\/)[^/]+/, '$1{sessionId}')
    } catch {
      // The operation name still identifies the request without exposing a malformed raw URL.
    }
  }
  return { method: request?.method, path, status: response?.status }
}

class OpenCodeRequestError extends Error {
  readonly operation: string
  readonly transportFailure: boolean
  readonly transportCode?: string
  readonly method?: string
  readonly path?: string
  readonly status?: number

  constructor(operation: string, result: Record<string, unknown>) {
    const original = result.error
    const base = sanitizeOpenCodeServerLog(errorText(original))
    const cause = safeErrorDetail(original)
    const request = requestSummary(result)
    const requestText = [request.method, request.path].filter(Boolean).join(' ')
    const suffix = [
      cause,
      request.status == null ? requestText : `${requestText} → HTTP ${request.status}`
    ].filter(Boolean).join('；')
    super(`OpenCode ${operation} 请求失败：${base}${suffix ? `（${suffix}）` : ''}`, {
      cause: original instanceof Error ? original : undefined
    })
    this.name = 'OpenCodeRequestError'
    this.operation = operation
    this.transportFailure = result.response == null && original instanceof Error
    this.transportCode = nestedErrorCode(original)
    this.method = request.method
    this.path = request.path
    this.status = request.status
  }
}

async function unwrap<T>(promise: Promise<unknown>, operation: string): Promise<T> {
  const result = record(await promise)
  if (result.error !== undefined) throw new OpenCodeRequestError(operation, result)
  return (result.data === undefined ? result : result.data) as T
}

function openCodeResultTiming(info: Record<string, unknown>): { ts: string; durationMs: number } | undefined {
  const time = record(info.time)
  const created = typeof time.created === 'number' ? time.created : NaN
  const completed = typeof time.completed === 'number' ? time.completed : NaN
  if (!Number.isFinite(created) || !Number.isFinite(completed) || completed < created) return undefined
  try {
    return { ts: new Date(completed).toISOString(), durationMs: completed - created }
  } catch {
    return undefined
  }
}

function openCodeMessageRole(info: Record<string, unknown>): string | undefined {
  if (typeof info.role === 'string') return info.role
  return typeof info.type === 'string' ? info.type : undefined
}

function openCodeMessageId(info: Record<string, unknown>): string | undefined {
  return typeof info.id === 'string' && info.id ? info.id : undefined
}

function openCodeMessageParentId(info: Record<string, unknown>): string | undefined {
  return typeof info.parentID === 'string' && info.parentID ? info.parentID : undefined
}

function openCodeCompletedAt(info: Record<string, unknown>): number | undefined {
  const completed = record(info.time).completed
  return typeof completed === 'number' && Number.isFinite(completed) ? completed : undefined
}

function rememberOpenCodeMessage(state: OpenCodeEventState, info: Record<string, unknown>): void {
  const id = openCodeMessageId(info)
  if (!id) return
  const existing = state.messages.get(id)
  if (existing && openCodeCompletedAt(existing) != null && openCodeCompletedAt(info) == null) return
  state.messages.set(id, info)
}

interface OpenCodeTurnAggregate {
  providerTurnId?: string
  timing?: { ts: string; durationMs: number }
  tokensIn?: number
  tokensOut?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  modelUsage?: ModelUsageRow[]
  messageCount: number
  timingBoundary: 'user_message' | 'assistant_chain' | 'final_message'
  messageCoverage: 'observed_chain' | 'final_message_only'
}

function aggregateOpenCodeTurn(
  finalInfo: Record<string, unknown>,
  observedMessages: Map<string, Record<string, unknown>>
): OpenCodeTurnAggregate {
  const messages = new Map(observedMessages)
  const finalId = openCodeMessageId(finalInfo)
  if (finalId) messages.set(finalId, finalInfo)
  const parentId = openCodeMessageParentId(finalInfo)
  const assistants = parentId
    ? [...messages.values()].filter((info) =>
        openCodeMessageRole(info) === 'assistant' && openCodeMessageParentId(info) === parentId
      )
    : [finalInfo]
  if (finalId && !assistants.some((info) => openCodeMessageId(info) === finalId)) assistants.push(finalInfo)
  assistants.sort((left, right) => {
    const leftCreated = record(left.time).created
    const rightCreated = record(right.time).created
    const leftMs = typeof leftCreated === 'number' && Number.isFinite(leftCreated) ? leftCreated : Number.MAX_SAFE_INTEGER
    const rightMs = typeof rightCreated === 'number' && Number.isFinite(rightCreated) ? rightCreated : Number.MAX_SAFE_INTEGER
    return leftMs - rightMs || String(openCodeMessageId(left) ?? '').localeCompare(String(openCodeMessageId(right) ?? ''))
  })

  let tokensIn = 0
  let tokensOut = 0
  let reasoningTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let hasUsage = false
  let costUsd = 0
  let hasCompleteCost = assistants.length > 0
  const modelRows = new Map<string, ModelUsageRow>()
  const modelCosts = new Map<string, { total: number; complete: boolean }>()
  for (const info of assistants) {
    const tokens = record(info.tokens)
    const cache = record(tokens.cache)
    const input = typeof tokens.input === 'number' && Number.isFinite(tokens.input) ? tokens.input : undefined
    const output = typeof tokens.output === 'number' && Number.isFinite(tokens.output) ? tokens.output : undefined
    const reasoning = typeof tokens.reasoning === 'number' && Number.isFinite(tokens.reasoning) ? tokens.reasoning : undefined
    const cacheRead = typeof cache.read === 'number' && Number.isFinite(cache.read) ? cache.read : undefined
    const cacheWrite = typeof cache.write === 'number' && Number.isFinite(cache.write) ? cache.write : undefined
    if ([input, output, reasoning, cacheRead, cacheWrite].some((value) => value != null)) {
      hasUsage = true
      tokensIn += input ?? 0
      tokensOut += output ?? 0
      reasoningTokens += reasoning ?? 0
      cacheReadTokens += cacheRead ?? 0
      cacheCreationTokens += cacheWrite ?? 0
    }
    const cost = typeof info.cost === 'number' && Number.isFinite(info.cost) ? info.cost : undefined
    if (cost == null) hasCompleteCost = false
    else costUsd += cost

    const model = typeof info.modelID === 'string' && info.modelID ? info.modelID : undefined
    if (!model) continue
    const upstream = typeof info.providerID === 'string' ? info.providerID : ''
    const key = `${upstream}\0${model}`
    const current = modelRows.get(key) ?? {
      model,
      billingProvider: billingProvider(upstream),
      upstreamProvider: upstream || undefined,
      usageSource: 'opencode_turn_messages'
    }
    current.inputTokens = (current.inputTokens ?? 0) + (input ?? 0)
    current.outputTokens = (current.outputTokens ?? 0) + (output ?? 0)
    current.reasoningTokens = (current.reasoningTokens ?? 0) + (reasoning ?? 0)
    current.cacheReadTokens = (current.cacheReadTokens ?? 0) + (cacheRead ?? 0)
    current.cacheCreationTokens = (current.cacheCreationTokens ?? 0) + (cacheWrite ?? 0)
    modelRows.set(key, current)
    const modelCost = modelCosts.get(key) ?? { total: 0, complete: true }
    if (cost == null) modelCost.complete = false
    else modelCost.total += cost
    modelCosts.set(key, modelCost)
  }
  for (const [key, row] of modelRows) {
    const cost = modelCosts.get(key)
    if (cost?.complete) {
      row.costUsd = cost.total
      row.costSource = 'provider_reported'
      row.costConfidence = 'provider_reported'
      row.costUnit = 'usd'
    }
  }

  const completed = assistants
    .map((info) => openCodeCompletedAt(info))
    .filter((value): value is number => value != null)
  const created = assistants
    .map((info) => record(info.time).created)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const userInfo = parentId ? messages.get(parentId) : undefined
  const userCreated = userInfo && openCodeMessageRole(userInfo) === 'user'
    ? record(userInfo.time).created
    : undefined
  const startedAt = typeof userCreated === 'number' && Number.isFinite(userCreated)
    ? userCreated
    : created.length > 0
      ? Math.min(...created)
      : undefined
  const completedAt = completed.length > 0 ? Math.max(...completed) : undefined
  const timing = startedAt != null && completedAt != null && completedAt >= startedAt
    ? { ts: new Date(completedAt).toISOString(), durationMs: completedAt - startedAt }
    : openCodeResultTiming(finalInfo)
  const timingBoundary: OpenCodeTurnAggregate['timingBoundary'] =
    typeof userCreated === 'number' && Number.isFinite(userCreated)
      ? 'user_message'
      : assistants.length > 1
        ? 'assistant_chain'
        : 'final_message'

  return {
    providerTurnId: parentId ?? finalId,
    timing,
    tokensIn: hasUsage ? tokensIn : undefined,
    tokensOut: hasUsage ? tokensOut : undefined,
    reasoningTokens: hasUsage ? reasoningTokens : undefined,
    cacheReadTokens: hasUsage ? cacheReadTokens : undefined,
    cacheCreationTokens: hasUsage ? cacheCreationTokens : undefined,
    costUsd: hasCompleteCost ? costUsd : undefined,
    modelUsage: modelRows.size > 0 ? [...modelRows.values()] : undefined,
    messageCount: assistants.length,
    timingBoundary,
    messageCoverage: parentId && (messages.has(parentId) || assistants.length > 1)
      ? 'observed_chain'
      : 'final_message_only'
  }
}

function emitOpenCodeResponseParts(
  request: ProviderRunRequest,
  parts: unknown[],
  messageId: string | undefined
): void {
  const textByMessage = new Map<string | undefined, string[]>()
  for (const rawPart of parts) {
    const part = record(rawPart)
    if (part.type !== 'text' || part.ignored === true || typeof part.text !== 'string' || !part.text) continue
    const partMessageId = typeof part.messageID === 'string' ? part.messageID : messageId
    const text = textByMessage.get(partMessageId) ?? []
    text.push(part.text)
    textByMessage.set(partMessageId, text)
  }
  for (const [partMessageId, textParts] of textByMessage) {
    const text = textParts.join('')
    const streamed = partMessageId ? eventState(request).streamedTextByMessageId.get(partMessageId) : undefined
    if (streamed === text) continue
    request.emit(newEvent(request.runId, {
      kind: 'model',
      stage: 'text',
      text,
      messageId: partMessageId,
      runtimeMetadata: {
        source: 'opencode_response_parts',
        ...(streamed === undefined ? {} : { replacesStreamedText: true })
      }
    }))
  }
  if (textByMessage.size === 0 && messageId && eventState(request).streamedTextByMessageId.has(messageId)) {
    request.emit(newEvent(request.runId, {
      kind: 'model',
      stage: 'text',
      text: '',
      messageId,
      runtimeMetadata: { source: 'opencode_response_parts', replacesStreamedText: true }
    }))
  }
}

function emitOpenCodeTurnResponseParts(
  request: ProviderRunRequest,
  rows: Array<{ info?: unknown; parts?: unknown }> | undefined,
  finalInfo: Record<string, unknown>,
  finalParts: unknown[]
): void {
  const parentId = openCodeMessageParentId(finalInfo)
  const finalId = openCodeMessageId(finalInfo)
  if (!rows || !parentId) {
    emitOpenCodeResponseParts(request, finalParts, finalId)
    return
  }
  const assistants = rows
    .map((row) => ({ info: record(row.info), parts: Array.isArray(row.parts) ? row.parts : [] }))
    .filter(({ info }) => openCodeMessageRole(info) === 'assistant' && openCodeMessageParentId(info) === parentId)
    .sort((left, right) => {
      const leftTime = record(left.info.time)
      const rightTime = record(right.info.time)
      const leftCreated = typeof leftTime.created === 'number' ? leftTime.created : Number.POSITIVE_INFINITY
      const rightCreated = typeof rightTime.created === 'number' ? rightTime.created : Number.POSITIVE_INFINITY
      return leftCreated - rightCreated || String(openCodeMessageId(left.info) ?? '').localeCompare(String(openCodeMessageId(right.info) ?? ''))
    })
  let emittedFinal = false
  for (const assistant of assistants) {
    const messageId = openCodeMessageId(assistant.info)
    const parts = assistant.parts.length > 0 || messageId !== finalId ? assistant.parts : finalParts
    if (parts.length === 0 && !eventState(request).streamedTextByMessageId.has(messageId ?? '')) continue
    emitOpenCodeResponseParts(request, parts, messageId)
    if (messageId === finalId) emittedFinal = true
  }
  if (!emittedFinal) emitOpenCodeResponseParts(request, finalParts, finalId)
}

function abortableSseSleep(signal: AbortSignal): (delayMs: number) => Promise<void> {
  return (delayMs) => new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', done)
      resolve()
    }
    timeout = setTimeout(done, delayMs)
    signal.addEventListener('abort', done, { once: true })
  })
}

function normalizeOpenCodeRunError(
  error: unknown,
  cwd: string | undefined,
  manager: OpenCodeServerManager | undefined
): Error {
  if (!(error instanceof OpenCodeRequestError) || !error.transportFailure) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const diagnostic = manager?.diagnostic ?? { running: false }
  const exit = diagnostic.lastExit && !diagnostic.lastExit.expected
    ? diagnostic.lastExit
    : undefined
  const exitText = exit
    ? `；本地 server 已退出（${exit.code ?? exit.signal ?? 'unknown'}）`
    : diagnostic.running
      ? `；本地 server pid=${diagnostic.pid ?? 'unknown'} 仍在运行`
      : '；本地 server 当前不在运行'
  const normalized = new AgentRuntimeError(`${error.message}${exitText}`, {
    provider: 'opencode_server',
    stage: 'protocol',
    commandSummary: error.operation,
    cwd,
    transportCode: error.transportCode,
    requestMethod: error.method,
    requestPath: error.path,
    httpStatus: error.status,
    ...(exit ? { exitCode: exit.code, signal: exit.signal } : {}),
    nextAction: 'Scry 已尝试终止当前 OpenCode 会话；确认没有后台运行后再重试。若重复出现，请查看 Provider 健康状态中的 cause/exit 信息'
  })
  Object.defineProperty(normalized, 'cause', { value: error, configurable: true })
  return normalized
}

function billingProvider(providerId: string): BillingProvider | undefined {
  if (providerId === 'anthropic' || providerId === 'openai' || providerId === 'openrouter' || providerId === 'gemini') return providerId
  if (providerId === 'google') return 'gemini'
  if (providerId === 'opencode') return 'opencode'
  return undefined
}

export function openCodePermissionRules(mode: AgentPermissionMode | undefined): Array<{
  permission: string
  pattern: string
  action: 'allow' | 'ask'
}> {
  if (mode === 'full_access') return [{ permission: '*', pattern: '*', action: 'allow' }]
  if (mode === 'auto_review') throw new Error('OpenCode 不支持自动审查权限模式')
  return [{ permission: '*', pattern: '*', action: 'ask' }]
}

export async function handleOpenCodePermission(
  request: ProviderRunRequest,
  client: OpencodeClient,
  raw: unknown,
  sessionId: string,
  signal = new AbortController().signal
): Promise<boolean> {
  const event = record(raw)
  const versioned = event.type === 'permission.v2.asked'
  if (!versioned && event.type !== 'permission.asked') return false
  const payload = record(event.properties ?? event.data)
  if (payload.sessionID !== sessionId) return false
  const requestId = String(payload.id ?? '')
  if (!requestId) return false
  const operation = String(payload.permission ?? payload.action ?? '操作')
  const resources = payload.patterns ?? payload.resources
  const patterns = Array.isArray(resources) ? resources.map(String).join('、') : ''
  const question = agentPermissionQuestion(
    request.runId,
    `opencode:${requestId}`,
    'OpenCode 权限',
    `是否允许 ${operation}？`,
    patterns || 'OpenCode 请求执行此操作',
    true,
    `opencode:${String(event.type)}`
  )
  const response = request.requestUserInput
    ? await request.requestUserInput(question, signal)
    : { runId: request.runId, questionId: question.questionId, behavior: 'cancelled' as const }
  const decision = agentPermissionDecision(question, response)
  const reply = decision === 'once' ? 'once' : decision === 'session' ? 'always' : 'reject'
  if (versioned) {
    await unwrap(
      client.v2.session.permission.reply({ sessionID: sessionId, requestID: requestId, reply }),
      'permission.reply'
    )
  } else {
    await unwrap(
      client.permission.reply({ requestID: requestId, directory: request.cwd, reply }),
      'permission.reply'
    )
  }
  return true
}

function openCodeAnswers(question: NonNullable<ReturnType<typeof normalizeAgentQuestionRequest>>, answers: Record<string, string>): string[][] {
  return question.questions.map((prompt) => {
    const answer = answers[prompt.question]
    return prompt.multiSelect ? answer.split(', ').filter(Boolean) : [answer]
  })
}

export async function handleOpenCodeQuestion(
  request: ProviderRunRequest,
  client: OpencodeClient,
  raw: unknown,
  sessionId: string,
  signal = new AbortController().signal
): Promise<boolean> {
  const event = record(raw)
  const versioned = event.type === 'question.v2.asked'
  if (!versioned && event.type !== 'question.asked') return false
  const payload = record(event.properties ?? event.data)
  if (payload.sessionID !== sessionId) return false
  const requestId = String(payload.id ?? '')
  const questions = Array.isArray(payload.questions) ? payload.questions.map(record) : []
  const tool = record(payload.tool)
  if (!requestId) return false
  const question = normalizeAgentQuestionRequest(
    request.runId,
    String(tool.callID ?? `opencode:question:${requestId}`),
    {
      questions: questions.map((candidate) => ({
        header: candidate.header,
        question: candidate.question,
        options: Array.isArray(candidate.options) ? candidate.options : [],
        multiSelect: candidate.multiple === true
      }))
    },
    undefined,
    `opencode:${String(event.type)}`,
    true
  )
  const response = question && request.requestUserInput
    ? await request.requestUserInput(question, signal)
    : null
  if (!question || !response || response.behavior === 'cancelled') {
    if (versioned) {
      await unwrap(client.v2.session.question.reject({ sessionID: sessionId, requestID: requestId }), 'question.reject')
    } else {
      await unwrap(client.question.reject({ requestID: requestId, directory: request.cwd }), 'question.reject')
    }
    return true
  }
  const answers = openCodeAnswers(question, response.answers)
  if (versioned) {
    await unwrap(
      client.v2.session.question.reply({
        sessionID: sessionId,
        requestID: requestId,
        questionV2Reply: { answers }
      }),
      'question.reply'
    )
  } else {
    await unwrap(client.question.reply({ requestID: requestId, directory: request.cwd, answers }), 'question.reply')
  }
  return true
}

export function openCodeRunControlCatalog(data: unknown[]): AgentRunControlCatalog {
  return {
    models: data.map((raw) => {
      const model = record(raw)
      const efforts = Array.isArray(model.variants)
        ? model.variants
            .map((variant) => record(variant))
            .filter((variant) => typeof variant.id === 'string')
            .map((variant) => effortOption(String(variant.id), undefined, variant.id === record(model.request).variant))
        : []
      return {
        model: {
          id: String(model.id ?? ''),
          providerId: String(model.providerID ?? '')
        },
        label: `${String(model.name ?? model.id ?? '')} · ${String(model.providerID ?? '')}`,
        efforts
      }
    }).filter((model) => model.model.id && model.model.providerId),
    permissions: permissionOptions(false)
  }
}

export function emitOpenCodeEvent(request: ProviderRunRequest, raw: unknown, sessionId: string): void {
  const event = record(raw)
  const payload = record(event.properties ?? event.data)
  if (payload.sessionID !== sessionId) return
  const type = String(event.type ?? '')
  if (type === 'message.updated') {
    rememberOpenCodeMessage(eventState(request), record(payload.info))
    return
  }
  if (type === 'message.removed') {
    const messageId = String(payload.messageID ?? '')
    if (messageId) {
      const state = eventState(request)
      state.messages.delete(messageId)
      state.streamedTextByMessageId.delete(messageId)
      state.clearedTextMessageIds.add(messageId)
      request.emit(newEvent(request.runId, {
        kind: 'model',
        stage: 'text',
        text: '',
        messageId,
        runtimeMetadata: { source: 'opencode_message_removed', replacesStreamedText: true }
      }))
    }
    return
  }
  if (type === 'message.part.removed') {
    const messageId = String(payload.messageID ?? record(payload.part).messageID ?? '')
    if (messageId) {
      const state = eventState(request)
      state.streamedTextByMessageId.delete(messageId)
      state.clearedTextMessageIds.add(messageId)
      request.emit(newEvent(request.runId, {
        kind: 'model',
        stage: 'text',
        text: '',
        messageId,
        runtimeMetadata: { source: 'opencode_message_part_removed', replacesStreamedText: true }
      }))
    }
    return
  }
  if (type === 'session.next.compaction.ended') {
    const providerEventId = String(payload.messageID ?? event.id ?? '')
    if (!providerEventId || eventState(request).compactions.has(providerEventId)) return
    eventState(request).compactions.add(providerEventId)
    const trigger: 'auto' | 'manual' | undefined =
      payload.reason === 'auto' ? 'auto' : payload.reason === 'manual' ? 'manual' : undefined
    const compaction = { ...(trigger ? { trigger } : {}), providerEventId }
    const timestamp = typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)
      ? new Date(payload.timestamp).toISOString()
      : undefined
    request.emit(newEvent(request.runId, {
      kind: 'harness',
      stage: 'context_compaction',
      compaction,
      input: compaction,
      runtimeMetadata: { source: 'opencode_compaction_ended' }
    }, timestamp))
    return
  }
  if (type === 'session.next.text.delta' || (type === 'message.part.delta' && payload.field === 'text')) {
    const messageId = typeof payload.assistantMessageID === 'string'
      ? payload.assistantMessageID
      : typeof payload.messageID === 'string'
        ? payload.messageID
        : undefined
    if (messageId) {
      const state = eventState(request)
      const streamed = state.streamedTextByMessageId.get(messageId) ?? ''
      const text = `${streamed}${String(payload.delta ?? '')}`
      state.streamedTextByMessageId.set(messageId, text)
      if (state.clearedTextMessageIds.has(messageId)) {
        request.emit(newEvent(request.runId, {
          kind: 'model',
          stage: 'text',
          text,
          messageId,
          runtimeMetadata: { source: 'opencode_retry_text', replacesStreamedText: true }
        }))
        return
      }
    }
    request.emit(newEvent(request.runId, {
      kind: 'model',
      stage: 'text_delta',
      text: String(payload.delta ?? ''),
      messageId
    }))
    return
  }
  if (type === 'session.next.reasoning.delta' || (type === 'message.part.delta' && payload.field === 'reasoning')) {
    request.emit(newEvent(request.runId, { kind: 'model', stage: 'thinking', thinking: String(payload.delta ?? '') }))
    return
  }
  const part = type === 'message.part.updated' ? record(payload.part) : payload
  const toolState = record(part.state)
  const toolTime = record(toolState.time)
  const isPartTool = type === 'message.part.updated' && part.type === 'tool'
  const toolUseId = String(part.callID ?? '')
  const messageId = typeof part.messageID === 'string'
    ? part.messageID
    : typeof payload.assistantMessageID === 'string'
      ? payload.assistantMessageID
      : undefined
  const state = eventState(request)
  const eventTimestamp = typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)
    ? payload.timestamp
    : undefined
  const toolStateStart = typeof toolTime.start === 'number' && Number.isFinite(toolTime.start)
    ? toolTime.start
    : undefined
  const nativeStart = toolStateStart ?? state.toolStartedAt.get(toolUseId) ?? eventTimestamp
  const nativeEnd = typeof toolTime.end === 'number' && Number.isFinite(toolTime.end)
    ? toolTime.end
    : eventTimestamp
  const status = String(toolState.status ?? '')
  const isToolStart = type === 'session.next.tool.called' || (isPartTool && ['running', 'completed', 'error'].includes(status))
  if (isToolStart && toolUseId && !eventState(request).starts.has(toolUseId)) {
    eventState(request).starts.add(toolUseId)
    if (nativeStart != null) state.toolStartedAt.set(toolUseId, nativeStart)
    const normalized = normalizeOpenCodeTool(String(part.tool ?? ''), isPartTool ? toolState.input : part.input)
    const { toolName, input } = normalized
    const classified = classifyTool(toolName, input)
    const mcp = parseMcp(toolName, input)
    if (mcp.isMcp) eventState(request).mcpByToolUseId.set(toolUseId, mcp)
    request.emit(newEvent(request.runId, {
      kind: classified.kind,
      stage: `${classified.kind}:${classified.name}`,
      tool: toolName,
      name: classified.name,
      toolUseId,
      messageId,
      input,
      ...mcp,
      ...fileOpOf(toolName, input)
    }, nativeStart == null ? undefined : new Date(nativeStart).toISOString()))
  }
  const isToolResult = type === 'session.next.tool.success' || type === 'session.next.tool.failed' || (isPartTool && ['completed', 'error'].includes(status))
  if (isToolResult && toolUseId && !eventState(request).results.has(toolUseId)) {
    eventState(request).results.add(toolUseId)
    const failed = type.endsWith('failed') || status === 'error'
    const value = isPartTool ? (failed ? toolState.error : toolState.output) : (part.result ?? part.content ?? part.error ?? null)
    const output = typeof value === 'string' ? value : JSON.stringify(value)
    const mcp = eventState(request).mcpByToolUseId.get(toolUseId)
    eventState(request).mcpByToolUseId.delete(toolUseId)
    const normalized = normalizeOpenCodeTool(String(part.tool ?? ''), isPartTool ? toolState.input : part.input)
    request.emit(newEvent(request.runId, {
      kind: 'tool',
      stage: 'tool_result',
      tool: normalized.toolName,
      toolUseId,
      messageId,
      durationMs: nativeStart != null && nativeEnd != null && nativeEnd >= nativeStart
        ? nativeEnd - nativeStart
        : undefined,
      output,
      ...(mcp ?? {}),
      isError: failed || (mcp?.isMcp === true && mcpPayloadFailed(output))
    }, nativeEnd == null ? undefined : new Date(nativeEnd).toISOString()))
    state.toolStartedAt.delete(toolUseId)
  }
}

async function openCodeMcpSnapshot(
  client: OpencodeClient,
  context: ProviderContext,
  configured: McpSnapshot['configured'],
  authenticate: string[]
): Promise<McpSnapshot> {
  const statuses = await unwrap<Record<string, { status?: string; error?: string }>>(
    client.mcp.status({ directory: context.cwd }),
    'mcp.status'
  )
  return {
    configured,
    runtime: Object.entries(statuses).map(([name, status]) => ({
      name,
      status:
        status.status === 'needs_auth'
          ? 'needs-auth'
          : status.status === 'needs_client_registration'
            ? 'needs-client-registration'
          : status.status === 'connected'
            ? 'connected'
            : status.status === 'disabled'
              ? 'disabled'
              : 'failed'
    })),
    operations: { authenticate }
  }
}

function openCodeAuthenticationTargets(execution: AuthorizedMcpExecution | undefined): string[] {
  if (!execution) return []
  const nameCounts = new Map<string, number>()
  for (const target of execution.targets) {
    if (target.enabled) nameCounts.set(target.name, (nameCounts.get(target.name) ?? 0) + 1)
  }
  return execution.targets
    .filter((target) =>
      target.enabled
      && nameCounts.get(target.name) === 1
      && isRemoteMcpConfig(target.config)
      && target.config.oauth !== false
    )
    .map((target) => target.targetId)
}

export function createOpenCodeAdapter(
  homeDir = homedir(),
  privateMcpAuthDirectory?: string,
  sessionStateRoot?: string
): ProviderAdapter {
  const executable = (): string | undefined => process.env.SCRY_OPENCODE_PATH?.trim() || resolveRuntimeCliBin('opencode')
  const managers = new Map<string, OpenCodeServerManager>()
  const managerFor = (cwd: string): OpenCodeServerManager => {
    let manager = managers.get(cwd)
    if (!manager) {
      manager = new OpenCodeServerManager(executable, privateMcpAuthDirectory, {}, sessionStateRoot)
      managers.set(cwd, manager)
    }
    return manager
  }
  let lastOkAt: number | undefined
  let lastErrorAt: number | undefined
  let lastError: string | undefined
  const modelCache = new Map<string, { expiresAt: number; catalog: AgentRunControlCatalog }>()
  const rememberFailure = (error: unknown): void => {
    const message = sanitizeMcpAuthError(error)
    if (message === 'OpenCode 需要工作目录') return
    lastErrorAt = Date.now()
    lastError = message
  }

  const serverFor = async (
    context: ProviderContext,
    mcpExecution?: AuthorizedMcpExecution,
    pluginTrust?: OpenCodeProjectPluginAuthorization
  ): Promise<OpenCodeServerState> => {
    if (!context.cwd) throw new Error('OpenCode 需要工作目录')
    try {
      const state = await managerFor(context.cwd).ensure(context.cwd, mcpExecution, pluginTrust)
      lastOkAt = Date.now()
      lastError = undefined
      return state
    } catch (error) {
      rememberFailure(error)
      if (error instanceof OpenCodeProjectPluginSecurityError) {
        throw new AgentRuntimeError(error.message, {
          provider: 'opencode_server',
          stage: 'capability',
          cwd: context.cwd,
          nextAction: '项目 plugin 声明、内容或授权已变化；请重新发送任务并确认最新 OpenCode plugin 授权'
        })
      }
      throw error
    }
  }
  const clientFor = async (context: ProviderContext, mcpExecution?: AuthorizedMcpExecution): Promise<OpencodeClient> =>
    (await serverFor(context, mcpExecution)).client

  return {
    id: 'opencode',
    runtimeProvider: 'opencode_server',
    describe: async () => {
      const path = executable()
      const current = [...managers.values()].map((manager) => manager.state).find((state) => state != null)
      const unexpectedExit = [...managers.values()]
        .map((manager) => manager.diagnostic.lastExit)
        .filter((exit) => exit && !exit.expected)
        .sort((left, right) => (right?.at ?? 0) - (left?.at ?? 0))[0]
      const exitError = unexpectedExit
        ? `OpenCode 本地 server 已退出（${unexpectedExit.code ?? unexpectedExit.signal ?? 'unknown'}）`
        : undefined
      const healthError = lastError ?? exitError
      const healthErrorAt = lastErrorAt ?? unexpectedExit?.at
      return {
        id: 'opencode',
        label: 'OpenCode',
        runtimeProvider: 'opencode_server',
        transport: 'server SDK',
        available: !!path,
        path,
        capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' },
        health: {
          state: !path ? 'unavailable' : healthError ? 'degraded' : lastOkAt ? 'ready' : 'unknown',
          transport: 'server SDK',
          cwd: current?.cwd,
          pid: current?.pid,
          lastOkAt,
          lastErrorAt: healthErrorAt,
          lastError: healthError
        }
      }
    },
    run: (request) => {
      let externalSessionId = request.resume
      let providerTurnId: string | undefined
      let recordingFailure: { message: string } | undefined
      let stopped = false
      let client: OpencodeClient | undefined
      const permissionController = new AbortController()
      const requestController = new AbortController()
      const eventController = new AbortController()
      const context: ProviderContext = { providerId: 'opencode', cwd: request.cwd, externalSessionId }
      const manager = request.cwd ? managerFor(request.cwd) : undefined
      const promise = (async () => {
        try {
          if (!request.cwd) throw new Error('OpenCode 需要工作目录')
          const server = await serverFor(context, request.mcpExecution, request.openCodePluginTrust)
          client = server.client
          if (stopped) return { externalSessionId, providerTurnId, stopped }
          const permission = openCodePermissionRules(request.permissionMode)
          const model = request.model
            ? {
                providerID: request.model.providerId ?? '',
                modelID: request.model.id
              }
            : undefined
          if (model && !model.providerID) throw new Error('OpenCode 模型缺少 providerId')
          if (!externalSessionId) {
            const session = await unwrap<{ id: string }>(client.session.create({
              directory: request.cwd,
              permission,
              ...(model ? { model: { id: model.modelID, providerID: model.providerID, variant: request.effort } } : {})
            }), 'session.create')
            externalSessionId = session.id
            request.onExternalSessionId?.(session.id)
          } else {
            await unwrap(
              client.session.update({ sessionID: externalSessionId, directory: request.cwd, permission }),
              'session.update'
            )
          }
          if (stopped) {
            await client.session.abort({ sessionID: externalSessionId, directory: request.cwd }).catch(() => {})
            return { externalSessionId, providerTurnId, stopped }
          }
          if (request.managedRecorder) {
            if (!request.cwd || !request.managedRecorderIdentity) {
              throw new Error('OpenCode managed recorder 缺少受信任轮次身份')
            }
            const opened = await handleRecorderHook({
              provider: 'opencode',
              event: 'chat.message',
              workspace: request.cwd,
              managed: true,
              env: {
                ...process.env,
                SCRY_MANAGED_RUN_ID: request.managedRecorderIdentity.runId,
                SCRY_MANAGED_PROMPT_HASH: request.managedRecorderIdentity.promptHash
              },
              payload: {
                session_id: externalSessionId,
                prompt: request.prompt,
                timestamp: new Date().toISOString()
              }
            })
            if (opened.status !== 'started' && opened.status !== 'duplicate') {
              throw new Error(`OpenCode managed recorder 无法建立轮次身份：${opened.reason ?? opened.status}`)
            }
          }
          const hookTracePath = server.hookTracePath
          const hookTraceOffset = await openCodeHookTraceCursor(hookTracePath)
          const eventOptions = {
            signal: eventController.signal,
            // The generated SDK does not expose sseSleepFn in this method's type,
            // but its runtime forwards it to createSseClient. This makes abort
            // interrupt retry backoff instead of waiting up to 30 seconds.
            sseSleepFn: abortableSseSleep(eventController.signal)
          } as unknown as Parameters<typeof client.event.subscribe>[1]
          const subscription = await client.event.subscribe({ directory: request.cwd }, eventOptions)
          const stream = subscription.stream as AsyncGenerator<unknown>
          let observationError: unknown
          const events = (async () => {
            try {
              for await (const event of stream) {
                if (await handleOpenCodePermission(request, client!, event, externalSessionId!, permissionController.signal)) continue
                if (await handleOpenCodeQuestion(request, client!, event, externalSessionId!, permissionController.signal)) continue
                emitOpenCodeEvent(request, event, externalSessionId!)
              }
            } catch (error) {
              if (!stopped && !eventController.signal.aborted) observationError = error
            }
          })()
          const slash = request.prompt.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
          let response: { info: Record<string, unknown>; parts: unknown[] }
          let responseError: unknown
          try {
            response = slash
              ? await unwrap(client.session.command({
                  sessionID: externalSessionId,
                  directory: request.cwd,
                  command: slash[1],
                  arguments: slash[2] ?? '',
                  ...(model ? {
                    model: `${model.providerID}/${model.modelID}`,
                    variant: request.effort
                  } : {})
                }, { signal: requestController.signal }), 'session.command')
              : await unwrap(client.session.prompt({
                  sessionID: externalSessionId,
                  directory: request.cwd,
                  ...(model ? { model, variant: request.effort } : {}),
                  parts: [
                    { type: 'text', text: request.prompt },
                    ...request.attachments.map((attachment) => ({
                      type: 'file' as const,
                      mime: attachment.mimeType,
                      filename: attachment.name,
                      url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`
                    }))
                  ]
                }, { signal: requestController.signal }), 'session.prompt')
          } catch (error) {
            responseError = error
          } finally {
            eventController.abort()
            await events
            if (hookTracePath) {
              try {
                emitOpenCodeHookEvents(
                  request,
                  await readOpenCodeHookTrace(hookTracePath, hookTraceOffset),
                  externalSessionId!,
                  hookTracePath
                )
              } catch (error) {
                observationError ??= error
              }
            }
          }
          if (responseError != null) throw responseError
          const info = record(response!.info)
          providerTurnId = openCodeMessageParentId(info)
          let messageSnapshotStatus: 'complete' | 'bounded' | 'failed' | 'unavailable' = 'unavailable'
          let messageSnapshotRows: Array<{ info?: unknown; parts?: unknown }> | undefined
          if (typeof client.session.messages === 'function') {
            try {
              const rows = await unwrap<Array<{ info?: unknown; parts?: unknown }>>(client.session.messages({
                sessionID: externalSessionId,
                directory: request.cwd,
                limit: 1_000
              }), 'session.messages')
              messageSnapshotRows = rows
              messageSnapshotStatus = rows.length === 1_000 ? 'bounded' : 'complete'
              const state = eventState(request)
              if (messageSnapshotStatus === 'complete') {
                const snapshotMessageIds = new Set(rows.map((row) => openCodeMessageId(record(row.info))).filter(Boolean))
                for (const messageId of state.streamedTextByMessageId.keys()) {
                  if (snapshotMessageIds.has(messageId)) continue
                  request.emit(newEvent(request.runId, {
                    kind: 'model',
                    stage: 'text',
                    text: '',
                    messageId,
                    runtimeMetadata: { source: 'opencode_message_snapshot', replacesStreamedText: true }
                  }))
                  state.streamedTextByMessageId.delete(messageId)
                  state.clearedTextMessageIds.delete(messageId)
                }
                state.messages.clear()
              }
              for (const row of rows) rememberOpenCodeMessage(state, record(row.info))
            } catch (error) {
              messageSnapshotStatus = 'failed'
              observationError ??= error
            }
          }
          const parentId = openCodeMessageParentId(info)
          const snapshotHasParentUser = !!parentId && !!messageSnapshotRows?.some((row) => {
            const candidate = record(row.info)
            return openCodeMessageId(candidate) === parentId && openCodeMessageRole(candidate) === 'user'
          })
          if (request.managedRecorder) {
            if (messageSnapshotStatus !== 'complete') {
              recordingFailure = { message: `OpenCode managed recorder 无法取得完整权威消息快照：${messageSnapshotStatus}` }
            } else if (!parentId) {
              recordingFailure = { message: 'OpenCode managed recorder 缺少权威 user message id' }
            } else if (!snapshotHasParentUser) {
              recordingFailure = { message: 'OpenCode managed recorder 权威消息快照缺少父 user message' }
            }
          }
          const aggregate = aggregateOpenCodeTurn(info, eventState(request).messages)
          providerTurnId = request.managedRecorder ? parentId : aggregate.providerTurnId
          emitOpenCodeTurnResponseParts(
            request,
            messageSnapshotStatus === 'complete' ? messageSnapshotRows : undefined,
            info,
            Array.isArray(response!.parts) ? response!.parts : []
          )
          const aggregateUnavailable =
            messageSnapshotStatus === 'bounded' || messageSnapshotStatus === 'failed' || recordingFailure !== undefined
          const timing = aggregateUnavailable ? undefined : aggregate.timing
          const upstream = String(info.providerID ?? '')
          const sourceProvider = billingProvider(upstream)
          const cost = aggregateUnavailable ? undefined : aggregate.costUsd
          const providerStopReason = typeof info.finish === 'string' && info.finish.trim() ? info.finish.trim() : undefined
          const terminationReason = classifyRunTermination({
            rawReason: providerStopReason,
            message: info.error ? errorText(info.error) : undefined
          })
          request.emit(newEvent(request.runId, {
            kind: 'harness',
            stage: 'result',
            messageId: providerTurnId,
            durationMs: timing?.durationMs,
            tokensIn: aggregateUnavailable ? undefined : aggregate.tokensIn,
            tokensOut: aggregateUnavailable ? undefined : aggregate.tokensOut,
            reasoningTokens: aggregateUnavailable ? undefined : aggregate.reasoningTokens,
            cacheReadTokens: aggregateUnavailable ? undefined : aggregate.cacheReadTokens,
            cacheCreationTokens: aggregateUnavailable ? undefined : aggregate.cacheCreationTokens,
            costUsd: cost,
            costSource: cost === undefined ? undefined : 'provider_reported',
            costConfidence: cost === undefined ? undefined : 'provider_reported',
            costUnit: cost === undefined ? undefined : 'usd',
            billingProvider: sourceProvider,
            upstreamProvider: upstream || undefined,
            usageSource: aggregateUnavailable ? undefined : 'opencode_turn_messages',
            modelUsage: aggregateUnavailable ? undefined : aggregate.modelUsage,
            isError: !!info.error,
            ...(terminationReason ? { terminationReason } : {}),
            ...(providerStopReason ? { providerStopReason } : {}),
            runtimeMetadata: {
              modelProvider: upstream,
              source: 'opencode_server',
              finish: info.finish,
              aggregatedAssistantMessages: aggregate.messageCount,
              messageCoverage: recordingFailure
                ? 'incomplete_snapshot'
                : messageSnapshotStatus === 'bounded'
                  ? 'bounded_snapshot'
                  : messageSnapshotStatus === 'failed'
                    ? 'failed_snapshot'
                    : aggregate.messageCoverage,
              timingBoundary: aggregateUnavailable ? 'unavailable' : aggregate.timingBoundary,
              messageSnapshotStatus,
              observationStatus: observationError == null ? 'complete' : 'partial',
              ...(observationError == null ? {} : {
                observationError: sanitizeOpenCodeServerLog(errorText(observationError)).slice(0, 500)
              })
            }
          }, timing?.ts))
          if (info.error && !stopped) throw new Error(`OpenCode Provider 失败：${errorText(info.error)}`)
          lastOkAt = Date.now()
          lastError = undefined
          return { externalSessionId, providerTurnId, stopped, recordingFailure }
        } catch (error) {
          permissionController.abort()
          requestController.abort()
          eventController.abort()
          if (stopped) return { externalSessionId, providerTurnId, stopped }
          if (client && externalSessionId) {
            await client.session.abort({ sessionID: externalSessionId, directory: request.cwd }).catch(() => {})
          }
          const normalized = normalizeOpenCodeRunError(error, request.cwd, manager)
          rememberFailure(normalized)
          throw normalized
        }
      })()
      const interrupt = (): void => {
        stopped = true
        permissionController.abort()
        requestController.abort()
        eventController.abort()
        if (client && externalSessionId) void client.session.abort({ sessionID: externalSessionId, directory: request.cwd })
      }
      return {
        promise,
        interrupt,
        getExternalSessionId: () => externalSessionId,
        getProviderTurnId: () => providerTurnId,
        getRecordingFailure: () => recordingFailure
      }
    },
    mcp: {
      snapshot: async (context, refresh = false, execution) => {
        const configured = listProviderMcp('opencode', context.cwd, homeDir, shellEnv())
        const operations = { authenticate: openCodeAuthenticationTargets(execution) }
        if (!refresh) {
          return {
            ...capabilityReady(context, 'read', { configured, runtime: null, operations }),
            state: 'degraded',
            reason: '配置已读取；刷新后才会启动隔离 OpenCode server 并读取已授权 MCP 运行状态'
          }
        }
        if (!configured.some((item) => item.enabled)) {
          return capabilityReady(context, 'read', { configured, runtime: [], operations })
        }
        if (!execution) return capabilityUnknown<McpSnapshot>(context, 'read', '缺少已确认的 OpenCode MCP 执行快照')
        try {
          return capabilityReady(context, 'read', await openCodeMcpSnapshot(
            await clientFor(context, execution),
            context,
            configured,
            operations.authenticate
          ))
        } catch (error) {
          rememberFailure(error)
          return capabilityUnknown<McpSnapshot>(context, 'read', sanitizeMcpAuthError(error))
        }
      },
      reauthenticate: async (context, targetId, execution) => {
        const failed = (error: unknown, authenticated = false) => capabilityReady(context, 'read', {
          ok: false,
          status: authenticated ? 'authenticated-unverified' as const : 'failed' as const,
          error: sanitizeMcpAuthError(error)
        })
        if (!context.cwd) return failed('OpenCode 需要工作目录')
        if (!execution) return failed('缺少绑定当前配置快照的 MCP 执行授权')
        if (execution.cwd !== context.cwd) return failed('MCP 执行授权与当前工作目录不匹配')
        const target = execution.targets.find((item) => item.targetId === targetId)
        if (!target) return failed('已确认的 OpenCode MCP 执行快照中不存在该目标')
        if (!target.enabled) return failed(`OpenCode MCP ${target.name} 当前已停用`)
        if (!isRemoteMcpConfig(target.config)) return failed('stdio MCP 不支持 OAuth 重新认证')
        if (target.config.oauth === false) return failed(`OpenCode MCP ${target.name} 已显式停用 OAuth`)
        if (execution.targets.some((item) => item.targetId !== targetId && item.enabled && item.name === target.name)) {
          return failed(`OpenCode 存在多个同名 MCP ${target.name}，无法安全绑定认证目标`)
        }
        const authExecution: AuthorizedMcpExecution = {
          ...execution,
          fingerprint: `${execution.fingerprint}:auth:${target.targetId}`,
          targets: [target]
        }
        const authManager = new OpenCodeServerManager(executable, privateMcpAuthDirectory, {
          completeTargetInventory: false
        })
        let persisted = false
        try {
          const client = (await authManager.ensure(context.cwd, authExecution)).client
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              unwrap(client.mcp.auth.authenticate({ name: target.name, directory: context.cwd }), 'mcp.auth.authenticate'),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  reject(new Error('等待 OpenCode MCP 浏览器认证超时'))
                }, OPEN_CODE_MCP_AUTH_TIMEOUT_MS)
                timer.unref()
              })
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
          await authManager.persistMcpAuth(target, execution.cwd)
          persisted = true
          let verificationTimer: NodeJS.Timeout | undefined
          let snapshot: McpSnapshot
          try {
            snapshot = await Promise.race([
              (async () => {
                await unwrap(client.mcp.connect({ name: target.name, directory: context.cwd }), 'mcp.connect')
                return await openCodeMcpSnapshot(client, context, [
                  {
                    targetId: target.targetId,
                    name: target.name,
                    scope: 'authorized',
                    transport: 'http',
                    detail: String(target.config.url ?? ''),
                    enabled: true
                  }
                ], [target.targetId])
              })(),
              new Promise<never>((_resolve, reject) => {
                verificationTimer = setTimeout(() => {
                  reject(new Error('OpenCode MCP 认证已完成，但连接状态校验超时'))
                }, OPEN_CODE_MCP_VERIFY_TIMEOUT_MS)
                verificationTimer.unref()
              })
            ])
          } finally {
            if (verificationTimer) clearTimeout(verificationTimer)
          }
          const status = snapshot.runtime?.find((item) => item.name === target.name)
          if (status?.status !== 'connected') {
            return failed(`OpenCode MCP ${target.name} 认证后状态为 ${status?.status ?? 'unknown'}`, true)
          }
          return capabilityReady(context, 'read', { ok: true, status: 'authenticated' as const })
        } catch (error) {
          return failed(error, persisted)
        } finally {
          authManager.close()
        }
      }
    },
    runControls: {
      read: async (context) => {
        const cacheKey = context.cwd ?? ''
        const cached = modelCache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) return capabilityReady(context, 'read', cached.catalog)
        try {
          const client = await clientFor(context)
          const response = await unwrap<{ data?: unknown[] }>(
            client.v2.model.list({ location: { directory: context.cwd } }),
            'model.list'
          )
          const catalog = openCodeRunControlCatalog(response.data ?? [])
          modelCache.set(cacheKey, { expiresAt: Date.now() + 30_000, catalog })
          return capabilityReady(context, 'read', catalog)
        } catch (error) {
          rememberFailure(error)
          return {
            ...capabilityReady(context, 'read', { models: [], permissions: permissionOptions(false) }),
            state: 'degraded' as const,
            reason: String((error as Error).message)
          }
        }
      }
    },
    skills: {
      list: async (context) => {
        try {
          const client = await clientFor(context)
          const response = await unwrap<{ data?: unknown[] }>(
            client.v2.skill.list({ location: { directory: context.cwd } }),
            'skill.list'
          )
          const data: SkillMeta[] = await Promise.all((response.data ?? []).map(async (raw) => {
            const skill = record(raw)
            const location = String(skill.location ?? '')
            return {
              name: String(skill.name ?? ''),
              dir: location,
              scope: context.cwd ? await openCodeSkillScope(context.cwd, location, homeDir) : 'unknown',
              description: String(skill.description ?? ''),
              enabled: true
            }
          }))
          return capabilityReady(context, 'read', data)
        } catch (error) {
          rememberFailure(error)
          return capabilityUnknown<SkillMeta[]>(context, 'read', String((error as Error).message))
        }
      }
    },
    commands: {
      list: async (context) => {
        try {
          const client = await clientFor(context)
          const response = await unwrap<{ data?: unknown[] }>(
            client.v2.command.list({ location: { directory: context.cwd } }),
            'command.list'
          )
          return capabilityReady(context, 'read', (response.data ?? []).map((raw) => {
            const command = record(raw)
            return { name: String(command.name ?? ''), description: String(command.description ?? ''), source: 'custom' as const }
          }))
        } catch (error) {
          rememberFailure(error)
          return capabilityUnknown(context, 'read', String((error as Error).message))
        }
      }
    },
    dispose: () => {
      for (const manager of managers.values()) manager.close()
      managers.clear()
    }
  }
}
