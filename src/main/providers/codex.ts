import {
  capabilityReady,
  capabilityUnknown,
  type AccountSnapshot,
  type CapabilityEnvelope,
  type ProviderCommand,
  type ProviderContext,
  type SkillMeta
} from '../../shared/provider'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  type AgentPermissionMode,
  type AgentRunControlCatalog
} from '../../shared/runtime'
import { mcpPayloadFailed, parseMcp, type TraceEvent } from '../../shared/trace'
import { resolveRuntimeCliBin, runtimeCliEnv } from '../claude-locate'
import type {
  CodexHookInspection,
  CodexHookMetadata,
  CodexHookTrustGrant,
  CodexHookTrustStatus
} from '../codex-hook-trust'
import {
  CodexAppServerClient,
  type CodexNotificationEnvelope
} from './codex-app-server'
import { createCodexIsolatedHome } from './codex-isolated-home'
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from './types'
import { effortOption, permissionOptions } from './run-controls'

function codexAccess(mode: AgentPermissionMode | undefined): {
  approvalPolicy: 'never' | 'on-request'
  approvalsReviewer?: 'user' | 'auto_review'
  sandbox: 'workspace-write' | 'danger-full-access'
} {
  if (mode === 'full_access') {
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: mode === 'auto_review' ? 'auto_review' : 'user',
    sandbox: 'workspace-write'
  }
}

interface CodexThreadResponse {
  thread: { id: string }
  model?: string
  modelProvider?: string
  serviceTier?: string | null
}

