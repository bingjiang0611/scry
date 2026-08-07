import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { homedir } from 'node:os'
import { capabilityReady, capabilityUnknown, type McpSnapshot, type ProviderContext, type SkillMeta } from '../../shared/provider'
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
  type ParsedMcp,
  type TraceEvent
} from '../../shared/trace'
import { resolveRuntimeCliBin, shellEnv } from '../claude-locate'
import { AgentRuntimeError } from '../cli-runtime'
import { listProviderMcp } from '../mcp-config'
import { OpenCodeServerManager, sanitizeOpenCodeServerLog } from './opencode-server'
import { effortOption, permissionOptions } from './run-controls'
import type { AuthorizedMcpExecution, ProviderAdapter, ProviderRunRequest } from './types'

let counter = 0
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
  mcpByToolUseId: Map<string, ParsedMcp>
}

const eventStates = new WeakMap<ProviderRunRequest, OpenCodeEventState>()

const eventState = (request: ProviderRunRequest): OpenCodeEventState => {
  const existing = eventStates.get(request)
  if (existing) return existing
  const created = {
    starts: new Set<string>(),
    results: new Set<string>(),
    mcpByToolUseId: new Map<string, ParsedMcp>()
  }
  eventStates.set(request, created)
  return created
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
  if (type === 'session.next.text.delta' || (type === 'message.part.delta' && payload.field === 'text')) {
    request.emit(newEvent(request.runId, { kind: 'model', stage: 'text_delta', text: String(payload.delta ?? '') }))
    return
  }
  if (type === 'session.next.reasoning.delta' || (type === 'message.part.delta' && payload.field === 'reasoning')) {
    request.emit(newEvent(request.runId, { kind: 'model', stage: 'thinking', thinking: String(payload.delta ?? '') }))
    return
  }
  const part = type === 'message.part.updated' ? record(payload.part) : payload
  const toolState = record(part.state)
  const isPartTool = type === 'message.part.updated' && part.type === 'tool'
  const toolUseId = String(part.callID ?? '')
  const status = String(toolState.status ?? '')
  const isToolStart = type === 'session.next.tool.called' || (isPartTool && ['running', 'completed', 'error'].includes(status))
  if (isToolStart && toolUseId && !eventState(request).starts.has(toolUseId)) {
    eventState(request).starts.add(toolUseId)
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
      input,
      ...mcp,
      ...fileOpOf(toolName, input)
    }))
  }
  const isToolResult = type === 'session.next.tool.success' || type === 'session.next.tool.failed' || (isPartTool && ['completed', 'error'].includes(status))
  if (isToolResult && toolUseId && !eventState(request).results.has(toolUseId)) {
    eventState(request).results.add(toolUseId)
    const failed = type.endsWith('failed') || status === 'error'
    const value = isPartTool ? (failed ? toolState.error : toolState.output) : (part.result ?? part.content ?? part.error ?? null)
    const output = typeof value === 'string' ? value : JSON.stringify(value)
    const mcp = eventState(request).mcpByToolUseId.get(toolUseId)
    eventState(request).mcpByToolUseId.delete(toolUseId)
    request.emit(newEvent(request.runId, {
      kind: 'tool',
      stage: 'tool_result',
      toolUseId,
      output,
      ...(mcp ?? {}),
      isError: failed || (mcp?.isMcp === true && mcpPayloadFailed(output))
    }))
  }
}

async function openCodeMcpSnapshot(
  client: OpencodeClient,
  context: ProviderContext,
  configured: McpSnapshot['configured']
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
        status.status === 'needs_auth' || status.status === 'needs_client_registration'
          ? 'needs-auth'
          : status.status === 'connected'
            ? 'connected'
            : status.status === 'disabled'
              ? 'disabled'
              : 'failed'
    }))
  }
}

