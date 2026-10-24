import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import type { RuntimeProvider, NormalizedAgentStartRequest, AgentForceKillScope, AgentSteerInput, AgentSteerResult, AgentQuestionRequest, AgentPermissionMode, AgentIntervention } from '../../shared/runtime'
import type { BackgroundTaskStopResult } from '../../shared/background-work'
import type { ProviderRunHandle } from '../providers/types'
import type { GitTurnDiffCapture } from '../git'
import type { ProviderRegistry } from '../providers/registry'
import type { ConversationStore, NativeSessionScope } from '../conversation-store'
import type { ManagedConversationStart } from '../conversation-service'
import type { PreparedAttachment } from '../attachment-store'
import type { McpExecutionSnapshot } from '../mcp-execution-trust'
import type { LiveTraceIngestion } from '../live-trace-ingestion'
import type { RunSteering } from '../run-steering'
import type { UserQuestionBroker } from '../user-question'
import type { AppRunStartOptions } from './run-frontdoor'
import type { PerformanceTrace } from '../performance-timing'
import { openProviderEventWriter } from '../provider-event-log'
import { createRunProvider } from './run-provider'
import { cancelGitTurnDiff } from '../git'
import { authorizedMcpExecution } from './trust'

type StartRuns = { get: (runId: string) => { control: RunControl } | undefined; register: (state: ActiveRun, control: RunControl, options?: { focus?: boolean }) => void }
type StartSourceControl = { admitRun: (cwd: string | undefined, callback: () => void) => Promise<void> }
type StartHandle = { current: ProviderRunHandle | null }
export interface RunControl {
  runId: string; providerId: ProviderId; interrupt: () => void; forceKill: () => void
  stopBackgroundTask: (taskId: string) => Promise<BackgroundTaskStopResult>
  steer: (input: AgentSteerInput) => Promise<AgentSteerResult>
  forceKillScope: () => AgentForceKillScope | undefined
  cwd?: string; resume?: string; getExternalSessionId: () => string | undefined; getProviderTurnId: () => string | undefined
  canonicalLifecycle: boolean; runtimeProvider: RuntimeProvider; runState: ActiveRun; adoptSession: () => void
  cleanupProvisional: () => void; finalizeTurnDiff: () => Promise<void>; cancelTurnDiff: () => Promise<void>; settled: Promise<void>
}
export type RunStartupDeps = {
  options: AppRunStartOptions; providerId: ProviderId; runtimeProvider: RuntimeProvider; providerRegistry: ProviderRegistry
  adapter: ReturnType<ProviderRegistry['get']>; request: NormalizedAgentStartRequest; runtimePrompt: string
  managedConversation?: ManagedConversationStart; runId: string; cwd: string | undefined; agentProfileId?: string; resume?: string
  attachments: PreparedAttachment[]; codexHookTrust: Awaited<ReturnType<typeof import('./trust').resolveCodexHookTrust>>; openCodePluginTrust: Awaited<ReturnType<typeof import('./trust').resolveOpenCodePluginTrust>>; managedRecorderEnabled: boolean
  managedInputTextHash?: string; displayPrompt: string; handle: StartHandle; steering: RunSteering
  userQuestionBroker: UserQuestionBroker; publishSessionId: (sessionId: string | undefined) => void; emit: (event: TraceEvent) => void
  runState: ActiveRun; ingestion: LiveTraceIngestion; firstTracePerf: PerformanceTrace; firstTextPerf: PerformanceTrace
  mainEventId: (prefix: string, runId: string) => string; isRemoteRun: boolean; permissionModeOverride?: AgentPermissionMode
  mcpExecutionSnapshot: McpExecutionSnapshot | null; conversationStore: () => ConversationStore; catalogCwd: string
  assertLegacyConversationWriteAllowed: (scope: NativeSessionScope) => Promise<void>
  publishQuestionOpened: (request: AgentQuestionRequest) => void
  publishQuestionClosed: (runId: string, questionId: string, intervention?: AgentIntervention) => void
  runs: StartRuns; requestRunStop: (runId: string) => void; contextKey: string
  setContextRevision: (value: number) => void; getObservedSessionId: () => string | undefined
  sessionByContext: Map<string, string>; sessionRevisionByContext: Map<string, number>; bumpSessionRevision: (key: string) => void
  cleanupProvisional: () => void; finalizeTurnDiff: () => Promise<void>; cancelTurnDiff: () => Promise<void>
  sourceControl: StartSourceControl; canonicalLifecycle: boolean; assertSessionNotArchived: (ids: readonly (string | null | undefined)[]) => void
  remoteRunIds: Set<string>; remoteRunLedgerIds: Map<string, string>
  deleteRunAttachments: (userDataDir: string, runId: string) => void; turnDiffCapture: Promise<GitTurnDiffCapture>; sessionBaselineReady: Promise<unknown>
  startPerf: PerformanceTrace; dockBadge: { view: (key: string, focused: boolean) => void }; scopedSessionKey: (id: string) => string
  getWindow: () => BrowserWindow | null; boundedLiveRun: (run: ActiveRun) => ActiveRun
  releaseSessionBaseline?: () => void; interruptedState: { value: boolean }
}
export function startProviderAfterBaseline<T>(deps: { turnDiffCapture: Promise<unknown>; sessionBaselineReady: Promise<unknown>; markReady: () => void; runProvider: () => Promise<T> }): Promise<T> {
  return Promise.all([deps.turnDiffCapture, deps.sessionBaselineReady]).then(() => {
    deps.markReady()
    return deps.runProvider()
  })
}

