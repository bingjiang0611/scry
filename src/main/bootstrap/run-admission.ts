import { app } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import { AgentRuntimeError } from '../run-outcome'
import {
  expectedRestartSourceMatches, expectedSessionMatches,
  runConflictsWithSession, waitForCompletedRuns
} from '../context-admission'
import type { RunRegistry } from '../run-registry'
import type { ProviderRegistry } from '../providers/registry'
import type { ConversationStore, NativeSessionScope } from '../conversation-store'
import type { createAppSessionStore } from '../app-store'
import type { RunControl } from './run-control'
import type { prepareRunFrontdoor, AppRunStartOptions } from './run-frontdoor'
import { prepareRunRecovery } from './run-recovery'
import { applyForkOrRestart } from './run-fork'
import { resolveCodexHookTrust, resolveOpenCodePluginTrust, ensureMcpExecutionAuthorized } from './trust'

export async function prepareRunAdmission(
  frontdoor: ReturnType<typeof prepareRunFrontdoor>,
  options: AppRunStartOptions,
  {
    getStartupManagedRecovery, isShuttingDown, providerRegistry, providerContextKey, providerSessionKey,
    resetSessionContext, sessionRevisionByContext, sessionByContext, sessionAliasesByContext,
    runs, appSessionStore, deletingSessions, conversationStore,
    assertLegacyConversationWriteAllowed, recordingBlockedSessions
  }: {
    providerRegistry: ProviderRegistry
    getStartupManagedRecovery: () => Promise<void>
    isShuttingDown: () => boolean
    providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
    providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, profile?: string) => string
    resetSessionContext: (key: string) => void
    sessionRevisionByContext: Map<string, number>
    sessionByContext: Map<string, string>
    sessionAliasesByContext: Map<string, Map<string, string>>
    runs: RunRegistry<ActiveRun, RunControl>
    appSessionStore: () => ReturnType<typeof createAppSessionStore>
    deletingSessions: Set<string>
    conversationStore: () => ConversationStore
    assertLegacyConversationWriteAllowed: (scope: NativeSessionScope) => Promise<void>
    recordingBlockedSessions: Map<string, string>
  }
) {
  const {
    isRemoteRun, request, providerId, agentProfileId, runtimeProvider, cwd, catalogCwd,
    managedConversation, shellEnvReady, startPerf, adapter
  } = frontdoor
  await Promise.all([getStartupManagedRecovery(), shellEnvReady])
  startPerf.mark('startup_recovery_ready')
  if (isShuttingDown()) throw new AgentRuntimeError('Scry 正在退出，已取消待启动轮次', {
    provider: runtimeProvider,
    stage: 'frontdoor',
    nextAction: '重新打开 Scry 后再启动'
  })
  const contextKey = providerContextKey(providerId, cwd ?? '', agentProfileId)
  const scopedSessionKey = (sessionId: string): string =>
    providerSessionKey(providerId, catalogCwd, sessionId, agentProfileId)
  const expectedSessionId = isRemoteRun || managedConversation
    // 统一对话的新轮次也是确定身份：resumeSessionId 为空就是「肯定新建原生 session」，
    // 不需要按「身份未知」把同工作区别的会话也一起挡住。
    ? (request.expectedExternalSessionId ?? null)
    : request.expectedExternalSessionId
  if (!managedConversation && !isRemoteRun && expectedSessionId === null && !request.forkLastTurn && !request.restartLastTurn) {
    resetSessionContext(contextKey)
  }
  let contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
  let resume = managedConversation
    ? (managedConversation.resumeSessionId ?? undefined)
    : isRemoteRun ? request.expectedExternalSessionId ?? undefined : sessionByContext.get(contextKey)
  const forkSourceSessionId = !isRemoteRun && request.forkLastTurn ? resume : undefined
  const restartSourceSessionId = !isRemoteRun && request.restartLastTurn && typeof expectedSessionId === 'string'
    ? expectedSessionId
    : undefined
  const editSourceSessionId = forkSourceSessionId ?? restartSourceSessionId
  const contextRuns = runs.unsettledStates().filter((run) =>
    run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
  )
  // 冲突域是「同一 Conversation / 同一原生 session」，不是整个工作区：同一 cwd 的不同会话
  // 可以并行，共享文件的风险由 diff 重叠证据如实标记，而不是靠工作区级互斥假装串行。
  const catalogAliases = (): Array<{ runId: string; externalSessionId?: string; sessionId?: string }> => {
    const liveAliases = [...(sessionAliasesByContext.get(contextKey) ?? [])].map(([runId, externalSessionId]) => ({
      runId,
      externalSessionId
    }))
    try {
      return [...liveAliases, ...appSessionStore().load()
        .filter((session) => session.providerId === providerId && session.agentProfileId === agentProfileId &&
          session.cwd === catalogCwd && Boolean(session.runId))
        .map((session) => ({
          runId: session.runId!,
          ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : {}),
          sessionId: session.sessionId
        }))]
    } catch {
      return liveAliases
    }
  }
  const contextChangedError = (): AgentRuntimeError => new AgentRuntimeError(
    '发送前会话上下文已变化，已拒绝把提示词投递到其他会话',
    {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '草稿已保留；确认当前会话后重新发送'
    }
  )
  if (!managedConversation && !isRemoteRun && (!(request.restartLastTurn && expectedRestartSourceMatches(expectedSessionId, resume, request.restartLastTurn.replaceRunId)) &&
    !expectedSessionMatches(expectedSessionId, resume, () => [...contextRuns, ...catalogAliases()]))) {
    throw contextChangedError()
  }
  if (cwd && resume && deletingSessions.has(scopedSessionKey(resume))) {
    throw new AgentRuntimeError('这个会话正在删除，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待删除完成后新建会话或重新选择历史会话'
    })
  }
  const conflictingRuns = contextRuns.filter((run) => runConflictsWithSession(run, resume, expectedSessionId))
  const conflictingEntries = conflictingRuns.flatMap((run) => {
    const entry = runs.get(run.runId)
    return entry ? [{ done: run.done, settled: entry.control.settled }] : []
  })
  if (!(await waitForCompletedRuns(conflictingEntries))) {
    throw new AgentRuntimeError('同一会话已有一轮正在运行', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待当前轮完成，或新建独立会话后并行运行'
    })
  }
  contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
  if (!managedConversation && !isRemoteRun) resume = sessionByContext.get(contextKey)
  const latestContextRuns = runs.unsettledStates().filter((run) =>
    run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
  )
  if (!managedConversation && !isRemoteRun && (!(request.restartLastTurn && expectedRestartSourceMatches(expectedSessionId, resume, request.restartLastTurn.replaceRunId)) &&
    !expectedSessionMatches(expectedSessionId, resume, () => [...contextRuns, ...latestContextRuns, ...catalogAliases()]))) {
    throw contextChangedError()
  }
  if (cwd && resume && deletingSessions.has(scopedSessionKey(resume))) {
    throw new AgentRuntimeError('这个会话正在删除，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待删除完成后新建会话或重新选择历史会话'
    })
  }
  if (latestContextRuns.some((run) => runConflictsWithSession(run, resume, expectedSessionId))) {
    throw new AgentRuntimeError('会话切换后目标会话仍有一轮正在收口', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待目标会话完成后重试；草稿已保留'
    })
  }
  if (managedConversation) {
    await conversationStore().assertManagedWriteAllowed({
      conversationId: managedConversation.conversationId,
      cwd: catalogCwd,
      target: managedConversation.target,
      nativeSessionId: resume,
      runId: managedConversation.runId
    })
  } else await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: resume })
  const isLiveManagedRun = (candidate: string | undefined, nativeIdentity?: {
    provider: ProviderId; sessionId: string; providerTurnId?: string
  }): boolean => {
    if (candidate) return runs.unsettledStates().some((run) => run.runId === candidate)
    return Boolean(nativeIdentity?.providerTurnId && runs.unsettledControls().some((control) =>
      control.cwd === cwd && control.providerId === nativeIdentity.provider &&
      control.runState.externalSessionId === nativeIdentity.sessionId &&
      control.getProviderTurnId() === nativeIdentity.providerTurnId))
  }
  const { managedRecorderEnabled, managedRecorderEnablement, managedCommitHookEnv, recoveredManagedTurns } = await prepareRunRecovery({
    cwd, providerId, runtimeProvider, resume, isLiveManagedRun
  }, { userDataDir: app.getPath('userData'), startPerf })
  const recordingKey = resume ? scopedSessionKey(resume) : undefined
  if (recordingKey && recoveredManagedTurns > 0) recordingBlockedSessions.delete(recordingKey)
  const recordingFailure = recordingKey ? recordingBlockedSessions.get(recordingKey) : undefined
  if (recordingFailure) {
    throw new AgentRuntimeError('上一轮精确记录尚未安全落盘，已拒绝继续', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: recordingFailure
    })
  }
  const canonicalLifecycle = providerId === 'codex' || managedRecorderEnabled
  const codexHookTrust = providerId === 'codex' && cwd
    ? await resolveCodexHookTrust(cwd, providerRegistry)
    : []
  const openCodePluginTrust = providerId === 'opencode' && cwd
    ? await resolveOpenCodePluginTrust(cwd)
    : undefined
  const mcpExecutionSnapshot = providerId === 'pi'
    ? null
    : await ensureMcpExecutionAuthorized({ providerId, cwd }, 'run')
  startPerf.mark('execution_trust_ready')
  if (isShuttingDown()) {
    throw new AgentRuntimeError('Scry 正在退出，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '重新打开 Scry 后再启动'
    })
  }
  resume = await applyForkOrRestart({
    request, providerId, agentProfileId, runtimeProvider, cwd, catalogCwd, resume, contextKey,
    expectedSessionId, forkSourceSessionId, restartSourceSessionId, adapter, codexHookTrust,
    openCodePluginTrust, mcpExecutionSnapshot, contextChangedError
  }, { userDataDir: app.getPath('userData'), sessionByContext, sessionAliasesByContext })
  const committedResume = managedConversation ? resume : isRemoteRun ? resume : sessionByContext.get(contextKey)
  const committedRevision = sessionRevisionByContext.get(contextKey) ?? 0
  const committedRuns = runs.unsettledStates().filter((run) =>
    run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
  )
  const committedExpectedSessionId = request.forkLastTurn || request.restartLastTurn ? resume ?? null : expectedSessionId
  if (!managedConversation && !isRemoteRun && (
    committedResume !== resume || committedRevision !== contextRevision ||
    !expectedSessionMatches(committedExpectedSessionId, committedResume, () => [...committedRuns, ...catalogAliases()])
  )) throw contextChangedError()
  if (cwd && committedResume && deletingSessions.has(scopedSessionKey(committedResume))) {
    throw new AgentRuntimeError('这个会话正在删除，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待删除完成后新建会话或重新选择历史会话'
    })
  }
  if (committedRuns.some((run) => runConflictsWithSession(run, committedResume, committedExpectedSessionId))) {
    throw new AgentRuntimeError('同一会话在发送前进入运行态，已拒绝重复启动', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待当前轮完成；草稿已保留'
    })
  }

  return {
    contextKey, scopedSessionKey, contextRevision, resume, editSourceSessionId,
    managedRecorderEnabled, managedRecorderEnablement, managedCommitHookEnv,
    canonicalLifecycle, codexHookTrust, openCodePluginTrust, mcpExecutionSnapshot
  }
}
