import {
  capabilityReady,
  capabilityUnknown,
  type AccountSnapshot,
  type CapabilityEnvelope,
  type McpSnapshot,
  type ProviderCommand,
  type ProviderContext,
  type SkillMeta
} from '../../shared/provider'
import { mcpPayloadFailed, parseMcp, type McpLiveStatus, type TraceEvent } from '../../shared/trace'
import { resolveRuntimeCliBin, runtimeCliEnv, shellEnv } from '../claude-locate'
import type { CodexHookInspection, CodexHookMetadata, CodexHookTrustStatus } from '../codex-hook-trust'
import { CodexAppServerClient } from './codex-app-server'
import type { ProviderAdapter, ProviderRunRequest } from './types'

const CODEX_THREAD_ACCESS = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access'
} as const

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
  totalTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
}

interface ThreadTokenUsage {
  total?: TokenUsage
  last?: TokenUsage
  modelContextWindow?: number
}

interface ItemTraceContext {
  agentId?: string
  parentToolUseId?: string
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
  const match = /^\s*[$/]([A-Za-z0-9_.:-]+)(?=\s|$)/.exec(prompt)
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

const usageNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const tokenUsage = (value: unknown): TokenUsage => {
  const usage = record(value)
  return {
    totalTokens: usageNumber(usage.totalTokens),
    inputTokens: usageNumber(usage.inputTokens),
    cachedInputTokens: usageNumber(usage.cachedInputTokens),
    cacheWriteInputTokens: usageNumber(usage.cacheWriteInputTokens),
    outputTokens: usageNumber(usage.outputTokens),
    reasoningOutputTokens: usageNumber(usage.reasoningOutputTokens)
  }
}

const subtractUsage = (current: TokenUsage, baseline: TokenUsage): TokenUsage => {
  const difference = (value: number | undefined, start: number | undefined): number | undefined => {
    if (value == null) return undefined
    if (start == null) return value
    // A session reset should not turn into a negative turn. In that case the current value is the best evidence.
    return value >= start ? value - start : value
  }
  return {
    totalTokens: difference(current.totalTokens, baseline.totalTokens),
    inputTokens: difference(current.inputTokens, baseline.inputTokens),
    cachedInputTokens: difference(current.cachedInputTokens, baseline.cachedInputTokens),
    cacheWriteInputTokens: difference(current.cacheWriteInputTokens, baseline.cacheWriteInputTokens),
    outputTokens: difference(current.outputTokens, baseline.outputTokens),
    reasoningOutputTokens: difference(current.reasoningOutputTokens, baseline.reasoningOutputTokens)
  }
}

const addUsage = (current: TokenUsage | undefined, delta: TokenUsage): TokenUsage => {
  const add = (left: number | undefined, right: number | undefined): number | undefined =>
    left == null && right == null ? undefined : (left ?? 0) + (right ?? 0)
  return {
    totalTokens: add(current?.totalTokens, delta.totalTokens),
    inputTokens: add(current?.inputTokens, delta.inputTokens),
    cachedInputTokens: add(current?.cachedInputTokens, delta.cachedInputTokens),
    cacheWriteInputTokens: add(current?.cacheWriteInputTokens, delta.cacheWriteInputTokens),
    outputTokens: add(current?.outputTokens, delta.outputTokens),
    reasoningOutputTokens: add(current?.reasoningOutputTokens, delta.reasoningOutputTokens)
  }
}

const projectHookSource = (
  source: unknown,
  sourcePath: unknown,
  cwd?: string
): { sourcePath?: string; originalSourcePath?: string } => {
  const originalSourcePath = typeof sourcePath === 'string' ? sourcePath : undefined
  if (
    source === 'project' &&
    cwd &&
    originalSourcePath &&
    /[/\\]\.codex[/\\]hooks\.json$/.test(originalSourcePath)
  ) {
    const normalized = `${cwd.replace(/[/\\]+$/, '')}/.codex/hooks.json`
    return normalized === originalSourcePath
      ? { sourcePath: normalized }
      : { sourcePath: normalized, originalSourcePath }
  }
  return { sourcePath: originalSourcePath }
}

function traceFromHook(runId: string, raw: unknown, completed: boolean, cwd?: string): TraceEvent {
  const hook = record(raw)
  const status = String(hook.status ?? (completed ? 'completed' : 'running'))
  const event = hookEventName(hook.eventName)
  const entries = Array.isArray(hook.entries) ? hook.entries.map(record) : []
  const failed = completed && status !== 'completed'
  const source = projectHookSource(hook.source, hook.sourcePath, cwd)
  return newEvent(runId, {
    kind: 'hook',
    stage: completed ? 'hook_response' : 'hook_started',
    name: event,
    hookId: typeof hook.id === 'string' ? hook.id : undefined,
    hookEvent: event,
    hookName: typeof hook.statusMessage === 'string' ? hook.statusMessage : `${event}:${String(hook.handlerType ?? 'hook')}`,
    hookCommand: typeof hook.command === 'string' ? hook.command : undefined,
    hookOutcome: completed ? (status === 'completed' ? 'success' : status === 'stopped' ? 'cancelled' : 'error') : 'started',
    durationMs: typeof hook.durationMs === 'number' ? hook.durationMs : undefined,
    isError: failed,
    output: completed ? entries.map((entry) => String(entry.text ?? '')).filter(Boolean).join('\n') : undefined,
    input: {
      source: hook.source,
      sourcePath: source.sourcePath,
      ...(source.originalSourcePath ? { originalSourcePath: source.originalSourcePath } : {}),
      scope: hook.scope,
      handlerType: hook.handlerType,
      status,
      entries
    }
  })
}

function traceFromItem(
  runId: string,
  raw: unknown,
  completed: boolean,
  context: ItemTraceContext = {}
): TraceEvent[] {
  const item = record(raw)
  const type = String(item.type ?? '')
  const id = typeof item.id === 'string' ? item.id : undefined
  if (type === 'commandExecution') {
    const command = String(item.command ?? '')
    const input = { command, cwd: item.cwd }
    const mcp = parseMcp('Bash', input)
    const output = completed ? String(item.aggregatedOutput ?? '') : undefined
    const managementAction = /\bmcporter\s+list(?:\s|$)/.test(command) ? 'list' : undefined
    const identity = { agentId: context.agentId, parentToolUseId: context.parentToolUseId }
    const events = [
      newEvent(runId, completed
        ? {
            kind: 'tool',
            stage: 'tool_result',
            tool: 'Bash',
            toolUseId: id,
            output,
            durationMs: usageNumber(item.durationMs),
            isError: item.status === 'failed' || (mcp.isMcp && mcpPayloadFailed(output ?? item.aggregatedOutput)),
            ...identity,
            ...mcp,
            ...(managementAction ? { runtimeMetadata: { mcpManagementAction: managementAction } } : {})
          }
        : {
            kind: 'tool',
            stage: 'tool:Bash',
            tool: 'Bash',
            toolUseId: id,
            input,
            ...identity,
            ...mcp,
            ...(managementAction ? { runtimeMetadata: { mcpManagementAction: managementAction } } : {})
          })
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
            input: { source: 'skill_path_in_command', command },
            ...identity
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
        ? {
            kind: 'tool',
            stage: 'tool_result',
            tool: toolName,
            toolUseId: id,
            isMcp: true,
            mcpServer: server,
            mcpAction: tool,
            mcpTool: toolName,
            output: JSON.stringify(item.result ?? item.error ?? null),
            durationMs: usageNumber(item.durationMs),
            isError: !!item.error,
            ...context
          }
        : {
            kind: 'tool',
            stage: `tool:${toolName}`,
            tool: toolName,
            toolUseId: id,
            isMcp: true,
            mcpServer: server,
            mcpAction: tool,
            mcpTool: toolName,
            input: item.arguments,
            ...context
          })
    ]
  }
  if (type === 'dynamicToolCall') {
    const tool = String(item.tool ?? 'dynamicTool')
    return [
      newEvent(runId, completed
        ? {
            kind: 'tool',
            stage: 'tool_result',
            tool,
            toolUseId: id,
            output: JSON.stringify(item.contentItems ?? null),
            durationMs: usageNumber(item.durationMs),
            isError: item.success === false || item.status === 'failed',
            ...context
          }
        : {
            kind: 'tool',
            stage: `tool:${tool}`,
            tool,
            toolUseId: id,
            input: item.arguments,
            ...context
          })
    ]
  }
  if (type === 'collabAgentToolCall') {
    const collabTool = String(item.tool ?? 'collaboration')
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : []
    const promptName = typeof item.prompt === 'string'
      ? item.prompt.split(/\r?\n/, 1)[0]?.trim().slice(0, 40)
      : undefined
    const agentName = promptName || (typeof item.model === 'string' ? item.model : 'subagent')
    const input = {
      senderThreadId: item.senderThreadId,
      receiverThreadIds: receivers,
      prompt: item.prompt,
      model: item.model,
      reasoningEffort: item.reasoningEffort,
      agentsStates: item.agentsStates
    }
    if (collabTool === 'spawnAgent') {
      return [
        newEvent(runId, completed
          ? {
              kind: 'tool',
              stage: 'tool_result',
              tool: 'Agent',
              toolUseId: id,
              output: JSON.stringify(item.agentsStates ?? null),
              isError: item.status === 'failed',
              ...context
            }
          : {
              kind: 'agent',
              stage: `agent:${agentName}`,
              tool: 'Agent',
              toolUseId: id,
              name: agentName,
              input,
              ...context
            })
      ]
    }
    const tool = `collaboration:${collabTool}`
    return [
      newEvent(runId, completed
        ? {
            kind: 'tool',
            stage: 'tool_result',
            tool,
            toolUseId: id,
            output: JSON.stringify(item.agentsStates ?? null),
            isError: item.status === 'failed',
            ...context
          }
        : { kind: 'tool', stage: `tool:${tool}`, tool, toolUseId: id, input, ...context })
    ]
  }
  if (type === 'subAgentActivity') {
    const agentId = String(item.agentThreadId ?? context.agentId ?? '')
    if (item.kind !== 'started') {
      return [
        newEvent(runId, {
          kind: 'harness',
          stage: 'agent_activity',
          toolUseId: id,
          agentId: agentId || undefined,
          parentToolUseId: context.parentToolUseId,
          name: String(item.agentPath ?? (agentId || 'subagent')),
          input: {
            activity: item.kind,
            agentThreadId: agentId || undefined,
            agentPath: item.agentPath
          }
        })
      ]
    }
    const agentName = String(item.agentPath ?? (agentId || 'subagent')).replace(/^\/root\//, '')
    return [
      newEvent(runId, {
        kind: 'agent',
        stage: `agent:${agentName}`,
        tool: 'Agent',
        toolUseId: id,
        agentId: agentId || undefined,
        parentToolUseId: context.parentToolUseId,
        name: agentName,
        input: {
          activity: item.kind,
          agentThreadId: agentId || undefined,
          agentPath: item.agentPath
        }
      })
    ]
  }
  if (type === 'plan') {
    // `turn/plan/updated` 是一次真实 update_plan 调用；部分 app-server
    // 版本还会额外发送只读的 plan ThreadItem。这里只把 ThreadItem 当快照，
    // 避免同一次计划更新被重复计数。
    return []
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
        output: completed ? String(file.diff ?? '') : undefined,
        ...context
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
  const getClient = (cwd?: string, bypassHookTrust = false): CodexAppServerClient => {
    const bypass = bypassHookTrust || process.env.SCRY_CODEX_BYPASS_HOOK_TRUST?.trim() === '1'
    const key = `${cwd ?? ''}\0${bypass ? 'bypass' : 'trusted'}`
    const existing = clients.get(key)
    if (existing) {
      lastClient = existing
      return existing
    }
    const path = executable()
    if (!path) throw new Error('Codex CLI 未找到')
    if (lastErrorAt) restarts++
    const args = bypass ? ['--dangerously-bypass-hook-trust', 'app-server'] : undefined
    const client = new CodexAppServerClient({ command: path, args, cwd, env: runtimeCliEnv(shellEnv()) })
    clients.set(key, client)
    lastClient = client
    return client
  }

  const request = async <T>(
    method: string,
    params?: unknown,
    cwd?: string,
    bypassHookTrust = false
  ): Promise<T> => {
    try {
      const result = await getClient(cwd, bypassHookTrust).request<T>(method, params)
      lastOkAt = Date.now()
      lastError = undefined
      return result
    } catch (error) {
      lastErrorAt = Date.now()
      lastError = String((error as Error).message)
      throw error
    }
  }

  const inspectHookTrust = async (context: ProviderContext): Promise<CodexHookInspection> => {
    if (!context.cwd) throw new Error('Codex Hook 预检需要工作目录')
    const response = await request<{
      data?: Array<{ cwd?: string; hooks?: unknown[]; warnings?: unknown[]; errors?: unknown[] }>
    }>('hooks/list', { cwds: [context.cwd] }, context.cwd)
    const group = response.data?.find((item) => item.cwd === context.cwd) ?? response.data?.[0]
    if (!group) throw new Error(`Codex hooks/list 未返回当前工作目录：${context.cwd}`)
    const hooks: CodexHookMetadata[] = (group.hooks ?? []).map((raw) => {
      const item = record(raw)
      const trustStatus = String(item.trustStatus ?? '')
      if (!['managed', 'untrusted', 'trusted', 'modified'].includes(trustStatus)) {
        throw new Error(`Codex Hook 返回未知信任状态：${trustStatus || 'empty'}`)
      }
      const key = String(item.key ?? '')
      const currentHash = String(item.currentHash ?? '')
      if (!key || !currentHash) throw new Error('Codex Hook 缺少 key/currentHash，无法建立安全授权')
      return {
        key,
        eventName: String(item.eventName ?? 'hook'),
        source: String(item.source ?? 'unknown'),
        sourcePath: String(item.sourcePath ?? ''),
        enabled: item.enabled !== false,
        currentHash,
        trustStatus: trustStatus as CodexHookTrustStatus
      }
    })
    return {
      cwd: context.cwd,
      hooks,
      warnings: (group.warnings ?? []).map(String),
      errors: (group.errors ?? []).map(String)
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
        capabilities: { skills: 'manage', mcp: 'read', commands: 'read', account: 'read' },
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
      let lastSeenCumulativeUsage: TokenUsage | undefined
      let turnUsage: TokenUsage | undefined
      let lastRequestUsage: TokenUsage | undefined
      let modelContextWindow: number | undefined
      let model: string | undefined
      let modelProvider: string | undefined
      let serviceTier: string | null | undefined
      let authMode: string | undefined
      let accountPlan: string | undefined
      let accountReadError: string | undefined
      let lastTurnError: Record<string, unknown> | undefined
      let planUpdateSeq = 0
      const childAgents = new Map<string, { parentToolUseId?: string; name?: string }>()
      let finish: ((value: { externalSessionId?: string; stopped?: boolean; mcp?: McpSnapshot }) => void) | undefined

      const done = new Promise<{ externalSessionId?: string; stopped?: boolean; mcp?: McpSnapshot }>((resolve) => {
        finish = resolve
      })

      const promise = (async () => {
        try {
          const appServer = getClient(runRequest.cwd, runRequest.bypassHookTrust)
          await appServer.start()
          const accountPromise = appServer.request<Record<string, unknown>>('account/read', { refreshToken: false }).catch((error) => {
            accountReadError = String((error as Error).message)
            return null
          })
          unsubscribe = appServer.onNotification((method, value) => {
            const params = record(value)
            // 订阅建立到 thread/start 返回之间可能收到同一 app-server 上其他 run 的通知。
            // 在本 run 拿到 threadId 前一律忽略；之后接受本 thread 及由它显式 spawn 的子 thread。
            if (!externalSessionId) return
            const notificationThreadId = typeof params.threadId === 'string' ? params.threadId : undefined
            const child = notificationThreadId ? childAgents.get(notificationThreadId) : undefined
            const isRoot = notificationThreadId === externalSessionId
            if (!isRoot && !child) return
            if (isRoot && turnId && params.turnId && params.turnId !== turnId) return
            const traceContext: ItemTraceContext = child
              ? { agentId: notificationThreadId, parentToolUseId: child.parentToolUseId }
              : {}
            if (method === 'item/agentMessage/delta') {
              runRequest.emit(newEvent(runRequest.runId, {
                kind: 'model',
                stage: 'text_delta',
                text: String(params.delta ?? ''),
                ...traceContext
              }))
            } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
              runRequest.emit(newEvent(runRequest.runId, {
                kind: 'model',
                stage: 'thinking',
                thinking: String(params.delta ?? ''),
                ...traceContext
              }))
            } else if (method === 'item/started' || method === 'item/completed') {
              const item = record(params.item)
              if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
                const receiverThreadIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : []
                for (const receiverThreadId of receiverThreadIds) {
                  childAgents.set(receiverThreadId, {
                    parentToolUseId: typeof item.id === 'string' ? item.id : undefined,
                    name: typeof item.model === 'string' ? item.model : undefined
                  })
                }
              } else if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
                const existing = childAgents.get(item.agentThreadId)
                childAgents.set(item.agentThreadId, {
                  parentToolUseId: existing?.parentToolUseId ?? (typeof item.id === 'string' ? item.id : undefined),
                  name: typeof item.agentPath === 'string' ? item.agentPath : existing?.name
                })
              }
              for (const event of traceFromItem(
                runRequest.runId,
                item,
                method === 'item/completed',
                traceContext
              )) runRequest.emit(event)
            } else if (method === 'turn/plan/updated') {
              const planToolUseId = `plan:${String(params.turnId ?? turnId ?? 'turn')}:${++planUpdateSeq}`
              runRequest.emit(newEvent(runRequest.runId, {
                kind: 'tool',
                stage: 'tool:update_plan',
                tool: 'update_plan',
                toolUseId: planToolUseId,
                input: {
                  explanation: params.explanation,
                  plan: params.plan
                },
                ...traceContext
              }))
              runRequest.emit(newEvent(runRequest.runId, {
                kind: 'tool',
                stage: 'tool_result',
                tool: 'update_plan',
                toolUseId: planToolUseId,
                output: JSON.stringify({ explanation: params.explanation, plan: params.plan }),
                ...traceContext
              }))
              runRequest.emit(newEvent(runRequest.runId, {
                kind: 'harness',
                stage: 'plan_snapshot',
                input: {
                  explanation: params.explanation,
                  plan: params.plan
                },
                ...traceContext
              }))
            } else if (method === 'hook/started' || method === 'hook/completed') {
              runRequest.emit(traceFromHook(
                runRequest.runId,
                params.run,
                method === 'hook/completed',
                runRequest.cwd
              ))
            } else if (method === 'thread/tokenUsage/updated') {
              // Child threads report their own cumulative usage. It must not be added to the root turn.
              if (!isRoot) return
              const usage = record(params.tokenUsage) as unknown as ThreadTokenUsage
              const total = tokenUsage(usage.total)
              const last = tokenUsage(usage.last)
              const delta = usage.total
                ? lastSeenCumulativeUsage
                  ? subtractUsage(total, lastSeenCumulativeUsage)
                  : usage.last
                    ? last
                    : total
                : usage.last
                  ? last
                  : undefined
              if (delta) turnUsage = addUsage(turnUsage, delta)
              if (usage.total) lastSeenCumulativeUsage = total
              lastRequestUsage = usage.last ? last : undefined
              modelContextWindow = usageNumber(usage.modelContextWindow) ?? modelContextWindow
            } else if (method === 'turn/completed') {
              // A descendant finishing is not the root turn finishing.
              if (!isRoot) {
                const turn = record(params.turn)
                if (child?.parentToolUseId) {
                  runRequest.emit(newEvent(runRequest.runId, {
                    kind: 'tool',
                    stage: 'tool_result',
                    tool: 'Agent',
                    toolUseId: child.parentToolUseId,
                    name: child.name,
                    agentId: notificationThreadId,
                    output: JSON.stringify(turn),
                    isError: turn.status === 'failed'
                  }))
                }
                return
              }
              const turn = record(params.turn)
              const turnError = record(turn.error)
              const effectiveError = Object.keys(turnError).length > 0 ? turnError : lastTurnError
              const errorMessage = typeof effectiveError?.message === 'string' ? effectiveError.message : undefined
              const finalUsage = turnUsage ?? lastRequestUsage
              const billingProvider = authMode === 'apiKey' ? 'openai' : authMode === 'chatgpt' ? 'codex' : undefined
              const accountLabel = authMode === 'apiKey'
                ? 'OpenAI API key'
                : authMode === 'chatgpt' && accountPlan
                  ? `Codex ${accountPlan}`
                  : undefined
              runRequest.emit(newEvent(runRequest.runId, {
                kind: 'harness',
                stage: 'result',
                text: errorMessage,
                output: errorMessage,
                durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : undefined,
                tokensIn: finalUsage?.inputTokens,
                tokensOut: finalUsage?.outputTokens,
                cacheReadTokens: finalUsage?.cachedInputTokens,
                cacheCreationTokens: finalUsage?.cacheWriteInputTokens,
                reasoningTokens: finalUsage?.reasoningOutputTokens,
                contextTokens: lastRequestUsage?.inputTokens,
                isError: turn.status === 'failed',
                modelUsage: model ? [{
                  model,
                  inputTokens: finalUsage?.inputTokens,
                  outputTokens: finalUsage?.outputTokens,
                  cacheReadTokens: finalUsage?.cachedInputTokens,
                  cacheCreationTokens: finalUsage?.cacheWriteInputTokens,
                  reasoningTokens: finalUsage?.reasoningOutputTokens,
                  contextWindow: modelContextWindow,
                  billingProvider,
                  upstreamProvider: modelProvider ?? 'openai',
                  accountLabel,
                  usageSource: 'codex_app_server'
                }] : undefined,
                billingProvider,
                upstreamProvider: modelProvider ?? 'openai',
                accountLabel,
                usageSource: 'codex_app_server',
                runtimeMetadata: {
                  modelProvider: modelProvider ?? 'openai',
                  model,
                  serviceTier,
                  authMode,
                  accountPlan,
                  turnStatus: turn.status,
                  ...(effectiveError ? { turnError: effectiveError } : {})
                }
              }))
              finish?.({ externalSessionId, stopped })
            } else if (method === 'error') {
              const message = String(record(params.error).message ?? params.message ?? 'Codex app-server error')
              if (!isRoot) {
                runRequest.emit(newEvent(runRequest.runId, {
                  kind: 'harness',
                  stage: params.willRetry === true ? 'runtime:retry' : 'runtime:error',
                  text: message,
                  isError: params.willRetry !== true,
                  runtimeMetadata: {
                    willRetry: params.willRetry === true,
                    codexErrorInfo: record(params.error).codexErrorInfo,
                    additionalDetails: record(params.error).additionalDetails
                  },
                  ...traceContext
                }))
                return
              }
              if (params.willRetry === true) {
                runRequest.emit(newEvent(runRequest.runId, {
                  kind: 'harness',
                  stage: 'runtime:retry',
                  text: message,
                  runtimeMetadata: { willRetry: true, codexErrorInfo: record(params.error).codexErrorInfo }
                }))
              } else {
                lastTurnError = record(params.error)
                // The app-server follows this notification with authoritative turn/completed state.
                // Preserve the failure on the turn instead of rejecting early and losing its result row.
                runRequest.emit(newEvent(runRequest.runId, {
                  kind: 'harness',
                  stage: 'runtime:error',
                  text: message,
                  isError: true,
                  runtimeMetadata: {
                    willRetry: false,
                    codexErrorInfo: record(params.error).codexErrorInfo,
                    additionalDetails: record(params.error).additionalDetails
                  }
                }))
              }
            }
          })

          const thread = runRequest.resume
            ? await request<CodexThreadResponse>(
                'thread/resume',
                {
                  threadId: runRequest.resume,
                  cwd: runRequest.cwd,
                  excludeTurns: true,
                  ...CODEX_THREAD_ACCESS
                },
                runRequest.cwd,
                runRequest.bypassHookTrust
              )
            : await request<CodexThreadResponse>(
                'thread/start',
                { cwd: runRequest.cwd, ...CODEX_THREAD_ACCESS },
                runRequest.cwd,
                runRequest.bypassHookTrust
              )
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
          if (stopped) return { externalSessionId, stopped: true }
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
          }, runRequest.cwd, runRequest.bypassHookTrust)
          turnId = turn.turn.id
          if (stopped) {
            void request(
              'turn/interrupt',
              { threadId: externalSessionId, turnId },
              runRequest.cwd,
              runRequest.bypassHookTrust
            ).catch(() => {})
            return { externalSessionId, stopped: true }
          }
          return await done
        } finally {
          unsubscribe()
        }
      })()

      const interrupt = (): void => {
        stopped = true
        if (externalSessionId && turnId) {
          void request(
            'turn/interrupt',
            { threadId: externalSessionId, turnId },
            runRequest.cwd,
            runRequest.bypassHookTrust
          ).catch(() => {})
        }
      }

      return { promise, interrupt, getExternalSessionId: () => externalSessionId }
    },
    skills,
    commands: {
      list: async (context): Promise<CapabilityEnvelope<ProviderCommand[]>> => {
        const result = await skills.list(context)
        return {
          ...result,
          mode: 'read',
          data: result.data
            ? result.data
                .filter((skill) => skill.enabled)
                .map((skill) => ({
                  name: skill.name,
                  description: skill.description || 'Codex Skill',
                  source: 'skill' as const
                }))
            : null
        }
      }
    },
    hookTrust: { inspect: inspectHookTrust },
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
