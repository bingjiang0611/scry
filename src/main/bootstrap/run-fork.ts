import { app } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { DesktopRemoteForkSessionRequest } from '../../shared/desktop-remote'
import type { AgentForkSessionResult } from '../../shared/runtime'
import type { ConversationServiceDeps } from '../conversation-service'
import type { NativeSessionScope } from '../conversation-store'
import type { createAppSessionStore } from '../app-store'
import { providerOperationKey, type ProviderOperationGate } from '../provider-operation-gate'
import { verifyForkArchiveBoundary } from '../session-fork'
import type { ProviderId } from '../../shared/provider'
import type { NormalizedAgentStartRequest, RuntimeProvider } from '../../shared/runtime'
import { AgentRuntimeError } from '../run-outcome'
import type { ProviderRegistry } from '../providers/registry'
import { readTraceArchiveAsync } from '../transcript-archive'
import { cloneForkArchiveTurns } from './archive'
import { resolveCodexHookTrust, resolveOpenCodePluginTrust, authorizedMcpExecution, ensureMcpExecutionAuthorized } from './trust'
import { canRestartInterruptedLocalOnlySession, type ContextAdmission } from '../context-admission'

type ForkDeps = {
  userDataDir: string
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
}

export async function applyForkOrRestart(input: {
  request: NormalizedAgentStartRequest
  providerId: ProviderId
  agentProfileId?: string
  runtimeProvider: RuntimeProvider
  cwd: string | undefined
  catalogCwd: string
  resume: string | undefined
  contextKey: string
  expectedSessionId: string | null | undefined
  forkSourceSessionId: string | undefined
  restartSourceSessionId: string | undefined
  adapter: ReturnType<ProviderRegistry['get']>
  codexHookTrust: Awaited<ReturnType<typeof resolveCodexHookTrust>>
  openCodePluginTrust: Awaited<ReturnType<typeof resolveOpenCodePluginTrust>>
  mcpExecutionSnapshot: Parameters<typeof authorizedMcpExecution>[0]
  contextChangedError: () => AgentRuntimeError
}, deps: ForkDeps): Promise<string | undefined> {
  let { resume } = input
  const { request, providerId, agentProfileId, runtimeProvider, cwd, catalogCwd, contextKey, expectedSessionId, forkSourceSessionId, restartSourceSessionId, adapter, codexHookTrust, openCodePluginTrust, mcpExecutionSnapshot, contextChangedError } = input
  if (request.forkLastTurn) {
    if (!forkSourceSessionId || forkSourceSessionId !== expectedSessionId) throw contextChangedError()
    const archive = await readTraceArchiveAsync({
      cwd: catalogCwd,
      sessionId: forkSourceSessionId,
      providerId,
      userDataDir: deps.userDataDir
    })
    const head = archive?.turns.at(-1)
    if (!archive || head?.runId !== request.forkLastTurn.replaceRunId ||
      head.providerTurnId !== request.forkLastTurn.replaceProviderTurnId ||
      (head.forkTurnId ?? head.providerTurnId) !== request.forkLastTurn.replaceForkTurnId) {
      throw new AgentRuntimeError('最后一条消息已变化，已拒绝从过期边界建立分支', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '重新打开当前会话后再编辑最后一条消息'
      })
    }
    if (request.forkLastTurn.previousProviderTurnId && request.forkLastTurn.previousForkTurnId) {
      const previous = archive?.turns.at(-2)
      if (previous?.providerTurnId !== request.forkLastTurn.previousProviderTurnId ||
        (previous.forkTurnId ?? previous.providerTurnId) !== request.forkLastTurn.previousForkTurnId) {
        throw new AgentRuntimeError('上一轮边界与当前会话不一致', {
          provider: runtimeProvider,
          stage: 'frontdoor',
          cwd,
          nextAction: '重新打开当前会话后再编辑最后一条消息'
        })
      }
      if (!adapter.forkLastTurn) {
        throw new AgentRuntimeError('当前 Provider 不支持从历史边界建立分支', {
          provider: runtimeProvider,
          stage: 'capability',
          cwd,
          nextAction: '升级 Provider CLI/SDK 后重试'
        })
      }
      const forked = await adapter.forkLastTurn.fork({
        ...request.forkLastTurn,
        sourceSessionId: forkSourceSessionId,
        originalPrompt: head.userText,
        cwd,
        agentProfileId,
        model: request.model,
        permissionMode: request.permissionMode,
        codexHookTrust,
        openCodePluginTrust,
        mcpExecution: authorizedMcpExecution(mcpExecutionSnapshot)
      })
      if (!forked.externalSessionId) throw new Error('Provider 未返回分支会话 ID')
      await cloneForkArchiveTurns({
        turns: archive.turns.slice(0, -1),
        targetSessionId: forked.externalSessionId,
        providerId,
        runtimeProvider,
        cwd: catalogCwd
      })
      resume = forked.externalSessionId
      deps.sessionByContext.set(contextKey, resume)
    } else {
      if (archive.turns.length !== 1) {
        throw new AgentRuntimeError('缺少上一轮边界，已拒绝把多轮会话当成首轮重新开始', {
          provider: runtimeProvider,
          stage: 'frontdoor',
          cwd,
          nextAction: '加载完整会话后再编辑最后一条消息'
        })
      }
      // 编辑首轮不需要复制空历史；直接创建一个新的 Provider 会话。
      resume = undefined
      deps.sessionByContext.delete(contextKey)
    }
    deps.sessionAliasesByContext.delete(contextKey)
  } else if (request.restartLastTurn) {
    if (!restartSourceSessionId) throw contextChangedError()
    const archive = await readTraceArchiveAsync({
      cwd: catalogCwd,
      sessionId: restartSourceSessionId,
      providerId,
      userDataDir: deps.userDataDir
    })
    if (!canRestartInterruptedLocalOnlySession(archive, request.restartLastTurn.replaceRunId)) {
      throw new AgentRuntimeError('停止轮次已变化或已形成 Provider 边界，已拒绝重新开始', {
        provider: runtimeProvider,
        stage: 'frontdoor',
        cwd,
        nextAction: '重新打开当前会话；只有全部轮次都已停止且未形成原生边界时才能直接编辑重发'
      })
    }
    resume = undefined
    deps.sessionByContext.delete(contextKey)
    deps.sessionAliasesByContext.delete(contextKey)
  }
  return resume
}

