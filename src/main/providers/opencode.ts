import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { capabilityReady, capabilityUnknown, type McpSnapshot, type ProviderContext, type SkillMeta } from '../../shared/provider'
import type { BillingProvider } from '../../shared/billing'
import { classifyTool, fileOpOf, parseMcp, type TraceEvent } from '../../shared/trace'
import { resolveRuntimeCliBin } from '../claude-locate'
import { OpenCodeServerManager, type OpenCodeHookFrame } from './opencode-server'
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
  mcpServers: Set<string>
}

const eventStates = new WeakMap<ProviderRunRequest, OpenCodeEventState>()

const eventState = (request: ProviderRunRequest): OpenCodeEventState => {
  const existing = eventStates.get(request)
  if (existing) return existing
  const created = { starts: new Set<string>(), results: new Set<string>(), mcpServers: new Set<string>() }
  eventStates.set(request, created)
  return created
}

export function setOpenCodeMcpServers(request: ProviderRunRequest, names: string[]): void {
  eventState(request).mcpServers = new Set(names)
}

export function emitOpenCodeHookFrame(request: ProviderRunRequest, frame: OpenCodeHookFrame, sessionId: string): void {
  if (frame.type === 'init' || frame.input.sessionID !== sessionId) return
  const hookEvent = frame.type === 'tool.execute.before'
    ? 'PreToolUse'
    : frame.type === 'tool.execute.after'
      ? 'PostToolUse'
      : frame.type === 'permission.ask'
        ? 'PermissionRequest'
        : 'UserPromptSubmit'
  const callId = typeof frame.input.callID === 'string' ? frame.input.callID : undefined
  const target = String(frame.input.tool ?? frame.input.command ?? 'OpenCode')
  const hookId = `opencode:${sessionId}:${callId ?? frame.ts}:${frame.type}`
  const common = {
    kind: 'hook' as const,
    tool: 'Scry OpenCode observer',
    name: hookEvent,
    hookId,
    hookName: 'Scry OpenCode observer',
    hookEvent,
    hookCommand: target,
    toolUseId: callId,
    runtimeMetadata: { source: 'opencode_plugin', protocolVersion: frame.v }
  }
  request.emit(newEvent(request.runId, { ...common, stage: 'hook_started', hookOutcome: 'started' }))
  request.emit(newEvent(request.runId, { ...common, stage: 'hook_response', hookOutcome: 'success', durationMs: 0, isError: false }))
}

function normalizeOpenCodeTool(request: ProviderRunRequest, rawName: string, rawInput: unknown): {
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
  for (const server of [...eventState(request).mcpServers].sort((a, b) => b.length - a.length)) {
    const prefix = `${server}_`
    if (rawName.startsWith(prefix)) return { toolName: `mcp__${server}__${rawName.slice(prefix.length)}`, input }
  }
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
    const normalized = normalizeOpenCodeTool(request, String(part.tool ?? ''), isPartTool ? toolState.input : part.input)
    const { toolName, input } = normalized
    const classified = classifyTool(toolName, input)
    request.emit(newEvent(request.runId, {
      kind: classified.kind,
      stage: `${classified.kind}:${classified.name}`,
      tool: toolName,
      name: classified.name,
      toolUseId,
      input,
      ...parseMcp(toolName, input),
      ...fileOpOf(toolName, input)
    }))
  }
  const isToolResult = type === 'session.next.tool.success' || type === 'session.next.tool.failed' || (isPartTool && ['completed', 'error'].includes(status))
  if (isToolResult && toolUseId && !eventState(request).results.has(toolUseId)) {
    eventState(request).results.add(toolUseId)
    const failed = type.endsWith('failed') || status === 'error'
    const value = isPartTool ? (failed ? toolState.error : toolState.output) : (part.result ?? part.content ?? part.error ?? null)
    request.emit(newEvent(request.runId, {
      kind: 'tool',
      stage: 'tool_result',
      toolUseId,
      output: typeof value === 'string' ? value : JSON.stringify(value),
      isError: failed
    }))
  }
}

