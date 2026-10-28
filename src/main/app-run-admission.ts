import type { AgentStartRequest, RuntimeProvider } from '../shared/runtime'
import { normalizeAgentStartRequest } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import { PerformanceTrace } from './performance-timing'
import { AgentRuntimeError } from './run-outcome'
import type { RemoteRunCompletion } from './remote/remote-run-binding'
import type { AppRunStartOptions } from './app-run-start'
import { runAppRunFrontdoor } from './app-run-frontdoor'
import type { AppRunExecutionDeps, AppRunExecutionState } from './app-run-lifecycle-types'
import type { ProviderRegistry } from './providers/registry'
import type { ProviderOperationGate } from './provider-operation-gate'
import type { WorkflowSystemHost } from './workflow-system-host'
import type { McpExecutionSnapshot } from './mcp-execution-trust'
import type { RecorderEnablement } from '../core/turn-recorder/config'
import type { TraceArchiveTurn } from './transcript-archive'
import type { EditLastTurnInput } from './app-run-edit-last-turn'
import { createAppSessionStore } from './app-store'
import { assertWorkflowAuthoringStart } from './workflow-authoring'
import { warmShellEnv } from './claude-locate'
import { providerOperationKey } from './provider-operation-gate'
import { workflowSystemCopy } from '../shared/constants/copy'

export interface AppRunAdmissionDeps {
  providerRegistry: ProviderRegistry
  workflowSystems: WorkflowSystemHost
  resolveTemplateProjectDirectory: (cwd: string) => Promise<string>
  resolveRemoteProjectDirectory: (cwd: string) => string
  resolveKnownProjectDirectory: (cwd: string) => string
  currentCwd: string | undefined
  canonicalExistingDirectory: (cwd: string) => string
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  providerOperationKey: typeof providerOperationKey
  providerOperationGate: ProviderOperationGate
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  contextAdmission: { runMany: <T>(keys: string[], action: () => Promise<T>) => Promise<T> }
  startupManagedRecovery: Promise<void>
  sessionRevisionByContext: Map<string, number>
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  deletingSessions: Set<string>
  runs: AppRunExecutionDeps['runs']
  expectedRestartSourceMatches: typeof import('./context-admission').expectedRestartSourceMatches
  expectedSessionMatches: typeof import('./context-admission').expectedSessionMatches
  runConflictsWithSession: typeof import('./context-admission').runConflictsWithSession
  waitForCompletedRuns: typeof import('./context-admission').waitForCompletedRuns
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, profile?: string) => string
  conversationStore: AppRunExecutionDeps['conversationStore']
  assertLegacyConversationWriteAllowed: AppRunExecutionDeps['assertLegacyConversationWriteAllowed']
  recoverAppRunRecording: typeof import('./app-run-recording-recovery').recoverAppRunRecording
  resolveManagedCommitHookEnv: (cwd: string, knownEnablement?: RecorderEnablement) => Promise<NodeJS.ProcessEnv>
  recordingBlockedSessions: Map<string, string>
  resolveCodexHookTrust: (cwd: string) => Promise<import('./codex-hook-trust').CodexHookTrustGrant[]>
  resolveOpenCodePluginTrust: (cwd: string) => Promise<import('./opencode-plugin-trust').OpenCodeProjectPluginAuthorization | undefined>
  ensureMcpExecutionAuthorized: (scope: { providerId: ProviderId; cwd?: string }, operation: 'run') => Promise<McpExecutionSnapshot | null>
  prepareAppRunEditLastTurn: (input: EditLastTurnInput) => Promise<void>
  authorizedMcpExecution: AppRunExecutionDeps['authorizedMcpExecution']
  sessionBaselineKey: AppRunExecutionDeps['sessionBaselineKey']
  randomUUID: () => string
  isShuttingDown: boolean
  warmShellEnv: typeof warmShellEnv
  resolveWorkflowAuthoringStart: typeof assertWorkflowAuthoringStart
  traceToolContentPolicy: AppRunExecutionDeps['liveToolContentPolicy']
  recordingRecoveryHint: string
  resetSessionContext: (key: string) => void
  cloneForkArchiveTurns: (args: { turns: TraceArchiveTurn[]; targetSessionId: string; providerId: ProviderId; runtimeProvider: RuntimeProvider; cwd: string }) => void
  nextRunId: () => string
}