export function createForkOperations({
  resolveKnownProjectDirectory, providerRegistry, providerOperationGate, contextAdmission,
  providerContextKey, unsettledRuns, getCurrentCwd, getStartupManagedRecovery,
  assertLegacyConversationWriteAllowed, resetSessionContext, sessionByContext,
  invalidateSessionHistoryLoad, appSessionStore, rememberProject
}: {
  resolveKnownProjectDirectory: (cwd: string) => string
  providerRegistry: ProviderRegistry
  providerOperationGate: ProviderOperationGate
  contextAdmission: ContextAdmission
  providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
  unsettledRuns: () => ActiveRun[]
  getCurrentCwd: () => string | undefined
  getStartupManagedRecovery: () => Promise<void>
  assertLegacyConversationWriteAllowed: (scope: NativeSessionScope) => Promise<void>
  resetSessionContext: (key: string) => void
  sessionByContext: Map<string, string>
  invalidateSessionHistoryLoad: (reason: string) => void
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  rememberProject: (cwd: string) => void
}) {
  async function forkManagedConversation(input: Parameters<NonNullable<ConversationServiceDeps['forkNative']>>[0]): Promise<string> {
    const { source, binding, turn, permissionMode, beforeFork } = input
    const cwd = resolveKnownProjectDirectory(source.cwd)
    const { providerId, agentProfileId } = binding
    const adapter = providerRegistry.get(providerId)
    if (!adapter.forkSession) throw new Error('该轮的 Provider 不支持原生分支')
    if (providerId === 'pi' && permissionMode !== 'full_access') throw new Error('Pi 原生分支需要明确选择本机完全访问')
    const lease = providerOperationGate.acquireOperation(providerOperationKey(providerId, agentProfileId))
    if (!lease.ok) throw new Error('源 Provider 正在认证，不能创建分支')
    try {
      return await contextAdmission.run(providerContextKey(providerId, cwd, agentProfileId), async () => {
        if (unsettledRuns().some(run => run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd)) {
          throw new Error('源 Provider 仍在运行或保存证据，请等待收敛')
        }
        if (!turn.archive) throw new Error('分支轮次缺少已提交归档')
        const archive = await readTraceArchiveAsync({ userDataDir: app.getPath('userData'), providerId, cwd, sessionId: turn.archive.sessionId })
        const recorded = archive?.turns.find(item => item.runId === turn.runId)
        if (!recorded?.providerTurnId) throw new Error('归档没有稳定的原生轮次边界')
        const request = {
          providerId, agentProfileId, cwd, sourceSessionId: binding.nativeSessionId!, sourceRunId: turn.runId,
          sourceProviderTurnId: recorded.providerTurnId, sourceForkTurnId: recorded.forkTurnId ?? recorded.providerTurnId, permissionMode
        }
        verifyForkArchiveBoundary(archive, request)
        const codexHookTrust = providerId === 'codex' ? await resolveCodexHookTrust(cwd, providerRegistry) : []
        const mcpSnapshot = providerId === 'pi' ? null : await ensureMcpExecutionAuthorized({ providerId, cwd }, 'run')
        const result = await adapter.forkSession!.fork({
          ...request, expectedContinuationKey: binding.continuationKey,
          beforeFork, codexHookTrust, mcpExecution: authorizedMcpExecution(mcpSnapshot)
        })
        if (!result.externalSessionId) throw new Error('Provider 未返回原生分支身份')
        return result.externalSessionId
      })
    } finally { lease.release() }
  }

  async function forkSessionWithAuthority(request: DesktopRemoteForkSessionRequest, authorize?: () => void): Promise<AgentForkSessionResult> {
    const providerId = request.providerId
    const cwd = request.cwd ? resolveKnownProjectDirectory(request.cwd) : getCurrentCwd()
    const catalogCwd = cwd ?? ''
    const agentProfileId = request.agentProfileId
    const adapter = providerRegistry.get(providerId)
    const forkSession = adapter.forkSession
    if (!forkSession) throw new Error('当前 Provider 不支持从指定轮次创建分支')
    const lifecycleKey = providerOperationKey(providerId, agentProfileId)
    const lease = providerOperationGate.acquireOperation(lifecycleKey)
    if (!lease.ok) throw new Error('当前 Provider 正在认证 MCP，已拒绝创建分支')
    const contextKey = providerContextKey(providerId, catalogCwd, agentProfileId)
    try {
      return await contextAdmission.run(contextKey, async () => {
        await getStartupManagedRecovery()
        await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: request.sourceSessionId })
        const archive = await readTraceArchiveAsync({
          userDataDir: app.getPath('userData'),
          providerId,
          cwd: catalogCwd,
          sessionId: request.sourceSessionId
        })
        const { source, prefix } = verifyForkArchiveBoundary(archive, request)
        const codexHookTrust = providerId === 'codex' && cwd ? await resolveCodexHookTrust(cwd, providerRegistry) : []
        const openCodePluginTrust = providerId === 'opencode' && cwd
          ? await resolveOpenCodePluginTrust(cwd)
          : undefined
        const mcpExecutionSnapshot = providerId === 'pi'
          ? null
          : await ensureMcpExecutionAuthorized({ providerId, cwd }, 'run')
        await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: request.sourceSessionId })
        authorize?.()
        const forked = await forkSession.fork({
          ...request,
          cwd,
          agentProfileId,
          codexHookTrust,
          openCodePluginTrust,
          mcpExecution: authorizedMcpExecution(mcpExecutionSnapshot)
        })
        if (!forked.externalSessionId) throw new Error('Provider 未返回分支会话 ID')
        await cloneForkArchiveTurns({
          turns: prefix,
          targetSessionId: forked.externalSessionId,
          providerId,
          runtimeProvider: adapter.runtimeProvider,
          cwd: catalogCwd
        })
        resetSessionContext(contextKey)
        sessionByContext.set(contextKey, forked.externalSessionId)
        invalidateSessionHistoryLoad('session forked')
        appSessionStore().record({
          providerId,
          agentProfileId,
          runtimeProvider: adapter.runtimeProvider,
          externalSessionId: forked.externalSessionId,
          cwd: catalogCwd,
          prompt: source.userText
        })
        if (cwd) rememberProject(cwd)
        return { externalSessionId: forked.externalSessionId }
      })
    } finally {
      lease.release()
    }
  }

  return { forkManagedConversation, forkSessionWithAuthority }
}
