import { homedir } from 'node:os'
import {
  forkSession,
  getSessionMessages,
  query,
  type McpServerConfig,
  type McpServerStatus,
  type ModelInfo,
  type SlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import { getClaudeVersion, runAgent } from '../agent-runner'
import { extractUserText } from '../normalize'
import { resolveClaudeBin } from '../claude-locate'
import { claudeContinuationKey } from './continuation-identity'
import { completedTranscriptTurnBoundary } from './session-fork-boundary'
import {
  authorizedMcpServers,
  isRemoteMcpConfig,
  listMcp,
  testMcpConfig
} from '../mcp-config'
import { computeEnabledSkills, listSkills } from '../skill-config'
import {
  capabilityReady,
  capabilityUnknown,
  capabilityUnavailable,
  type McpMeta,
  type McpSnapshot,
  type ProviderContext
} from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import type { McpLiveStatus } from '../../shared/trace'
import type { AuthorizedMcpExecution, ProviderAdapter } from './types'
import { HistoricalInput } from './historical-input'
import { HISTORY_READER_SERVER, historyReaderEnvironment } from '../conversation-history-reader'
import { workflowAuthoringSchema } from '../workflow-authoring'
import { effortOption, permissionOptions } from './run-controls'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import { runClaudeMcpLogin, type ClaudeMcpLogin } from './claude-mcp-auth'
import { claudeRuntimeEnv, claudeRuntimeEnvForExecution, heldPrompt, settingSourcesFromEnv } from './claude-runtime'

export { claudeMcpLoginArgs, runClaudeMcpLogin } from './claude-mcp-auth'

interface CachedControls {
  data: AgentRunControlCatalog
  commands: SlashCommand[]
  observedAt: number
}

const CONTROL_TTL_MS = 30_000
const MCP_STATUS_TIMEOUT_MS = 15_000

function authenticationTargets(configured: McpMeta[]): string[] {
  const nameCounts = new Map<string, number>()
  for (const item of configured) {
    if (item.enabled) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1)
  }
  return configured
    .filter((item) => item.enabled && nameCounts.get(item.name) === 1 && item.transport === 'http' && item.targetId)
    .map((item) => item.targetId as string)
}

function claudeMcpSnapshot(configured: McpMeta[], statuses: McpServerStatus[]): McpSnapshot {
  const runtime: McpLiveStatus[] = statuses.map((server) => ({
    name: server.name,
    status: server.status,
    serverName: server.serverInfo?.name,
    serverVersion: server.serverInfo?.version,
    tools: server.tools?.length,
    toolNames: server.tools?.map((tool) => tool.name)
  }))
  for (const item of configured) {
    if (!item.enabled && !runtime.some((status) => status.name === item.name)) {
      runtime.push({ name: item.name, status: 'disabled' })
    }
  }
  return { configured, runtime, operations: { authenticate: authenticationTargets(configured) } }
}

