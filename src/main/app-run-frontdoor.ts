// Front-door admission and trust preparation. It returns live state to the execution phase.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { AgentRuntimeError } from './run-outcome'
import type { ProviderId } from '../shared/provider'
import type { AgentStartRequest, RuntimeProvider } from '../shared/runtime'
import type { AppRunStartOptions } from './app-run-start'
import type { AuthorizedMcpExecution, ProviderAdapter } from './providers/types'
import type { AppSession } from './app-store'
import type { ManagedConversationStart } from './conversation-service'
import type { RecorderEnablement } from '../core/turn-recorder/config'
import type { McpExecutionSnapshot } from './mcp-execution-trust'
import type { CodexHookTrustGrant } from './codex-hook-trust'
import type { OpenCodeProjectPluginAuthorization } from './opencode-plugin-trust'
import type { EditLastTurnInput } from './app-run-edit-last-turn'
import type { TraceArchiveTurn } from './transcript-archive'

interface FrontdoorSession extends AppSession {}

interface FrontdoorRun {
  runId: string
  providerId?: ProviderId
  agentProfileId?: string
  cwd?: string
  externalSessionId?: string
  sessionId?: string
  done?: boolean
}

interface FrontdoorRunControl {
  cwd?: string
  providerId: ProviderId
  runState: FrontdoorRun
  getProviderTurnId: () => string | undefined
}

interface FrontdoorRunRegistry {
  unsettledStates: () => FrontdoorRun[]
  unsettledControls: () => FrontdoorRunControl[]
  get: (runId: string) => { control: { settled: Promise<void> } } | undefined
}

interface FrontdoorConversationStore {
  (): { assertManagedWriteAllowed: (input: { conversationId: string; cwd: string; target: ManagedConversationStart['target']; nativeSessionId?: string; runId: string }) => Promise<void> }
}

interface FrontdoorDeps {
  contextAdmission: { runMany: <T>(keys: string[], action: () => Promise<T>) => Promise<T> }
  admissionKeys: string[]
  startupManagedRecovery: Promise<void>
  shellEnvReady: Promise<unknown>
  startPerf: { mark: (name: string) => void }
  isShuttingDown: boolean
  runtimeProvider: RuntimeProvider
  providerId: ProviderId
  agentProfileId?: string
  cwd?: string
  catalogCwd: string
  request: AgentStartRequest
  options: AppRunStartOptions
  isRemoteRun: boolean
  isWorkflowRun: boolean
  isAuthoringRun: boolean
  managedConversation?: ManagedConversationStart
  sessionRevisionByContext: Map<string, number>
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  appSessionStore: () => { load: () => FrontdoorSession[] }
  deletingSessions: Set<string>
  runs: FrontdoorRunRegistry
  expectedRestartSourceMatches: (expected: string | null | undefined, resume: string | undefined, replaceRunId: string) => boolean
  expectedSessionMatches: (expected: string | null | undefined, resume: string | undefined, aliases: () => Array<{ runId: string; externalSessionId?: string; sessionId?: string }>) => boolean
  runConflictsWithSession: (run: FrontdoorRun, resume: string | undefined, expected: string | null | undefined) => boolean
  waitForCompletedRuns: (entries: Array<{ done: boolean; settled: Promise<void> }>) => Promise<boolean>
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, profile?: string) => string
  conversationStore: FrontdoorConversationStore
  assertLegacyConversationWriteAllowed: (scope: { providerId: ProviderId; agentProfileId?: string; cwd: string; nativeSessionId?: string }) => Promise<void>
  recoverAppRunRecording: (input: Parameters<typeof import('./app-run-recording-recovery').recoverAppRunRecording>[0]) => ReturnType<typeof import('./app-run-recording-recovery').recoverAppRunRecording>
  resolveManagedCommitHookEnv: (cwd: string, knownEnablement?: RecorderEnablement) => Promise<NodeJS.ProcessEnv>
  recordingBlockedSessions: Map<string, string>
  recordingRecoveryHint: string
  resolveCodexHookTrust: (cwd: string) => Promise<CodexHookTrustGrant[]>
  resolveOpenCodePluginTrust: (cwd: string) => Promise<OpenCodeProjectPluginAuthorization | undefined>
  ensureMcpExecutionAuthorized: (scope: { providerId: ProviderId; cwd?: string }, operation: 'run') => Promise<McpExecutionSnapshot | null>
  prepareAppRunEditLastTurn: (input: EditLastTurnInput) => Promise<void>
  adapter: ProviderAdapter
  authorizedMcpExecution: (snapshot: McpExecutionSnapshot | null) => AuthorizedMcpExecution | undefined
  sessionBaselineKey: (context: string, sessionId: string) => string
  randomUUID: () => string
  providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
  resetSessionContext: (key: string) => void
  cloneForkArchiveTurns: (args: { turns: TraceArchiveTurn[]; targetSessionId: string; providerId: ProviderId; runtimeProvider: RuntimeProvider; cwd: string }) => void
  nextRunId: () => string
}