interface CodexTurnResponse {
  turn: {
    id: string
    startedAt?: number | null
  }
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

const newEventAt = (
  runId: string,
  observedAtMs: number,
  fields: Omit<TraceEvent, 'id' | 'runId' | 'ts'>
): TraceEvent => ({
  id: `codex-${observedAtMs.toString(36)}-${(eventCounter++).toString(36)}`,
  runId,
  ts: new Date(observedAtMs).toISOString(),
  ...fields
})

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

function canonicalTurnStatus(
  nativeStatus: unknown,
  stopped: boolean
): NonNullable<ProviderRunResult['status']> {
  if (nativeStatus === 'completed') return 'completed'
  if (nativeStatus === 'failed') return 'failed'
  if (nativeStatus === 'cancelled' || nativeStatus === 'canceled') return 'cancelled'
  if (nativeStatus === 'interrupted') return 'interrupted'
  if (stopped) return 'interrupted'
  return 'failed'
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

const epochMilliseconds = (value: unknown): number | undefined => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : undefined
  if (numeric == null || !Number.isFinite(numeric) || numeric < 0) return undefined
  return numeric < 100_000_000_000 ? numeric * 1_000 : numeric
}

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

export function createCodexAdapter(
  isolatedHomePath?: string,
  legacySessionIds: () => readonly string[] = () => []
): ProviderAdapter {
  const clients = new Map<string, CodexAppServerClient>()
  const modelCache = new Map<string, { data: AgentRunControlCatalog; observedAt: number }>()
  let lastClient: CodexAppServerClient | null = null
  let lastOkAt: number | undefined
  let lastErrorAt: number | undefined
  let lastError: string | undefined
  let restarts = 0
  const MODEL_TTL_MS = 30_000
  let isolatedHome: ReturnType<typeof createCodexIsolatedHome> | undefined

  const executable = (): string | undefined => process.env.SCRY_CODEX_PATH?.trim() || resolveRuntimeCliBin('codex')
  const getClient = (cwd?: string, hookTrust: CodexHookTrustGrant[] = []): CodexAppServerClient => {
    const trustedHooks = [...hookTrust].sort((left, right) => left.key.localeCompare(right.key))
    const trustKey = trustedHooks.map((hook) => `${hook.key}\0${hook.currentHash}`).join('\n')
    const key = `${cwd ?? ''}\0${trustKey}`
    const existing = clients.get(key)
    if (existing) {
      lastClient = existing
      return existing
    }
    const path = executable()
    if (!path) throw new Error('Codex CLI 未找到')
    if (lastErrorAt) restarts++
    const env = runtimeCliEnv(undefined, { managedRecorder: true })
    const sourceHome = process.env.SCRY_CODEX_SOURCE_HOME?.trim() || env.CODEX_HOME?.trim() || undefined
    delete env.SCRY_CODEX_SOURCE_HOME
    isolatedHome ??= createCodexIsolatedHome(
      sourceHome,
      isolatedHomePath,
      legacySessionIds()
    )
    const appServerArgs = [
      'app-server',
      '--strict-config',
      '--disable', 'apps',
      '--disable', 'plugins',
      '--disable', 'remote_plugin',
      '--disable', 'external_migration',
      '--disable', 'skill_mcp_dependency_install'
    ]
    const projectTrustArgs = cwd
      ? ['-c', `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`]
      : []
    const hookTrustArgs = trustedHooks.length > 0
      ? ['-c', `hooks={state={${trustedHooks.map((hook) =>
          `${JSON.stringify(hook.key)}={trusted_hash=${JSON.stringify(hook.currentHash)}}`
        ).join(',')}}}`]
      : []
    const args = [
      ...projectTrustArgs,
      ...hookTrustArgs,
      ...appServerArgs
    ]
    const client = new CodexAppServerClient({
      command: path,
      args,
      cwd,
      env: { ...env, CODEX_HOME: isolatedHome.path }
    })
    clients.set(key, client)
    lastClient = client
    return client
  }

  const request = async <T>(
    method: string,
    params?: unknown,
    cwd?: string,
    hookTrust: CodexHookTrustGrant[] = []
  ): Promise<T> => {
    try {
      const result = await getClient(cwd, hookTrust).request<T>(method, params)
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
          ? { ...capabilityReady(context, 'read' as const, data), state: 'degraded' as const, reason: `${errors} 个 Skill 读取错误` }
          : capabilityReady(context, 'read' as const, data)
      } catch (error) {
        return capabilityUnknown<SkillMeta[]>(context, 'read', String((error as Error).message))
      }
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
        capabilities: { skills: 'read', mcp: 'none', commands: 'read', account: 'read' },
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
      let unsubscribeRequest = () => {}
      const approvalControllers = new Set<AbortController>()
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
      type ResponseTimingState = {
        boundaryMs?: number
        responses: Set<string>
        responseSource?: 'raw_response' | 'agent_message_item'
      }
      const timingByThread = new Map<string, ResponseTimingState>()
      let finish: ((value: ProviderRunResult) => void) | undefined

      const handleApprovalRequest = async (method: string, value: unknown): Promise<unknown> => {
        if ((runRequest.permissionMode ?? 'default') === 'full_access') return undefined
        const params = record(value)
        const requestThreadId = typeof params.threadId === 'string' ? params.threadId : undefined
        if (!externalSessionId || (requestThreadId !== externalSessionId && !childAgents.has(requestThreadId ?? ''))) {
          return undefined
        }
        if (![
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/permissions/requestApproval'
        ].includes(method)) return undefined
        if (!runRequest.requestUserInput) {
          if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
          return { decision: 'decline' }
        }
        const command = typeof params.command === 'string' ? params.command : undefined
        const reason = typeof params.reason === 'string' ? params.reason : undefined
        const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : undefined
        const detail = command ?? reason ?? grantRoot ?? JSON.stringify(params.permissions ?? {}).slice(0, 1_200)
        const itemId = String(params.approvalId ?? params.itemId ?? `${Date.now()}`)
        const questionText = method === 'item/commandExecution/requestApproval'
          ? '允许 Codex 执行这条命令吗？'
          : method === 'item/fileChange/requestApproval'
            ? '允许 Codex 修改工作区文件吗？'
            : '允许 Codex 获取额外权限吗？'
        const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
        const allowSession = method !== 'item/commandExecution/requestApproval' || available.includes('acceptForSession')
        const question = agentPermissionQuestion(
          runRequest.runId,
          `codex:${method}:${itemId}`,
          'Codex 权限',
          questionText,
          detail,
          allowSession
        )
        const controller = new AbortController()
        approvalControllers.add(controller)
        try {
          const response = await runRequest.requestUserInput(question, controller.signal)
          const decision = agentPermissionDecision(question, response)
          if (method === 'item/permissions/requestApproval') {
            return {
              permissions: decision === 'reject' ? {} : record(params.permissions),
              scope: decision === 'session' ? 'session' : 'turn'
            }
          }
          return {
            decision: decision === 'reject'
              ? 'decline'
              : decision === 'session' && allowSession
                ? 'acceptForSession'
                : 'accept'
          }
        } finally {
          approvalControllers.delete(controller)
        }
      }

      const notificationAt = (envelope?: CodexNotificationEnvelope): number =>
        envelope?.emittedAtMs ?? envelope?.receivedAtMs ?? Date.now()

      const timingState = (
        threadId: string,
        fallbackBoundaryMs?: number
      ): ResponseTimingState => {
        const existing = timingByThread.get(threadId)
        if (existing) {
          if (existing.boundaryMs == null && fallbackBoundaryMs != null) existing.boundaryMs = fallbackBoundaryMs
          return existing
        }
        const created: ResponseTimingState = { boundaryMs: fallbackBoundaryMs, responses: new Set<string>() }
        timingByThread.set(threadId, created)
        return created
      }

      const advanceTimingBoundary = (threadId: string | undefined, atMs: number): void => {
        if (!threadId || !Number.isFinite(atMs)) return
        const state = timingState(threadId)
        state.boundaryMs = state.boundaryMs == null ? atMs : Math.max(state.boundaryMs, atMs)
      }

      const emitObservedResponse = (
        threadId: string,
        responseId: string,
        observedAtMs: number,
        traceContext: ItemTraceContext,
        source: 'raw_response' | 'agent_message_item'
      ): void => {
        const state = timingState(threadId)
        if (state.responseSource && state.responseSource !== source) return
        state.responseSource = source
        if (state.responses.has(responseId)) return
        state.responses.add(responseId)
        const boundaryMs = state.boundaryMs
        const durationMs =
          boundaryMs != null && observedAtMs >= boundaryMs
            ? observedAtMs - boundaryMs
            : undefined
        runRequest.emit(newEventAt(runRequest.runId, observedAtMs, {
          kind: 'model',
          stage: 'response_completed',
          messageId: responseId,
          ...(durationMs != null ? { durationMs } : {}),
          runtimeMetadata: {
            codexResponseId: responseId,
            timingSource: 'observed',
            timingBoundary: 'turn_or_activity_end',
            timingEvent: source
          },
          ...traceContext
        }))
        state.boundaryMs = observedAtMs
      }

      const done = new Promise<ProviderRunResult>((resolve) => {
        finish = resolve
      })

      const promise = (async (): Promise<ProviderRunResult> => {
        try {
          const appServer = getClient(runRequest.cwd, runRequest.codexHookTrust)
          await appServer.start()
          const generationFailure = appServer.failureForCurrentGeneration()
          unsubscribeRequest = appServer.onRequest(handleApprovalRequest)
          const accountPromise = appServer.request<Record<string, unknown>>('account/read', { refreshToken: false }).catch((error) => {
            accountReadError = String((error as Error).message)
            return null
          })
          unsubscribe = appServer.onNotification((method, value, envelope) => {
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
            const observedAtMs = notificationAt(envelope)
            if (method === 'turn/started') {
              const turn = record(params.turn)
              if (notificationThreadId) {
                const state = timingState(notificationThreadId)
                if (state.responses.size === 0) {
                  state.boundaryMs = epochMilliseconds(turn.startedAt) ?? observedAtMs
                }
              }
            } else if (method === 'item/agentMessage/delta') {
              runRequest.emit(newEventAt(runRequest.runId, observedAtMs, {
                kind: 'model',
                stage: 'text_delta',
                text: String(params.delta ?? ''),
                runtimeMetadata: {
                  codexItemId: typeof params.itemId === 'string' ? params.itemId : undefined
                },
                ...traceContext
              }))
            } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
              runRequest.emit(newEventAt(runRequest.runId, observedAtMs, {
                kind: 'model',
                stage: 'thinking',
                thinking: String(params.delta ?? ''),
                runtimeMetadata: {
                  codexItemId: typeof params.itemId === 'string' ? params.itemId : undefined
                },
                ...traceContext
              }))
            } else if (method === 'rawResponse/completed') {
              if (!notificationThreadId) return
              const responseId = typeof params.responseId === 'string' ? params.responseId : undefined
              if (!responseId) return
              emitObservedResponse(notificationThreadId, responseId, observedAtMs, traceContext, 'raw_response')
            } else if (method === 'item/started' || method === 'item/completed') {
              const item = record(params.item)
              if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
                const receiverThreadIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : []
                for (const receiverThreadId of receiverThreadIds) {
                  childAgents.set(receiverThreadId, {
                    parentToolUseId: typeof item.id === 'string' ? item.id : undefined,
                    name: typeof item.model === 'string' ? item.model : undefined
                  })
                  timingState(receiverThreadId, observedAtMs)
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
              if (method === 'item/completed') {
                const type = String(item.type ?? '')
                if (type === 'agentMessage' && notificationThreadId && typeof item.id === 'string') {
                  emitObservedResponse(
                    notificationThreadId,
                    item.id,
                    observedAtMs,
                    traceContext,
                    'agent_message_item'
                  )
                } else if ([
                  'commandExecution',
                  'mcpToolCall',
                  'dynamicToolCall',
                  'collabAgentToolCall',
                  'fileChange'
                ].includes(type)) {
                  const completedAtMs =
                    usageNumber(params.completedAtMs) ?? observedAtMs
                  advanceTimingBoundary(notificationThreadId, completedAtMs)
                }
              }
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
              if (method === 'hook/completed') {
                const run = record(params.run)
                const completedAtMs = epochMilliseconds(run.completedAt) ?? observedAtMs
                advanceTimingBoundary(notificationThreadId, completedAtMs)
              }
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
              finish?.({
                externalSessionId,
                providerTurnId: turnId,
                stopped,
                status: canonicalTurnStatus(turn.status, stopped)
              })
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

          const access = codexAccess(runRequest.permissionMode)
          const thread = runRequest.resume
            ? await request<CodexThreadResponse>(
                'thread/resume',
                {
                  threadId: runRequest.resume,
                  cwd: runRequest.cwd,
                  excludeTurns: true,
                  ...access,
                  ...(runRequest.model ? { model: runRequest.model.id } : {})
                },
                runRequest.cwd,
                runRequest.codexHookTrust
              )
            : await request<CodexThreadResponse>(
                'thread/start',
                {
                  cwd: runRequest.cwd,
                  ...access,
                  ...(runRequest.model ? { model: runRequest.model.id } : {})
                },
                runRequest.cwd,
                runRequest.codexHookTrust
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
          if (stopped) return { externalSessionId, stopped: true, status: 'interrupted' }
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
            approvalPolicy: access.approvalPolicy,
            ...(access.approvalsReviewer ? { approvalsReviewer: access.approvalsReviewer } : {}),
            ...(runRequest.model ? { model: runRequest.model.id } : {}),
            ...(runRequest.effort ? { effort: runRequest.effort } : {})
          }, runRequest.cwd, runRequest.codexHookTrust)
          turnId = turn.turn.id
          if (externalSessionId) {
            const startedAtMs = epochMilliseconds(turn.turn.startedAt) ?? Date.now()
            const state = timingState(externalSessionId)
            if (state.responses.size === 0 && state.boundaryMs == null) state.boundaryMs = startedAtMs
          }
          if (stopped) {
            void request(
              'turn/interrupt',
              { threadId: externalSessionId, turnId },
              runRequest.cwd,
              runRequest.codexHookTrust
            ).catch(() => {})
            return {
              externalSessionId,
              providerTurnId: turnId,
              stopped: true,
              status: 'interrupted'
            }
          }
          return await Promise.race([
            done,
            generationFailure.then((error) => Promise.reject(error))
          ])
        } finally {
          unsubscribe()
          unsubscribeRequest()
          for (const controller of approvalControllers) controller.abort()
          approvalControllers.clear()
        }
      })()

      const interrupt = (): void => {
        stopped = true
        for (const controller of approvalControllers) controller.abort()
        if (externalSessionId && turnId) {
          void request(
            'turn/interrupt',
            { threadId: externalSessionId, turnId },
            runRequest.cwd,
            runRequest.codexHookTrust
          ).catch(() => {})
        }
      }

      return {
        promise,
        interrupt,
        getExternalSessionId: () => externalSessionId,
        getProviderTurnId: () => turnId
      }
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
    runControls: {
      read: async (context) => {
        try {
          const key = context.cwd ?? ''
          let value = modelCache.get(key)
          if (!value || Date.now() - value.observedAt >= MODEL_TTL_MS) {
            const response = await request<{ data?: unknown[] }>(
              'model/list',
              { includeHidden: false },
              context.cwd
            )
            const models = (response.data ?? []).map((raw) => {
              const item = record(raw)
              const efforts = Array.isArray(item.supportedReasoningEfforts)
                ? item.supportedReasoningEfforts.map((rawEffort) => {
                    const entry = record(rawEffort)
                    const id = String(entry.reasoningEffort ?? '')
                    return effortOption(
                      id,
                      typeof entry.description === 'string' ? entry.description : undefined,
                      id === item.defaultReasoningEffort
                    )
                  }).filter((effort) => effort.id)
                : []
              return {
                model: { id: String(item.model ?? item.id ?? '') },
                label: String(item.displayName ?? item.model ?? item.id ?? ''),
                description: typeof item.description === 'string' ? item.description : undefined,
                isDefault: item.isDefault === true,
                efforts
              }
            }).filter((model) => model.model.id)
            value = {
              data: { models, permissions: permissionOptions() },
              observedAt: Date.now()
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
    dispose: async () => {
      await Promise.all([...clients.values()].map((client) => client.shutdown()))
      clients.clear()
      lastClient = null
      isolatedHome?.cleanup()
      isolatedHome = undefined
    }
  }
}