export async function startAppRunAdmission(deps: AppRunAdmissionDeps, payload: AgentStartRequest, options: AppRunStartOptions = {}, execute: (state: AppRunExecutionState) => Promise<{ runId: string } | RemoteRunCompletion>): Promise<{ runId: string } | RemoteRunCompletion> {
  const { providerRegistry, workflowSystems, resolveTemplateProjectDirectory, resolveRemoteProjectDirectory, resolveKnownProjectDirectory, currentCwd, canonicalExistingDirectory, appSessionStore, providerOperationKey, providerOperationGate, providerContextKey, contextAdmission, startupManagedRecovery, sessionRevisionByContext, sessionByContext, sessionAliasesByContext, deletingSessions, runs, expectedRestartSourceMatches, expectedSessionMatches, runConflictsWithSession, waitForCompletedRuns, providerSessionKey, conversationStore, assertLegacyConversationWriteAllowed, recoverAppRunRecording, resolveManagedCommitHookEnv, recordingBlockedSessions, resolveCodexHookTrust, resolveOpenCodePluginTrust, ensureMcpExecutionAuthorized, prepareAppRunEditLastTurn, authorizedMcpExecution, sessionBaselineKey, randomUUID, isShuttingDown, warmShellEnv, resolveWorkflowAuthoringStart, traceToolContentPolicy, recordingRecoveryHint, resetSessionContext, cloneForkArchiveTurns, nextRunId } = deps
  const isRemoteRun = options.origin === 'remote'
  const isWorkflowRun = options.origin === 'workflow'
  const request = normalizeAgentStartRequest(payload)
  const providerId = request.providerId
  const agentProfileId = request.agentProfileId
  const startPerf = new PerformanceTrace('agent.start', { provider: providerId })
  const firstTracePerf = new PerformanceTrace('agent.first_provider_trace', { provider: providerId })
  const firstTextPerf = new PerformanceTrace('agent.first_text', { provider: providerId })
  const adapter = providerRegistry.get(providerId)
  const isAuthoringRun = resolveWorkflowAuthoringStart(request, options, adapter.workflowAuthoring)
  // Candidate-only runs use the existing App trace budget, not workspace recorder
  // configuration. Pin it across progress, archive and SQLite/recovery sinks.
  const toolContentPolicy = isAuthoringRun ? traceToolContentPolicy : undefined
  const runtimeProvider = adapter.runtimeProvider
  if (isShuttingDown) {
    throw new AgentRuntimeError('Scry 正在退出，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      nextAction: '重新打开 Scry 后再启动'
    })
  }
  // Start one bounded acquisition for this explicit send. Discovery does not retry a
  // broken shell; the next send may recover without restarting Scry.
  const shellEnvReady = warmShellEnv({ retryFailed: true })
  const replica = options.workflowReplica ? await workflowSystems.assertRun(options.workflowReplica, request.cwd ?? '') : undefined
  if (replica && (!isWorkflowRun || await resolveTemplateProjectDirectory(replica.sourceWorkspace) !== replica.sourceWorkspace)) throw new Error(workflowSystemCopy.authority)
  const cwd = replica ? replica.workspace : request.cwd
    ? (isRemoteRun ? resolveRemoteProjectDirectory(request.cwd) : resolveKnownProjectDirectory(request.cwd))
    : currentCwd
  if (!isRemoteRun && !isWorkflowRun && request.cwd && currentCwd && cwd !== canonicalExistingDirectory(currentCwd)) {
    throw new AgentRuntimeError('发送请求的工作目录与当前授权目录不一致', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '重新选择目标项目后再发送'
    })
  }
  const catalogCwd = cwd ?? ''
  const assertSessionNotArchived = (sessionIds: readonly (string | null | undefined)[]): void => {
    if (sessionIds.some((sessionId) => sessionId && appSessionStore().isArchived({
      providerId, agentProfileId, cwd: catalogCwd, externalSessionId: sessionId
    }))) throw new AgentRuntimeError('这个会话已归档，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '先撤销归档，再继续该会话；待发送消息不会自动恢复'
    })
  }
  assertSessionNotArchived([request.expectedExternalSessionId])
  if (request.backend !== 'local') {
    throw new AgentRuntimeError(`backend=${request.backend} 尚未实现`, {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '切回 Local CLI；BYOK/API transport 尚未接入 Provider adapter'
    })
  }
  if (request.runtimeProvider && request.runtimeProvider !== runtimeProvider) {
    throw new AgentRuntimeError(`provider=${providerId} 与 runtimeProvider=${request.runtimeProvider} 不匹配`, {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '不要手工覆盖 runtimeProvider；由 Provider adapter descriptor 选择原生 transport'
    })
  }
  const lifecycleKey = providerOperationKey(providerId, agentProfileId)
  const startLease = isRemoteRun ? undefined : providerOperationGate.acquireOperation(lifecycleKey)
  if (startLease && !startLease.ok) {
    throw new AgentRuntimeError('当前 Provider 正在认证 MCP，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待浏览器认证完成或超时后再发送'
    })
  }
  const admissionKey = isWorkflowRun
    ? `workflow:${providerId}:${agentProfileId ?? 'default'}:${randomUUID()}`
    : providerContextKey(providerId, cwd ?? '', agentProfileId)
  const managedConversation = options.managedConversation
  const admissionKeys = managedConversation
    ? [admissionKey, `conversation:${managedConversation.conversationId}`]
    : [admissionKey]
  const remoteState: { value?: Promise<RemoteRunCompletion> } = {}
  try {
    const started = await runAppRunFrontdoor<{ runId: string } | RemoteRunCompletion>({
      contextAdmission, admissionKeys, startupManagedRecovery, shellEnvReady, startPerf, isShuttingDown, runtimeProvider,
      providerId, agentProfileId, cwd, catalogCwd, request, options, isRemoteRun, isWorkflowRun, isAuthoringRun, managedConversation,
      sessionRevisionByContext, sessionByContext, sessionAliasesByContext, appSessionStore, deletingSessions, runs,
      expectedRestartSourceMatches, expectedSessionMatches, runConflictsWithSession, waitForCompletedRuns, providerSessionKey,
      conversationStore, assertLegacyConversationWriteAllowed, recoverAppRunRecording, resolveManagedCommitHookEnv,
      recordingBlockedSessions, recordingRecoveryHint, resolveCodexHookTrust, resolveOpenCodePluginTrust,
      ensureMcpExecutionAuthorized, prepareAppRunEditLastTurn, adapter, authorizedMcpExecution, sessionBaselineKey,
      randomUUID, providerContextKey, resetSessionContext, cloneForkArchiveTurns,
      nextRunId
    }, state => execute({ ...state, request, options, isRemoteRun, isWorkflowRun, isAuthoringRun, providerId, agentProfileId, runtimeProvider, adapter, toolContentPolicy, replica, startPerf, firstTracePerf, firstTextPerf, remoteState, assertSessionNotArchived }))
    return isRemoteRun ? await remoteState.value! : started
  } catch (error) {
    startPerf.finish(undefined, 'error')
    firstTracePerf.finish(undefined, 'error')
    firstTextPerf.finish(undefined, 'error')
    throw error
  } finally {
    startLease?.release()
  }
}
