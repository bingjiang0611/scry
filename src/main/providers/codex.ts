import { capabilityReady, capabilityUnknown, type AccountSnapshot, type CapabilityEnvelope, type McpSnapshot, type ProviderContext, type SkillMeta } from '../../shared/provider'
import type { McpLiveStatus, TraceEvent } from '../../shared/trace'
import { resolveRuntimeCliBin, runtimeCliEnv, shellEnv } from '../claude-locate'
import { CodexAppServerClient } from './codex-app-server'
import type { ProviderAdapter, ProviderRunRequest } from './types'

interface CodexThreadResponse {
  thread: { id: string }
  model?: string
  modelProvider?: string
  serviceTier?: string | null
}

interface CodexTurnResponse {
  turn: { id: string }
}

interface TokenUsage {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

let eventCounter = 0
const newEvent = (runId: string, fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>): TraceEvent => ({
  id: `codex-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`,
  runId,
  ts: new Date().toISOString(),
  ...fields
})

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

function mcpStatus(value: unknown): McpLiveStatus[] {
  const data = Array.isArray(record(value).data) ? (record(value).data as unknown[]) : []
  return data.map((raw) => {
    const item = record(raw)
    const auth = item.authStatus
    const serverInfo = record(item.serverInfo)
    const tools = record(item.tools)
    return {
      name: String(item.name ?? ''),
      status: auth === 'notLoggedIn' ? 'needs-auth' : item.serverInfo ? 'connected' : 'pending',
      serverName: typeof serverInfo.name === 'string' ? serverInfo.name : undefined,
      serverVersion: typeof serverInfo.version === 'string' ? serverInfo.version : undefined,
      tools: Object.keys(tools).length
    }
  })
}

const explicitSkillMention = (prompt: string): { name: string; text: string } | undefined => {
  const match = /^\s*\$([A-Za-z0-9_.:-]+)(?=\s|$)/.exec(prompt)
  return match ? { name: match[1], text: prompt.slice(match[0].length).trimStart() } : undefined
}

const skillNamesFromCommand = (command: string): string[] => {
  const names = new Set<string>()
  const paths = /(?:^|[\s"'`=])[^\s"'`=]*skills\/([^/\s"'`=]+)\/SKILL\.md\b/g
  for (const match of command.matchAll(paths)) names.add(match[1])
  return [...names]
}

const hookEventName = (value: unknown): string => {
  const name = String(value ?? 'hook')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function traceFromHook(runId: string, raw: unknown, completed: boolean): TraceEvent {
  const hook = record(raw)
  const status = String(hook.status ?? (completed ? 'completed' : 'running'))
  const event = hookEventName(hook.eventName)
  const entries = Array.isArray(hook.entries) ? hook.entries.map(record) : []
  const failed = completed && status !== 'completed'
  return newEvent(runId, {
    kind: 'hook',
    stage: completed ? 'hook_response' : 'hook_started',
    name: event,
    hookId: typeof hook.id === 'string' ? hook.id : undefined,
    hookEvent: event,
    hookName: typeof hook.statusMessage === 'string' ? hook.statusMessage : `${event}:${String(hook.handlerType ?? 'hook')}`,
    hookOutcome: completed ? (status === 'completed' ? 'success' : status === 'stopped' ? 'cancelled' : 'error') : 'started',
    durationMs: typeof hook.durationMs === 'number' ? hook.durationMs : undefined,
    isError: failed,
    output: completed ? entries.map((entry) => String(entry.text ?? '')).filter(Boolean).join('\n') : undefined,
    input: {
      source: hook.source,
      sourcePath: hook.sourcePath,
      scope: hook.scope,
      handlerType: hook.handlerType,
      status,
      entries
    }
  })
}

function traceFromItem(runId: string, raw: unknown, completed: boolean): TraceEvent[] {
  const item = record(raw)
  const type = String(item.type ?? '')
  const id = typeof item.id === 'string' ? item.id : undefined
  if (type === 'commandExecution') {
    const command = String(item.command ?? '')
    const events = [
      newEvent(runId, completed
        ? { kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: id, output: String(item.aggregatedOutput ?? ''), isError: item.status === 'failed' }
        : { kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: id, input: { command, cwd: item.cwd } })
    ]
    if (!completed) {
      for (const name of skillNamesFromCommand(command)) {
        events.push(
          newEvent(runId, {
            kind: 'skill',
            stage: `skill:${name}`,
            tool: 'Skill',
            toolUseId: id,
            name,
            input: { source: 'skill_path_in_command', command }
          })
        )
      }
    }
    return events
  }
  if (type === 'mcpToolCall') {
    const server = String(item.server ?? '')
    const tool = String(item.tool ?? '')
    const toolName = `mcp__${server}__${tool}`
    return [
      newEvent(runId, completed
        ? { kind: 'tool', stage: 'tool_result', tool: toolName, toolUseId: id, isMcp: true, mcpServer: server, mcpAction: tool, output: JSON.stringify(item.result ?? item.error ?? null), isError: !!item.error }
        : { kind: 'tool', stage: `tool:${toolName}`, tool: toolName, toolUseId: id, isMcp: true, mcpServer: server, mcpAction: tool, input: item.arguments })
    ]
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    return changes.map((change) => {
      const file = record(change)
      return newEvent(runId, {
        kind: 'tool',
        stage: completed ? 'tool_result' : 'tool:Edit',
        tool: 'Edit',
        toolUseId: id,
        fileOp: 'edit',
        filePath: String(file.path ?? ''),
        input: completed ? undefined : file,
        output: completed ? String(file.diff ?? '') : undefined
      })
    })
  }
  return []
}

export function createCodexAdapter(): ProviderAdapter {
  const clients = new Map<string, CodexAppServerClient>()
  let lastClient: CodexAppServerClient | null = null
  let lastOkAt: number | undefined
  let lastErrorAt: number | undefined
  let lastError: string | undefined
  let restarts = 0

  const executable = (): string | undefined => process.env.SCRY_CODEX_PATH?.trim() || resolveRuntimeCliBin('codex')
  const getClient = (cwd?: string): CodexAppServerClient => {
    const key = cwd ?? ''
    const existing = clients.get(key)
    if (existing) {
      lastClient = existing
      return existing
    }
    const path = executable()
    if (!path) throw new Error('Codex CLI 未找到')
    if (lastErrorAt) restarts++
    const args = process.env.SCRY_CODEX_BYPASS_HOOK_TRUST?.trim() === '1'
      ? ['--dangerously-bypass-hook-trust', 'app-server']
      : undefined
    const client = new CodexAppServerClient({ command: path, args, cwd, env: runtimeCliEnv(shellEnv()) })
    clients.set(key, client)
    lastClient = client
    return client
  }

  const request = async <T>(method: string, params?: unknown, cwd?: string): Promise<T> => {
    try {
      const result = await getClient(cwd).request<T>(method, params)
      lastOkAt = Date.now()
      lastError = undefined
      return result
    } catch (error) {
      lastErrorAt = Date.now()
      lastError = String((error as Error).message)
      throw error
    }
  }

  const skills = {
    list: async (context: ProviderContext, forceReload = false) => {
      try {
        const response = await request<{ data?: Array<{ cwd?: string; skills?: unknown[]; errors?: unknown[] }> }>('skills/list', {
          cwds: context.cwd ? [context.cwd] : [],
          forceReload
        }, context.cwd)
        const group = response.data?.find((item) => !context.cwd || item.cwd === context.cwd) ?? response.data?.[0]
        const data: SkillMeta[] = (group?.skills ?? []).map((raw) => {
          const item = record(raw)
          return {
            name: String(item.name ?? ''),
            dir: String(item.path ?? ''),
            scope: String(item.scope ?? 'unknown'),
            description: String(item.description ?? item.shortDescription ?? ''),
            enabled: item.enabled !== false
          }
        })
        const errors = group?.errors?.length ?? 0
        return errors
          ? { ...capabilityReady(context, 'manage' as const, data), state: 'degraded' as const, reason: `${errors} 个 Skill 读取错误` }
          : capabilityReady(context, 'manage' as const, data)
      } catch (error) {
        return capabilityUnknown<SkillMeta[]>(context, 'manage', String((error as Error).message))
      }
    },
    setEnabled: async (context: ProviderContext, name: string, enabled: boolean) => {
      try {
        await request('skills/config/write', { name, enabled }, context.cwd)
        return capabilityReady(context, 'manage', true)
      } catch (error) {
        return capabilityUnknown<boolean>(context, 'manage', String((error as Error).message))
      }
    }
  }

  const snapshot = async (context: ProviderContext): Promise<CapabilityEnvelope<McpSnapshot>> => {
    try {
      const response = await request('mcpServerStatus/list', { threadId: context.externalSessionId ?? null, detail: 'full' }, context.cwd)
      const runtime = mcpStatus(response)
      const ready = capabilityReady(context, 'read', {
        configured: runtime.map((server) => ({
          name: server.name,
          scope: 'codex',
          transport: 'native',
          detail: server.serverName ?? server.status,
          enabled: server.status !== 'disabled'
        })),
        runtime
      })
      return context.externalSessionId
        ? ready
        : {
            ...ready,
            state: 'degraded',
            reason: '尚未建立 cwd-bound thread；当前仅能读取 app-server 进程级 MCP 状态，项目配置运行态为 unknown'
          }
    } catch (error) {
      return capabilityUnknown<McpSnapshot>(context, 'read', String((error as Error).message))
    }
  }

  return {
    id: 'codex',
    runtimeProvider: 'codex_cli',
    describe: async () => {
      const path = executable()
      return {
        id: 'codex',
        label: 'Codex',
        runtimeProvider: 'codex_cli',
        transport: 'app-server',
        available: !!path,
        path,
        capabilities: { skills: 'manage', mcp: 'read', commands: 'none', account: 'read' },
        health: {
          state: !path ? 'unavailable' : lastError ? 'degraded' : lastOkAt ? 'ready' : 'unknown',
          transport: 'app-server',
          pid: lastClient?.pid,
          lastOkAt,
          lastErrorAt,
          lastError,
          restarts
        }
      }
    },
    run: (runRequest: ProviderRunRequest) => {
      let externalSessionId = runRequest.resume
      let turnId: string | undefined
      let stopped = false
      let unsubscribe = () => {}
      let lastUsage: TokenUsage | undefined
      let model: string | undefined
      let modelProvider: string | undefined
      let serviceTier: string | null | undefined
      let authMode: string | undefined
      let accountPlan: string | undefined
      let accountReadError: string | undefined
      let finish: ((value: { externalSessionId?: string; stopped?: boolean; mcp?: McpSnapshot }) => void) | undefined
      let fail: ((error: Error) => void) | undefined

      const done = new Promise<{ externalSessionId?: string; stopped?: boolean; mcp?: McpSnapshot }>((resolve, reject) => {
        finish = resolve
        fail = reject
      })

      const promise = (async () => {
        try {
          const appServer = getClient(runRequest.cwd)
          await appServer.start()
          const accountPromise = appServer.request<Record<string, unknown>>('account/read', { refreshToken: false }).catch((error) => {
            accountReadError = String((error as Error).message)
            return null
          })
          unsubscribe = appServer.onNotification((method, value) => {
            const params = record(value)
            if ((externalSessionId && params.threadId !== externalSessionId) || (turnId && params.turnId && params.turnId !== turnId)) return
            if (method === 'item/agentMessage/delta') {
              runRequest.emit(newEvent(runRequest.runId, { kind: 'model', stage: 'text', text: String(params.delta ?? '') }))
            } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
              runRequest.emit(newEvent(runRequest.runId, { kind: 'model', stage: 'thinking', thinking: String(params.delta ?? '') }))
            } else if (method === 'item/started' || method === 'item/completed') {
              for (const event of traceFromItem(runRequest.runId, params.item, method === 'item/completed')) runRequest.emit(event)
            } else if (method === 'hook/started' || method === 'hook/completed') {
              runRequest.emit(traceFromHook(runRequest.runId, params.run, method === 'hook/completed'))
            } else if (method === 'thread/tokenUsage/updated') {
              const tokenUsage = record(params.tokenUsage)
              lastUsage = record(tokenUsage.last) as unknown as TokenUsage
            } else if (method === 'turn/completed') {
              const turn = record(params.turn)
              const billingProvider = authMode === 'apiKey' ? 'openai' : authMode === 'chatgpt' ? 'codex' : undefined
              const accountLabel = authMode === 'apiKey'
                ? 'OpenAI API key'
                : authMode === 'chatgpt' && accountPlan
                  ? `Codex ${accountPlan}`
                  : undefined
              runRequest.emit(newEvent(runRequest.runId, {
                kind: 'harness',
                stage: 'result',
                durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : undefined,
                tokensIn: lastUsage?.inputTokens,
                tokensOut: lastUsage?.outputTokens,
                cacheReadTokens: lastUsage?.cachedInputTokens,
                reasoningTokens: lastUsage?.reasoningOutputTokens,
                isError: turn.status === 'failed',
                modelUsage: model ? [{
                  model,
                  inputTokens: lastUsage?.inputTokens,
                  outputTokens: lastUsage?.outputTokens,
                  cacheReadTokens: lastUsage?.cachedInputTokens,
                  reasoningTokens: lastUsage?.reasoningOutputTokens,
                  billingProvider,
                  upstreamProvider: modelProvider ?? 'openai',
                  accountLabel,
                  usageSource: 'codex_app_server'
                }] : undefined,
                billingProvider,
                upstreamProvider: modelProvider ?? 'openai',
                accountLabel,
                usageSource: 'codex_app_server',
                runtimeMetadata: { modelProvider: modelProvider ?? 'openai', model, serviceTier, authMode, accountPlan, turnStatus: turn.status }
              }))
              finish?.({ externalSessionId, stopped })
            } else if (method === 'error') {
              const message = String(record(params.error).message ?? params.message ?? 'Codex app-server error')
              if (params.willRetry === true) {
                runRequest.emit(newEvent(runRequest.runId, {
                  kind: 'harness',
                  stage: 'runtime:retry',
                  text: message,
                  runtimeMetadata: { willRetry: true, codexErrorInfo: record(params.error).codexErrorInfo }
                }))
              } else {
                fail?.(new Error(message))
              }
            }
          })

          const thread = runRequest.resume
            ? await request<CodexThreadResponse>('thread/resume', { threadId: runRequest.resume, cwd: runRequest.cwd, excludeTurns: true }, runRequest.cwd)
            : await request<CodexThreadResponse>('thread/start', { cwd: runRequest.cwd, approvalPolicy: 'never', sandbox: 'workspace-write' }, runRequest.cwd)
          externalSessionId = thread.thread.id
          model = thread.model
          modelProvider = thread.modelProvider
          serviceTier = thread.serviceTier
          const accountResponse = await accountPromise
          const account = record(accountResponse && record(accountResponse).account)
          authMode = typeof account.type === 'string' ? account.type : undefined
          accountPlan = typeof account.planType === 'string' ? account.planType : undefined
          if (accountReadError) {
            runRequest.emit(newEvent(runRequest.runId, {
              kind: 'harness',
              stage: 'runtime:telemetry_degraded',
              text: 'Codex account detection failed; billing provider is unavailable',
              runtimeMetadata: { source: 'codex_app_server', capability: 'billing_identity', error: accountReadError }
            }))
          }
          runRequest.onExternalSessionId?.(externalSessionId)
          const input: unknown[] = []
          const mention = explicitSkillMention(runRequest.prompt)
          const skill = mention
            ? (await skills.list({ providerId: 'codex', cwd: runRequest.cwd })).data?.find(
                (item) => item.enabled && item.name === mention.name
              )
            : undefined
          if (skill) {
            input.push({ type: 'skill', name: skill.name, path: skill.dir })
            runRequest.emit(
              newEvent(runRequest.runId, {
                kind: 'skill',
                stage: `skill:${skill.name}`,
                tool: 'Skill',
                name: skill.name,
                input: { source: 'explicit_user_input', path: skill.dir }
              })
            )
          }
          const text = skill && mention ? mention.text : runRequest.prompt
          if (text) input.push({ type: 'text', text, text_elements: [] })
          for (const attachment of runRequest.attachments) {
            if (attachment.path) input.push({ type: 'localImage', path: attachment.path })
            else input.push({ type: 'image', url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` })
          }
          const turn = await request<CodexTurnResponse>('turn/start', {
            threadId: externalSessionId,
            input,
            cwd: runRequest.cwd,
            approvalPolicy: 'never'
          }, runRequest.cwd)
          turnId = turn.turn.id
          return await done
        } finally {
          unsubscribe()
        }
      })()

      const interrupt = (): void => {
        stopped = true
        if (externalSessionId && turnId) void request('turn/interrupt', { threadId: externalSessionId, turnId }, runRequest.cwd).catch(() => {})
      }

      return { promise, interrupt, getExternalSessionId: () => externalSessionId }
    },
    skills,
    mcp: { snapshot },
    account: {
      read: async (context) => {
        try {
          const [accountResponse, rateLimits, usage] = await Promise.all([
            request<Record<string, unknown>>('account/read', { refreshToken: false }, context.cwd),
            request<Record<string, unknown>>('account/rateLimits/read', undefined, context.cwd),
            request<Record<string, unknown>>('account/usage/read', undefined, context.cwd)
          ])
          const account = record(accountResponse.account)
          const limits = record(rateLimits.rateLimits)
          const plan = typeof account.planType === 'string' ? account.planType : typeof limits.planType === 'string' ? limits.planType : undefined
          const data: AccountSnapshot = {
            accountLabel: account.type === 'apiKey' ? 'OpenAI API key' : typeof account.email === 'string' ? account.email : 'Codex',
            plan,
            usage: { authMode: account.type, rateLimits, usage }
          }
          return capabilityReady(context, 'read', data)
        } catch (error) {
          return capabilityUnknown<AccountSnapshot>(context, 'read', String((error as Error).message))
        }
      }
    },
    dispose: () => {
      for (const client of clients.values()) client.close()
      clients.clear()
      lastClient = null
    }
  }
}
