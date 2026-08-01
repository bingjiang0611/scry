import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { capabilityReady, capabilityUnknown, type ProviderContext, type SkillMeta } from '../../shared/provider'
import type { BillingProvider } from '../../shared/billing'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
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
import { resolveRuntimeCliBin } from '../claude-locate'
import { OpenCodeServerManager } from './opencode-server'
import { effortOption, permissionOptions } from './run-controls'
import type { ProviderAdapter, ProviderRunRequest } from './types'

let counter = 0
const newEvent = (runId: string, fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>): TraceEvent => ({
  id: `opencode-${Date.now().toString(36)}-${(counter++).toString(36)}`,
  runId,
  ts: new Date().toISOString(),
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

async function unwrap<T>(promise: Promise<unknown>): Promise<T> {
  const result = record(await promise)
  if (result.error !== undefined) throw new Error(errorText(result.error))
  return (result.data === undefined ? result : result.data) as T
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
    patterns || 'OpenCode 请求执行此操作'
  )
  const response = request.requestUserInput
    ? await request.requestUserInput(question, signal)
    : { runId: request.runId, questionId: question.questionId, behavior: 'cancelled' as const }
  const decision = agentPermissionDecision(question, response)
  const reply = decision === 'once' ? 'once' : decision === 'session' ? 'always' : 'reject'
  if (versioned) {
    await unwrap(client.v2.session.permission.reply({ sessionID: sessionId, requestID: requestId, reply }))
  } else {
    await unwrap(client.permission.reply({ requestID: requestId, directory: request.cwd, reply }))
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

export function createOpenCodeAdapter(): ProviderAdapter {
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

  const clientFor = async (context: ProviderContext): Promise<OpencodeClient> => {
    if (!context.cwd) throw new Error('OpenCode 需要工作目录')
    try {
      const state = await managerFor(context.cwd).ensure(context.cwd)
      lastOkAt = Date.now()
      lastError = undefined
      return state.client
    } catch (error) {
      lastErrorAt = Date.now()
      lastError = String((error as Error).message)
      throw error
    }
  }

  return {
    id: 'opencode',
    runtimeProvider: 'opencode_server',
    describe: async () => {
      const path = executable()
      const current = [...managers.values()].map((manager) => manager.state).find((state) => state != null)
      return {
        id: 'opencode',
        label: 'OpenCode',
        runtimeProvider: 'opencode_server',
        transport: 'server SDK',
        available: !!path,
        path,
        capabilities: { skills: 'read', mcp: 'none', commands: 'read', account: 'none' },
        health: {
          state: !path ? 'unavailable' : lastError ? 'degraded' : lastOkAt ? 'ready' : 'unknown',
          transport: 'server SDK',
          cwd: current?.cwd,
          pid: current?.pid,
          lastOkAt,
          lastErrorAt,
          lastError
        }
      }
    },
    run: (request) => {
      let externalSessionId = request.resume
      let stopped = false
      let client: OpencodeClient | undefined
      let stream: AsyncGenerator<unknown> | undefined
      const permissionController = new AbortController()
      const context: ProviderContext = { providerId: 'opencode', cwd: request.cwd, externalSessionId }
      const promise = (async () => {
        client = await clientFor(context)
        if (stopped) return { externalSessionId, stopped }
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
          }))
          externalSessionId = session.id
          request.onExternalSessionId?.(session.id)
        } else {
          await unwrap(client.session.update({ sessionID: externalSessionId, directory: request.cwd, permission }))
        }
        if (stopped) {
          await client.session.abort({ sessionID: externalSessionId, directory: request.cwd }).catch(() => {})
          return { externalSessionId, stopped }
        }
        const subscription = await client.event.subscribe({ directory: request.cwd })
        stream = subscription.stream as AsyncGenerator<unknown>
        const events = (async () => {
          try {
            for await (const event of stream!) {
              if (await handleOpenCodePermission(request, client!, event, externalSessionId!, permissionController.signal)) continue
              emitOpenCodeEvent(request, event, externalSessionId!)
            }
          } catch (error) {
            if (!stopped) throw error
          }
        })()
        const slash = request.prompt.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
        let response: { info: Record<string, unknown>; parts: unknown[] }
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
              }))
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
              }))
        } finally {
          await stream.return(undefined)
          await events
        }
        const info = record(response.info)
        const tokens = record(info.tokens)
        const cache = record(tokens.cache)
        const upstream = String(info.providerID ?? '')
        const sourceProvider = billingProvider(upstream)
        const cost = typeof info.cost === 'number' ? info.cost : undefined
        request.emit(newEvent(request.runId, {
          kind: 'harness',
          stage: 'result',
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
          runtimeMetadata: { modelProvider: upstream, source: 'opencode_server', finish: info.finish }
        }))
        if (info.error && !stopped) throw new Error(`OpenCode Provider 失败：${errorText(info.error)}`)
        return { externalSessionId, stopped }
      })()
      const interrupt = (): void => {
        stopped = true
        permissionController.abort()
        if (client && externalSessionId) void client.session.abort({ sessionID: externalSessionId, directory: request.cwd })
        void stream?.return(undefined)
      }
      return { promise, interrupt, getExternalSessionId: () => externalSessionId }
    },
    runControls: {
      read: async (context) => {
        const cacheKey = context.cwd ?? ''
        const cached = modelCache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) return capabilityReady(context, 'read', cached.catalog)
        try {
          const client = await clientFor(context)
          const response = await unwrap<{ data?: unknown[] }>(
            client.v2.model.list({ location: { directory: context.cwd } })
          )
          const catalog = openCodeRunControlCatalog(response.data ?? [])
          modelCache.set(cacheKey, { expiresAt: Date.now() + 30_000, catalog })
          return capabilityReady(context, 'read', catalog)
        } catch (error) {
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
          const response = await unwrap<{ data?: unknown[] }>(client.v2.skill.list({ location: { directory: context.cwd } }))
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
          return capabilityUnknown<SkillMeta[]>(context, 'read', String((error as Error).message))
        }
      }
    },
    commands: {
      list: async (context) => {
        try {
          const client = await clientFor(context)
          const response = await unwrap<{ data?: unknown[] }>(client.v2.command.list({ location: { directory: context.cwd } }))
          return capabilityReady(context, 'read', (response.data ?? []).map((raw) => {
            const command = record(raw)
            return { name: String(command.name ?? ''), description: String(command.description ?? ''), source: 'custom' as const }
          }))
        } catch (error) {
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