async function mcpSnapshot(client: OpencodeClient, context: ProviderContext): Promise<McpSnapshot> {
  const statuses = await unwrap<Record<string, { status?: string; error?: string }>>(client.mcp.status({ directory: context.cwd }))
  const runtime = Object.entries(statuses).map(([name, status]) => ({
    name,
    status:
      status.status === 'needs_auth' || status.status === 'needs_client_registration'
        ? ('needs-auth' as const)
        : status.status === 'connected'
          ? ('connected' as const)
          : status.status === 'disabled'
            ? ('disabled' as const)
            : ('failed' as const)
  }))
  return {
    configured: Object.entries(statuses).map(([name, status]) => ({
      name,
      scope: 'opencode',
      transport: 'native',
      detail: status.error ?? status.status ?? 'unknown',
      enabled: status.status !== 'disabled'
    })),
    runtime
  }
}

export function createOpenCodeAdapter(): ProviderAdapter {
  const executable = (): string | undefined => process.env.SCRY_OPENCODE_PATH?.trim() || resolveRuntimeCliBin('opencode')
  const manager = new OpenCodeServerManager(executable)
  let lastOkAt: number | undefined
  let lastErrorAt: number | undefined
  let lastError: string | undefined

  const clientFor = async (context: ProviderContext): Promise<OpencodeClient> => {
    if (!context.cwd) throw new Error('OpenCode 需要工作目录')
    try {
      const state = await manager.ensure(context.cwd)
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
      const bridge = manager.hookBridge
      const bridgeError = bridge.enabled && manager.state && !bridge.ready ? bridge.error ?? 'OpenCode Hook bridge not ready' : undefined
      return {
        id: 'opencode',
        label: 'OpenCode',
        runtimeProvider: 'opencode_server',
        transport: 'server SDK',
        available: !!path,
        path,
        capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' },
        health: {
          state: !path ? 'unavailable' : lastError || bridgeError ? 'degraded' : lastOkAt ? 'ready' : 'unknown',
          transport: 'server SDK',
          cwd: manager.state?.cwd,
          pid: manager.state?.pid,
          lastOkAt,
          lastErrorAt,
          lastError: lastError ?? bridgeError
        }
      }
    },
    run: (request) => {
      let externalSessionId = request.resume
      let stopped = false
      let client: OpencodeClient | undefined
      let stream: AsyncGenerator<unknown> | undefined
      const context: ProviderContext = { providerId: 'opencode', cwd: request.cwd, externalSessionId }
      const promise = (async () => {
        client = await clientFor(context)
        if (!externalSessionId) {
          const session = await unwrap<{ id: string }>(client.session.create({ directory: request.cwd }))
          externalSessionId = session.id
          request.onExternalSessionId?.(session.id)
        }
        const subscription = await client.event.subscribe({ directory: request.cwd })
        stream = subscription.stream as AsyncGenerator<unknown>
        const unsubscribeHook = manager.onHook((frame) => emitOpenCodeHookFrame(request, frame, externalSessionId!))
        const events = (async () => {
          try {
            for await (const event of stream!) emitOpenCodeEvent(request, event, externalSessionId!)
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
                arguments: slash[2] ?? ''
              }))
            : await unwrap(client.session.prompt({
                sessionID: externalSessionId,
                directory: request.cwd,
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
          try {
            await stream.return(undefined)
            await events
          } finally {
            unsubscribeHook()
          }
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
        return { externalSessionId, stopped }
      })()
      const interrupt = (): void => {
        stopped = true
        if (client && externalSessionId) void client.session.abort({ sessionID: externalSessionId, directory: request.cwd })
        void stream?.return(undefined)
      }
      return { promise, interrupt, getExternalSessionId: () => externalSessionId }
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
    mcp: {
      snapshot: async (context) => {
        try {
          return capabilityReady(context, 'read', await mcpSnapshot(await clientFor(context), context))
        } catch (error) {
          return capabilityUnknown<McpSnapshot>(context, 'read', String((error as Error).message))
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
    dispose: () => manager.close()
  }
}