export function createOpenCodeAdapter(homeDir = homedir()): ProviderAdapter {
  const executable = (): string | undefined => process.env.SCRY_OPENCODE_PATH?.trim() || resolveRuntimeCliBin('opencode')
  const managers = new Map<string, OpenCodeServerManager>()
  const managerFor = (cwd: string): OpenCodeServerManager => {
    let manager = managers.get(cwd)
    if (!manager) {
      manager = new OpenCodeServerManager(executable)
      managers.set(cwd, manager)
    }
    return manager
  }
  let lastOkAt: number | undefined
  let lastErrorAt: number | undefined
  let lastError: string | undefined
  const modelCache = new Map<string, { expiresAt: number; catalog: AgentRunControlCatalog }>()
  const rememberFailure = (error: unknown): void => {
    lastErrorAt = Date.now()
    lastError = error instanceof Error ? error.message : String(error)
  }

  const clientFor = async (context: ProviderContext, mcpExecution?: AuthorizedMcpExecution): Promise<OpencodeClient> => {
    if (!context.cwd) throw new Error('OpenCode 需要工作目录')
    try {
      const state = await managerFor(context.cwd).ensure(context.cwd, mcpExecution)
      lastOkAt = Date.now()
      lastError = undefined
      return state.client
    } catch (error) {
      rememberFailure(error)
      throw error
    }
  }

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
      let stopped = false
      let client: OpencodeClient | undefined
      const permissionController = new AbortController()
      const requestController = new AbortController()
      const eventController = new AbortController()
      const context: ProviderContext = { providerId: 'opencode', cwd: request.cwd, externalSessionId }
      const manager = request.cwd ? managerFor(request.cwd) : undefined
      const promise = (async () => {
        try {
          client = await clientFor(context, request.mcpExecution)
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
          const eventOptions = {
            signal: eventController.signal,
            // The generated SDK does not expose sseSleepFn in this method's type,
            // but its runtime forwards it to createSseClient. This makes abort
            // interrupt retry backoff instead of waiting up to 30 seconds.
            sseSleepFn: abortableSseSleep(eventController.signal)
          } as unknown as Parameters<typeof client.event.subscribe>[1]
          const subscription = await client.event.subscribe({ directory: request.cwd }, eventOptions)
          const stream = subscription.stream as AsyncGenerator<unknown>
          let eventError: unknown
          const events = (async () => {
            try {
              for await (const event of stream) {
                if (await handleOpenCodePermission(request, client!, event, externalSessionId!, permissionController.signal)) continue
                if (await handleOpenCodeQuestion(request, client!, event, externalSessionId!, permissionController.signal)) continue
                emitOpenCodeEvent(request, event, externalSessionId!)
              }
            } catch (error) {
              if (!stopped && !eventController.signal.aborted) eventError = error
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
            if (responseError == null && eventError != null) responseError = eventError
          }
          if (responseError != null) throw responseError
          const info = record(response!.info)
          providerTurnId = typeof info.id === 'string' && info.id ? info.id : undefined
          const timing = openCodeResultTiming(info)
          const tokens = record(info.tokens)
          const cache = record(tokens.cache)
          const upstream = String(info.providerID ?? '')
          const sourceProvider = billingProvider(upstream)
          const cost = typeof info.cost === 'number' ? info.cost : undefined
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
            tokensIn: typeof tokens.input === 'number' ? tokens.input : undefined,
            tokensOut: typeof tokens.output === 'number' ? tokens.output : undefined,
            reasoningTokens: typeof tokens.reasoning === 'number' ? tokens.reasoning : undefined,
            cacheReadTokens: typeof cache.read === 'number' ? cache.read : undefined,
            cacheCreationTokens: typeof cache.write === 'number' ? cache.write : undefined,
            costUsd: cost,
            costSource: cost === undefined ? undefined : 'provider_reported',
            costConfidence: cost === undefined ? undefined : 'provider_reported',
            costUnit: cost === undefined ? undefined : 'usd',
            billingProvider: sourceProvider,
            upstreamProvider: upstream || undefined,
            usageSource: 'opencode_session',
            modelUsage: typeof info.modelID === 'string' ? [{
              model: info.modelID,
              inputTokens: typeof tokens.input === 'number' ? tokens.input : undefined,
              outputTokens: typeof tokens.output === 'number' ? tokens.output : undefined,
              reasoningTokens: typeof tokens.reasoning === 'number' ? tokens.reasoning : undefined,
              cacheReadTokens: typeof cache.read === 'number' ? cache.read : undefined,
              cacheCreationTokens: typeof cache.write === 'number' ? cache.write : undefined,
              costUsd: cost,
              costSource: cost === undefined ? undefined : 'provider_reported',
              costConfidence: cost === undefined ? undefined : 'provider_reported',
              costUnit: cost === undefined ? undefined : 'usd',
              billingProvider: sourceProvider,
              upstreamProvider: upstream || undefined,
              usageSource: 'opencode_session'
            }] : undefined,
            isError: !!info.error,
            ...(terminationReason ? { terminationReason } : {}),
            ...(providerStopReason ? { providerStopReason } : {}),
            runtimeMetadata: { modelProvider: upstream, source: 'opencode_server', finish: info.finish }
          }, timing?.ts))
          if (info.error && !stopped) throw new Error(`OpenCode Provider 失败：${errorText(info.error)}`)
          lastOkAt = Date.now()
          lastError = undefined
          return { externalSessionId, providerTurnId, stopped }
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
        getProviderTurnId: () => providerTurnId
      }
    },
    mcp: {
      snapshot: async (context, refresh = false, execution) => {
        const configured = listProviderMcp('opencode', context.cwd, homeDir, shellEnv())
        if (!refresh) {
          return {
            ...capabilityReady(context, 'read', { configured, runtime: null }),
            state: 'degraded',
            reason: '配置已读取；刷新后才会启动隔离 OpenCode server 并读取已授权 MCP 运行状态'
          }
        }
        if (!configured.some((item) => item.enabled)) {
          return capabilityReady(context, 'read', { configured, runtime: [] })
        }
        if (!execution) return capabilityUnknown<McpSnapshot>(context, 'read', '缺少已确认的 OpenCode MCP 执行快照')
        try {
          return capabilityReady(context, 'read', await openCodeMcpSnapshot(await clientFor(context, execution), context, configured))
        } catch (error) {
          rememberFailure(error)
          return capabilityUnknown<McpSnapshot>(context, 'read', String((error as Error).message))
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
          const data: SkillMeta[] = (response.data ?? []).map((raw) => {
            const skill = record(raw)
            return {
              name: String(skill.name ?? ''),
              dir: String(skill.location ?? ''),
              scope: 'opencode',
              description: String(skill.description ?? ''),
              enabled: true
            }
          })
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