export async function startRunProviderAndRegister(deps: RunStartupDeps) {
  const {
    options,
    providerId,
    runtimeProvider,
    providerRegistry,
    adapter,
    request,
    runtimePrompt,
    managedConversation,
    runId,
    cwd,
    agentProfileId,
    resume,
    attachments,
    codexHookTrust,
    openCodePluginTrust,
    managedRecorderEnabled,
    managedInputTextHash,
    displayPrompt,
    handle,
    steering,
    userQuestionBroker,
    publishSessionId,
    emit,
    runState,
    ingestion,
    firstTracePerf,
    firstTextPerf,
    mainEventId,
    isRemoteRun,
    mcpExecutionSnapshot,
    conversationStore,
    catalogCwd,
    publishQuestionOpened,
    publishQuestionClosed,
    runs,
    requestRunStop,
    contextKey,
    setContextRevision,
    getObservedSessionId,
    sessionByContext,
    sessionRevisionByContext,
    bumpSessionRevision,
    cleanupProvisional,
    finalizeTurnDiff,
    cancelTurnDiff,
    sourceControl,
    assertSessionNotArchived,
    remoteRunIds,
    remoteRunLedgerIds,
    deleteRunAttachments,
    turnDiffCapture,
    sessionBaselineReady,
    startPerf,
    dockBadge,
    scopedSessionKey,
    getWindow,
    boundedLiveRun,
    releaseSessionBaseline,
    interruptedState,
    canonicalLifecycle,
    assertLegacyConversationWriteAllowed
  } = deps
  let interrupted = interruptedState.value
  const eventLog = openProviderEventWriter(`${providerId}-${runId}`)
  const stopLatch = new AbortController()
  const requestStop = (): void => {
    interrupted = true
    if (!stopLatch.signal.aborted) stopLatch.abort()
    handle.current?.interrupt()
  }
  const requestRemoteStop = (): void => {
    if (runs.get(runId)) requestRunStop(runId)
    else requestStop()
  }
  if (options.stopSignal && !options.stopSignal.aborted) options.stopSignal.addEventListener('abort', requestRemoteStop)
  let observedProviderStartedAt: string | undefined
  const runProvider = createRunProvider({
    providerId, runtimeProvider, providerRegistry, adapter, request, runtimePrompt, managedConversation, runId, cwd, agentProfileId, resume, attachments, codexHookTrust, openCodePluginTrust, managedRecorderEnabled, managedInputTextHash, displayPrompt, eventLog, handle, steering, interrupted: () => interrupted, requestStop, stopLatch, stopSignal: options.stopSignal, requestUserInput: async (request, signal) => isRemoteRun && options.requestUserInput ? options.requestUserInput(request, signal) : userQuestionBroker.request(request, signal), publishSessionId, emit, runState, ingestion, firstTracePerf, firstTextPerf, mainEventId, userQuestionBroker, isRemoteRun, permissionModeOverride: options.permissionModeOverride, mcpExecutionSnapshot, conversationStore: conversationStore(), catalogCwd, assertLegacyConversationWriteAllowed: (scope) => assertLegacyConversationWriteAllowed(scope as NativeSessionScope), authorizeMcpExecution: (snapshot) => authorizedMcpExecution(snapshot as McpExecutionSnapshot | null), publishQuestionOpened, publishQuestionClosed, setProviderStartedAt: (value) => { observedProviderStartedAt = value }
  })

  let resolveSettled: (() => void) | undefined
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
  const control: RunControl = {
    runId,
    providerId,
    interrupt: requestStop,
    forceKill: () => {
      requestStop()
      handle.current?.forceKill()
    },
    forceKillScope: () => handle.current?.forceKillScope,
    stopBackgroundTask: (taskId) => handle.current?.stopBackgroundTask?.(taskId) ?? Promise.resolve({ status: 'unavailable', message: '当前 Provider 不支持单任务停止。' }),
    steer: (input) => managedConversation
      ? Promise.resolve({ status: 'unavailable', message: '统一对话暂不支持 Steer；追加输入尚无完整的顺序投影，未发送。' })
      : steering.submit(input),
    cwd,
    resume,
    getExternalSessionId: () => handle.current?.getExternalSessionId(),
    getProviderTurnId: () => handle.current?.getProviderTurnId?.(),
    canonicalLifecycle,
    runtimeProvider,
    runState,
    adoptSession: () => {
      if (managedConversation) throw new Error('统一对话不能由旧会话入口接管，请打开其稳定对话条目')
      if (!contextKey) return
      bumpSessionRevision(contextKey)
      setContextRevision(sessionRevisionByContext.get(contextKey) ?? 0)
      const observed = getObservedSessionId()
      if (observed) sessionByContext.set(contextKey, observed)
      else sessionByContext.delete(contextKey)
    },
    cleanupProvisional,
    finalizeTurnDiff,
    cancelTurnDiff,
    settled
  }
  try {
    if (isRemoteRun) {
      remoteRunIds.add(runId)
      if (options.ledgerRunId) remoteRunLedgerIds.set(runId, options.ledgerRunId)
    }
    const register = () => {
      assertSessionNotArchived([request.expectedExternalSessionId, resume, runId])
      runs.register(runState, control, isRemoteRun || managedConversation || options.workspaceAdmission ? { focus: false } : undefined)
    }
    if (options.workspaceAdmission) {
      // The commonDir reservation stays held through trust and both baseline outcomes.
      await Promise.all([turnDiffCapture, sessionBaselineReady])
      await options.workspaceAdmission.admit(register)
    } else await sourceControl.admitRun(cwd, register)
  } catch (error) {
    if (isRemoteRun) {
      remoteRunIds.delete(runId)
      remoteRunLedgerIds.delete(runId)
    }
    releaseSessionBaseline?.()
    try { cleanupProvisional() } catch { /* preserve the original registration error */ }
    deleteRunAttachments(app.getPath('userData'), runId)
    try { await cancelGitTurnDiff(await turnDiffCapture) } catch { /* preserve the original registration error */ }
    throw error
  }
  startPerf.mark('run_registered')
  firstTextPerf.mark('run_registered')
  if (!isRemoteRun && !managedConversation && !options.workspaceAdmission) dockBadge.view(scopedSessionKey(resume ?? runId), Boolean(getWindow()?.isFocused()))
  if (!isRemoteRun && !managedConversation && !options.workspaceAdmission) {
    try {
      getWindow()?.webContents.send('agent:focusedRun', boundedLiveRun(runState))
    } catch (error) {
      console.warn('[scry] focused run renderer notification failed:', runId, error)
    }
  }
  return { runProvider, requestStop, requestRemoteStop, eventLog, getInterrupted: () => interrupted, getObservedProviderStartedAt: () => observedProviderStartedAt, control, settled, resolveSettled }
}