async function readClaudeMcpStatus(
  executable: string,
  execution: AuthorizedMcpExecution
): Promise<McpServerStatus[]> {
  const prompt = heldPrompt()
  const q = query({
    prompt: prompt.stream,
    options: {
      cwd: execution.cwd,
      pathToClaudeCodeExecutable: executable,
      env: claudeRuntimeEnvForExecution(execution),
      settingSources: settingSourcesFromEnv(),
      strictMcpConfig: true,
      mcpServers: authorizedMcpServers(execution) as Record<string, McpServerConfig>
    }
  })
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      (async () => {
        await q.initializationResult()
        return await q.mcpServerStatus()
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Claude Code MCP 状态校验超时')), MCP_STATUS_TIMEOUT_MS)
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    prompt.release()
    q.close()
  }
}

export function createClaudeAdapter(homeDir = homedir(), login: ClaudeMcpLogin = runClaudeMcpLogin): ProviderAdapter {
  let claudePath: string | undefined
  let pathResolved = false
  const controlCache = new Map<string, CachedControls>()
  const pendingControls = new Map<string, Promise<CachedControls>>()
  const controlGenerations = new Map<string, number>()

  const executable = (): string | undefined => {
    if (!pathResolved) {
      claudePath = resolveClaudeBin()
      pathResolved = true
    }
    return claudePath
  }

  const readControls = async (context: ProviderContext): Promise<CachedControls> => {
    const key = context.cwd ?? ''
    const cached = controlCache.get(key)
    if (cached && Date.now() - cached.observedAt < CONTROL_TTL_MS) return cached
    const pending = pendingControls.get(key)
    if (pending) return pending
    const generation = controlGenerations.get(key) ?? 0
    const load = (async () => {
      const path = executable()
      if (!path) throw new Error('Claude Code executable 未找到')
      const prompt = heldPrompt()
      const q = query({
        prompt: prompt.stream,
        options: {
          cwd: context.cwd,
          pathToClaudeCodeExecutable: path,
          env: claudeRuntimeEnv(),
          settingSources: settingSourcesFromEnv(),
          strictMcpConfig: true,
          mcpServers: {}
        }
      })
      try {
        const [models, commands] = await Promise.all([q.supportedModels(), q.supportedCommands()])
        const value = {
          observedAt: Date.now(),
          commands,
          data: {
            models: models.map((model: ModelInfo) => ({
              model: { id: model.value },
              label: model.displayName,
              description: model.description,
              efforts: (model.supportedEffortLevels ?? []).map((effort) => effortOption(effort))
            })),
            permissions: permissionOptions({ autoAcceptEdits: true, autoReview: true })
          }
        }
        if ((controlGenerations.get(key) ?? 0) === generation) controlCache.set(key, value)
        return value
      } finally {
        prompt.release()
        q.close()
      }
    })()
    pendingControls.set(key, load)
    try {
      return await load
    } finally {
      if (pendingControls.get(key) === load) pendingControls.delete(key)
    }
  }

  return {
    id: 'claude',
    runtimeProvider: 'claude_sdk',
    workflowExecution: { independentRun: true, terminalOutput: true, scopedStop: true, scopeSettlement: true },
    workflowAuthoring: { source: 'claude_sdk_success_result' },
    historicalContext: true,
    historyReader: true,
    continuationKey: (context) => {
      const env = claudeRuntimeEnv()
      if (!env.HOME) throw new Error('Claude runtime HOME 不可用，无法确认接续身份')
      return claudeContinuationKey(context, env.HOME, executable(), {
        ...env, SCRY_CLAUDE_SETTING_SOURCES: JSON.stringify(settingSourcesFromEnv())
      })
    },
    describe: async () => {
      const path = executable()
      return {
        id: 'claude',
        label: 'Claude Code',
        runtimeProvider: 'claude_sdk',
        transport: 'Agent SDK',
        available: !!path,
        path,
        version: getClaudeVersion(),
        capabilities: { skills: 'read', mcp: 'manage', commands: 'read', account: 'none' }
      }
    },
    forkLastTurn: {
      async fork(request) {
        const messages = await getSessionMessages(request.sourceSessionId, {
          dir: request.cwd,
          includeSystemMessages: true
        })
        const nativeIndex = messages.findIndex((message) =>
          typeof (message as { uuid?: unknown }).uuid === 'string' &&
          (message as { uuid: string }).uuid === request.replaceForkTurnId
        )
        const promptIndex = messages.findLastIndex((message) => {
          const raw = message as unknown as { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } }
          return raw.type === 'user' && raw.parent_tool_use_id == null &&
            extractUserText(raw.message?.content).trim() === request.originalPrompt.trim()
        })
        const index = nativeIndex >= 0 ? nativeIndex : promptIndex
        const boundary = index > 0 ? (messages[index - 1] as { uuid?: unknown }).uuid : undefined
        if (typeof boundary !== 'string' || !boundary) throw new Error('Claude 会话无法定位待替换消息的前一边界')
        const forked = await forkSession(request.sourceSessionId, {
          dir: request.cwd,
          upToMessageId: boundary,
          title: 'Edited branch'
        })
        return { externalSessionId: forked.sessionId }
      }
    },
    forkSession: {
      async fork(request) {
        if (request.expectedContinuationKey) {
          const env = claudeRuntimeEnv()
          // SDK session helpers use the host environment, unlike query's explicit env.
          if (env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR || (env.HOME ?? homedir()) !== (process.env.HOME ?? homedir())) {
            throw new Error('Claude SDK 分支目录与运行时配置不一致，不能证明原生分支归属')
          }
        }
        const messages = await getSessionMessages(request.sourceSessionId, {
          dir: request.cwd,
          includeSystemMessages: true
        })
        const boundary = completedTranscriptTurnBoundary(messages, request.sourceForkTurnId, 'Claude')
        await request.beforeFork?.()
        const forked = await forkSession(request.sourceSessionId, {
          dir: request.cwd,
          upToMessageId: boundary,
          title: 'Scry branch'
        })
        return { externalSessionId: forked.sessionId }
      }
    },
    run: (request) => {
      const env = claudeRuntimeEnvForExecution(request.mcpExecution, request.managedRecorder === true, request.managedRecorderIdentity)
      const settingSources = settingSourcesFromEnv()
      const claudePath = executable()
      const history = new HistoricalInput(request)
      const prompt = history.text(request.prompt)
      const mcpServers = { ...authorizedMcpServers(request.mcpExecution) }
      if (request.expectedContinuationKey || request.historyReader) {
        try {
          if (request.historyReader && mcpServers[HISTORY_READER_SERVER]) throw new Error('仓库 MCP 名称与 App 历史检索服务冲突')
          if (request.expectedContinuationKey) {
            if (!env.HOME) throw new Error('Claude runtime HOME 不可用，输入未投递')
            const identity = claudeContinuationKey({ providerId: 'claude', cwd: request.cwd, agentProfileId: request.agentProfileId },
              env.HOME, claudePath, { ...env, SCRY_CLAUDE_SETTING_SOURCES: JSON.stringify(settingSources) })
            if (identity !== request.expectedContinuationKey) throw new Error('Claude 接续身份已变化，请重新预览')
          }
        } catch (error) {
          // No SDK or child exists yet. Return a failed handle so the caller can
          // retain not_sent evidence; SDK exceptions below remain unknown.
          return {
            promise: Promise.reject(error),
            interrupt: () => {},
            forceKill: () => {},
            forceKillScope: 'run_scoped',
            getExternalSessionId: () => undefined,
            getInputReceipt: () => history.snapshot()
          }
        }
      }
      if (request.historyReader) mcpServers[HISTORY_READER_SERVER] = {
        type: 'http', url: request.historyReader.url, headers: { Authorization: `Bearer ${request.historyReader.token}` }
      }
      const handle = runAgent(
        prompt,
        request.runId,
        (event) =>
          request.emit(
            event.kind === 'harness' && event.stage === 'result'
              ? {
                  ...event,
                  billingProvider: 'anthropic',
                  upstreamProvider: 'anthropic',
                  usageSource: 'claude_sdk',
                  modelUsage: event.modelUsage?.map((usage) => ({
                    ...usage,
                    billingProvider: 'anthropic',
                    upstreamProvider: 'anthropic',
                    usageSource: 'claude_sdk'
                  }))
                }
              : event
          ),
        {
          resume: request.resume,
          cwd: request.mcpExecution?.cwd ?? request.cwd,
          ...(request.purpose ? { authoringSchema: request.authoringSchema ?? workflowAuthoringSchema } : {}),
          skills: request.purpose ? [] : computeEnabledSkills(request.cwd, env.HOME ?? homeDir),
          claudePath,
          env: request.historyReader ? historyReaderEnvironment(env) : env,
          settingSources,
          onSessionId: request.onExternalSessionId,
          onInputAttempt: () => history.attempting(prompt),
          captureProviderTurnId: true,
          attachments: request.attachments,
          requestUserInput: request.requestUserInput,
          model: request.model?.id,
          effort: request.effort,
          permissionMode: request.permissionMode,
          mcpServers,
          historyReader: request.historyReader,
          recordNative: request.recordNative,
          onWorkflowObservation: request.onWorkflowObservation
        }
      )
      return {
        promise: handle.promise.then((result) => {
          // A hook / session id is not acceptance. A successful SDK result belongs
          // to this query; failed or interrupted queries remain unknown for now.
          if (result.status === 'completed' && !result.stopped && result.sessionId) {
            history.accepted(result.sessionId, 'claude_sdk_success_result', result.providerTurnId)
          }
          return {
            externalSessionId: result.sessionId,
            providerTurnId: result.providerTurnId,
            stopped: result.stopped,
            status: result.status,
            ...(result.structuredOutput ? { structuredOutput: result.structuredOutput } : {}),
            mcp: result.mcpStatus ? { configured: listMcp(request.cwd, homeDir), runtime: result.mcpStatus } : undefined
          }
        }),
        getInputReceipt: () => history.snapshot(),
        interrupt: handle.interrupt,
        forceKill: handle.forceKill,
        // SDK query 每轮自己 spawn 一个 CLI 子进程：SIGKILL 只作用于本 run 的进程组。
        forceKillScope: 'run_scoped',
        getExternalSessionId: handle.getSessionId,
        getProviderTurnId: handle.getProviderTurnId
      }
    },
    invalidateContext(context) {
      const key = context.cwd ?? ''
      controlGenerations.set(key, (controlGenerations.get(key) ?? 0) + 1)
      controlCache.delete(key)
      pendingControls.delete(key)
    },
    skills: {
      list: async (context) => capabilityReady(context, 'read', listSkills(context.cwd, homeDir))
    },
    mcp: {
      snapshot: async (context, refresh = false, execution) => {
        const path = executable()
        if (!path) return capabilityUnavailable(context, 'unknown', 'Claude Code executable 未找到')
        const configured = listMcp(context.cwd, homeDir)
        const operations = { authenticate: authenticationTargets(configured) }
        if (!refresh) {
          return {
            ...capabilityReady(context, 'manage', { configured, runtime: null, operations }),
            state: 'degraded' as const,
            reason: '运行态尚未直接检测；刷新会读取 Claude Code 原生 MCP 状态，不会发起模型对话'
          }
        }
        if (!execution) return capabilityUnavailable(context, 'unknown', '缺少绑定当前配置快照的 MCP 执行授权')
        try {
          return capabilityReady(context, 'manage', claudeMcpSnapshot(
            configured,
            await readClaudeMcpStatus(path, execution)
          ))
        } catch (error) {
          return capabilityUnavailable(context, 'unknown', sanitizeMcpAuthError(error))
        }
      },
      test: async (context, targetId, execution) => {
        if (!execution) return capabilityReady(context, 'manage', { ok: false, error: '缺少绑定当前配置快照的 MCP 执行授权' })
        const target = execution.targets.find((item) => item.targetId === targetId)
        if (!target) return capabilityReady(context, 'manage', { ok: false, error: '找不到精确配置目标' })
        return capabilityReady(context, 'manage', await testMcpConfig(target.config, execution.env, execution.cwd))
      },
      reauthenticate: async (context, targetId, execution) => {
        const failed = (error: unknown, authenticated = false) => capabilityReady(context, 'manage', {
          ok: false,
          status: authenticated ? 'authenticated-unverified' as const : 'failed' as const,
          error: sanitizeMcpAuthError(error)
        })
        const path = executable()
        if (!path) return failed('Claude Code executable 未找到')
        if (!execution) return failed('缺少绑定当前配置快照的 MCP 执行授权')
        if (execution.cwd !== context.cwd) return failed('MCP 执行授权与当前工作目录不匹配')
        const target = execution.targets.find((item) => item.targetId === targetId)
        if (!target) return failed('找不到精确配置目标')
        if (!target.enabled) return failed('当前 MCP 已停用')
        if (!isRemoteMcpConfig(target.config)) return failed('stdio MCP 不支持 OAuth 认证')
        if (execution.targets.some((item) => item.targetId !== targetId && item.enabled && item.name === target.name)) {
          return failed(`Claude Code 存在多个同名 MCP ${target.name}，无法安全绑定认证目标`)
        }
        const result = await login(path, target.name, target.config, execution.cwd, claudeRuntimeEnv())
        if (!result.ok) return failed(result.error || 'Claude MCP 认证失败')
        try {
          const statuses = await readClaudeMcpStatus(path, {
            ...execution,
            targets: [target]
          })
          const status = statuses.find((item) => item.name === target.name)
          if (status?.status !== 'connected') {
            return failed(status?.status === 'needs-auth'
              ? 'Claude Code 完成认证后仍报告需要登录'
              : `Claude Code 完成认证后连接状态为 ${status?.status ?? 'unknown'}`, true)
          }
          return capabilityReady(context, 'manage', result)
        } catch (error) {
          return failed(`认证已完成，但原生状态校验失败：${sanitizeMcpAuthError(error)}`, true)
        }
      }
    },
    commands: {
      list: async (context) => {
        if (!executable()) return capabilityUnavailable(context, 'unknown', 'Claude Code executable 未找到')
        try {
          const controls = await readControls(context)
          const skills = new Set(listSkills(context.cwd, homeDir).filter((skill) => skill.enabled).map((skill) => skill.name))
          return capabilityReady(
            context,
            'read',
            controls.commands.map((command) => ({
              name: command.name,
              description: command.description,
              argumentHint: command.argumentHint || undefined,
              source: skills.has(command.name) ? 'skill' as const : 'builtin' as const
            })),
            controls.observedAt
          )
        } catch (error) {
          return capabilityUnknown(context, 'read', String((error as Error).message))
        }
      }
    },
    runControls: {
      read: async (context) => {
        try {
          const controls = await readControls(context)
          return capabilityReady(context, 'read', controls.data, controls.observedAt)
        } catch (error) {
          return {
            ...capabilityReady(context, 'read', { models: [], permissions: permissionOptions({ autoAcceptEdits: true, autoReview: true }) }),
            state: 'degraded' as const,
            reason: String((error as Error).message)
          }
        }
      }
    }
  }
}