export interface AppRunFrontdoorState {
  contextKey: string
  scopedSessionKey: (sessionId: string) => string
  resume?: string
  editSourceSessionId?: string
  contextRevision: number
  catalogCwd: string
  cwd?: string
  managedRecorderEnabled: boolean
  managedRecorderEnablement?: RecorderEnablement
  managedCommitHookEnv?: NodeJS.ProcessEnv
  codexHookTrust: CodexHookTrustGrant[]
  openCodePluginTrust?: OpenCodeProjectPluginAuthorization
  mcpExecutionSnapshot: McpExecutionSnapshot | null
  canonicalLifecycle: boolean
  runId: string
  expectedSessionId: string | null | undefined
  managedConversation?: FrontdoorDeps['managedConversation']
  contextChangedError: () => AgentRuntimeError
  recordingKey?: string
  isLiveManagedRun?: (candidate: string | undefined, nativeIdentity?: { provider: ProviderId; sessionId: string; providerTurnId?: string }) => boolean
}

export async function runAppRunFrontdoor<T>(deps: FrontdoorDeps, execute: (state: AppRunFrontdoorState) => Promise<T>): Promise<T> {
  const { contextAdmission, admissionKeys, startupManagedRecovery, shellEnvReady, startPerf, isShuttingDown, runtimeProvider,
    providerId, agentProfileId, cwd, catalogCwd, request, options, isRemoteRun, isWorkflowRun, isAuthoringRun, managedConversation,
    sessionRevisionByContext, sessionByContext, sessionAliasesByContext, appSessionStore, deletingSessions, runs,
    expectedRestartSourceMatches, expectedSessionMatches, runConflictsWithSession, waitForCompletedRuns, providerSessionKey,
    conversationStore, assertLegacyConversationWriteAllowed, recoverAppRunRecording, resolveManagedCommitHookEnv,
    recordingBlockedSessions, resolveCodexHookTrust, resolveOpenCodePluginTrust,
    ensureMcpExecutionAuthorized, prepareAppRunEditLastTurn, adapter, authorizedMcpExecution,
    providerContextKey, resetSessionContext, cloneForkArchiveTurns } = deps
  const started = await contextAdmission.runMany(admissionKeys, async () => {
// Wait before freezing trust/MCP environments as well as before spawning the
// Provider. Otherwise a cold send can retain fallback even after capture succeeds.
await Promise.all([startupManagedRecovery, shellEnvReady])
startPerf.mark('startup_recovery_ready')
if (isShuttingDown) throw new AgentRuntimeError('Scry 正在退出，已取消待启动轮次', {
  provider: runtimeProvider,
  stage: 'frontdoor',
  nextAction: '重新打开 Scry 后再启动'
})
const contextKey = providerContextKey(providerId, cwd ?? '', agentProfileId)
const scopedSessionKey = (sessionId: string): string =>
  providerSessionKey(providerId, catalogCwd, sessionId, agentProfileId)
const expectedSessionId = isRemoteRun ? (request.expectedExternalSessionId ?? null) : isWorkflowRun ? null : request.expectedExternalSessionId
// expectedExternalSessionId=null 是 renderer 对“必须新建会话”的显式要求。
// 即使较早的 agent:newSession IPC 仍在路上，这里也先原子清空 main 的旧上下文，
// 再捕获 revision/resume，避免把新提示词误判为要投递到旧会话。
if (!managedConversation && !isRemoteRun && !isWorkflowRun && expectedSessionId === null && !request.forkLastTurn && !request.restartLastTurn) {
  resetSessionContext(contextKey)
}
let contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
let resume = managedConversation
  ? (managedConversation.resumeSessionId ?? undefined)
  : isRemoteRun ? request.expectedExternalSessionId ?? undefined : isWorkflowRun ? undefined : sessionByContext.get(contextKey)
const forkSourceSessionId = !isRemoteRun && request.forkLastTurn ? resume : undefined
const restartSourceSessionId = !isRemoteRun && request.restartLastTurn && typeof expectedSessionId === 'string'
  ? expectedSessionId
  : undefined
const editSourceSessionId = forkSourceSessionId ?? restartSourceSessionId
const contextRuns = runs.unsettledStates().filter((run) =>
  run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
)
if (managedConversation && contextRuns.length > 0) {
  throw new AgentRuntimeError('Provider 工作区仍有未收口轮次，已拒绝统一对话启动', {
    provider: runtimeProvider,
    stage: 'frontdoor',
    cwd,
    nextAction: '等待现有轮次完成后重新预览并发送'
  })
}
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
if (!managedConversation && !isRemoteRun && !isWorkflowRun && (!(request.restartLastTurn && expectedRestartSourceMatches(expectedSessionId, resume, request.restartLastTurn.replaceRunId)) &&
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
  return entry ? [{ done: run.done === true, settled: entry.control.settled }] : []
})
if (!(await waitForCompletedRuns(conflictingEntries))) {
  throw new AgentRuntimeError('同一会话已有一轮正在运行', {
    provider: runtimeProvider,
    stage: 'frontdoor',
    cwd,
    nextAction: '等待当前轮完成，或新建独立会话后并行运行'
  })
}
// Renderer 会在 turnDone 后立即投递队列下一条；此时 Provider 已结束，但 diff/archive
// 仍可能在收口。等待真实 settled 后再继续，避免稳定拒绝并破坏 FIFO。
contextRevision = sessionRevisionByContext.get(contextKey) ?? 0
if (!managedConversation && !isRemoteRun && !isWorkflowRun) resume = sessionByContext.get(contextKey)
const latestContextRuns = runs.unsettledStates().filter((run) =>
  run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
)
if (!managedConversation && !isRemoteRun && !isWorkflowRun && (!(request.restartLastTurn && expectedRestartSourceMatches(expectedSessionId, resume, request.restartLastTurn.replaceRunId)) &&
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
  // Still-owned runs finish on their original execution chain, not through crash recovery.
  const isLiveManagedRun = (candidate: string | undefined, nativeIdentity?: {
provider: ProviderId; sessionId: string; providerTurnId?: string
  }): boolean => {
if (candidate) return runs.unsettledStates().some((run) => run.runId === candidate)
// Codex's native hook has no Scry run id. Only an exact live native turn
// match may exclude its open record from crash recovery; session alone is
// insufficient because an older unresolved turn can share that session.
return Boolean(nativeIdentity?.providerTurnId && runs.unsettledControls().some((control) =>
  control.cwd === cwd && control.providerId === nativeIdentity.provider &&
  control.runState.externalSessionId === nativeIdentity.sessionId &&
  control.getProviderTurnId() === nativeIdentity.providerTurnId))
  }
  const {
managedRecorderEnabled,
managedRecorderEnablement,
managedCommitHookEnv,
recoveredManagedTurns
  } = await recoverAppRunRecording({
userDataDir: () => app.getPath('userData'),
cwd,
providerId,
runtimeProvider,
resume,
isAuthoringRun,
resolveManagedCommitHookEnv,
isLiveManagedRun,
startPerf
  })
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
? await resolveCodexHookTrust(cwd)
: []
  const openCodePluginTrust = providerId === 'opencode' && cwd
? await resolveOpenCodePluginTrust(cwd)
: undefined
  const mcpExecutionSnapshot = providerId === 'pi'
? null
: await ensureMcpExecutionAuthorized({ providerId, cwd }, 'run')
  startPerf.mark('execution_trust_ready')
  if (isShuttingDown) {
throw new AgentRuntimeError('Scry 正在退出，已拒绝启动新一轮', {
  provider: runtimeProvider,
  stage: 'frontdoor',
  cwd,
  nextAction: '重新打开 Scry 后再启动'
})
  }
  if (request.forkLastTurn || request.restartLastTurn) {
await prepareAppRunEditLastTurn({
  request,
  forkSourceSessionId,
  restartSourceSessionId,
  expectedSessionId,
  providerId,
  runtimeProvider,
  cwd,
  catalogCwd,
  agentProfileId,
  model: request.model,
  permissionMode: request.permissionMode,
  codexHookTrust,
  openCodePluginTrust,
  getMcpExecution: () => authorizedMcpExecution(mcpExecutionSnapshot),
  forkLastTurnFacet: () => adapter.forkLastTurn,
  userDataDir: () => app.getPath('userData'),
  cloneForkArchiveTurns,
  commitSession: (sessionId) => {
    resume = sessionId
    if (sessionId) sessionByContext.set(contextKey, sessionId)
    else sessionByContext.delete(contextKey)
    sessionAliasesByContext.delete(contextKey)
  },
  contextChangedError
})
  }
  const committedResume = managedConversation ? resume : isRemoteRun ? resume : isWorkflowRun ? undefined : sessionByContext.get(contextKey)
  const committedRevision = sessionRevisionByContext.get(contextKey) ?? 0
  const committedRuns = runs.unsettledStates().filter((run) =>
run.runId !== options.runId && run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd
  )
  const committedExpectedSessionId = request.forkLastTurn || request.restartLastTurn ? resume ?? null : expectedSessionId
  if (!managedConversation && !isRemoteRun && !isWorkflowRun && (
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
  const runId = managedConversation?.runId ?? options.runId ?? deps.nextRunId()
  if (managedConversation) {
if (options.runId !== undefined && options.runId !== managedConversation.runId) {
  throw new AgentRuntimeError('统一对话 runId 与 runner 选项不一致', {
    provider: runtimeProvider,
    stage: 'frontdoor',
    cwd,
    nextAction: '丢弃本次启动并重新发送；不会自动重试'
  })
}
const actualRequestHash = createHash('sha256').update(JSON.stringify({
  scope: 'plain-text-local-managed-v1',
  payloadHash: managedConversation.payloadHash,
  historyHash: managedConversation.historicalContext?.contentHash ?? null
})).digest('hex')
if (actualRequestHash !== managedConversation.requestHash) {
  throw new AgentRuntimeError('统一对话请求指纹在 runner 边界发生变化', {
    provider: runtimeProvider,
    stage: 'frontdoor',
    cwd,
    nextAction: '保留 durable intent 并阻止原生投递'
  })
}
  }
    return execute({ contextKey, scopedSessionKey, expectedSessionId, resume,
      editSourceSessionId, contextRevision, catalogCwd, cwd, managedRecorderEnabled, managedRecorderEnablement,
      managedCommitHookEnv, codexHookTrust, openCodePluginTrust, mcpExecutionSnapshot, canonicalLifecycle, runId,
      managedConversation, contextChangedError, recordingKey, isLiveManagedRun })
  })
  return started
}
