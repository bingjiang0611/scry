import { createHash } from 'node:crypto'
import type { AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest } from '../shared/runtime'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { ProviderId } from '../shared/provider'
import type { ProviderRunHandle, ProviderRunRequest, ProviderRunResult, AuthorizedMcpExecution } from './providers/types'
import type { McpExecutionSnapshot } from './mcp-execution-trust'
import type { ProviderRegistry } from './providers/registry'
import type { ManagedConversationStart } from './conversation-service'
import type { AppRunStartOptions } from './app-run-start'
import type { RunSteering } from './run-steering'
import type { LiveTraceIngestion } from './live-trace-ingestion'
import type { PerformanceTrace } from './performance-timing'
import type { WorkflowReplicaRun } from './workflow-system-host'
import type { ProviderEventWriter } from './provider-event-log'
import { AgentRuntimeError } from './run-outcome'
import { workflowPermissionResponse } from './workflow-question'
import { assertWorkflowAuthoringIdentity } from './workflow-authoring'

export interface AppRunProviderDeps {
  interrupted: () => boolean
  setProviderStartedAt: (value: string) => void
  firstTracePerf: Pick<PerformanceTrace, 'mark' | 'finish'>
  firstTextPerf: Pick<PerformanceTrace, 'mark' | 'finish'>
  managedConversation?: ManagedConversationStart
  conversationStore: () => { assertManagedWriteAllowed: (input: { conversationId: string; cwd: string; target: ManagedConversationStart['target']; nativeSessionId?: string; runId: string }) => Promise<void> }
  catalogCwd: string
  resume?: string
  providerRegistry: Pick<ProviderRegistry, 'run' | 'continuationKey'>
  providerId: ProviderId
  agentProfileId?: string
  assertLegacyConversationWriteAllowed: (scope: { providerId: ProviderId; agentProfileId?: string; cwd: string; nativeSessionId?: string }) => Promise<void>
  isWorkflowRun: boolean
  workflowRunControls: (role: { role: 'worker'; providerId: ProviderId; agentProfileId?: string; requestedModel?: AgentStartRequest['model']; permissionMode?: AgentStartRequest['permissionMode'] }, cwd: string, replica?: WorkflowReplicaRun) => Promise<{ model?: unknown; stop?: unknown; independentRun?: unknown; terminalOutput?: unknown; identity?: string }>
  workflowReplica?: WorkflowReplicaRun
  request: ReturnType<typeof import('../shared/runtime').normalizeAgentStartRequest>
  options: AppRunStartOptions
  authorizedMcpExecution: (snapshot: McpExecutionSnapshot | null) => AuthorizedMcpExecution | undefined
  mcpExecutionSnapshot: McpExecutionSnapshot | null
  runId: string
  isAuthoringRun: boolean
  assertWorkflowAuthoringIdentity: typeof assertWorkflowAuthoringIdentity
  runtimePrompt: string
  managedInputTextHash?: string
  adapter: ReturnType<ProviderRegistry['get']>
  cwd?: string
  attachments: import('./attachment-store').PreparedAttachment[]
  codexHookTrust: ProviderRunRequest['codexHookTrust']
  openCodePluginTrust: ProviderRunRequest['openCodePluginTrust']
  managedRecorderEnabled: boolean
  displayPrompt: string
  eventLog: ProviderEventWriter | undefined
  runState: ActiveRun
  emit: (event: TraceEvent) => void
  publishSessionId: (sessionId: string | undefined) => void
  userQuestionBroker: { request: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse> }
  publishQuestionOpened: (request: AgentQuestionRequest) => void
  publishQuestionClosed: (runId: string, questionId: string) => void
  stopLatch: AbortController
  requestStop: () => void
  requestRemoteStop: () => void
  steering: Pick<RunSteering, 'close' | 'idle'>
  ingestion: Pick<LiveTraceIngestion, 'idle'>
  mainEventId: (prefix: string, runId: string) => string
  runtimeProvider: import('../shared/runtime').RuntimeProvider
  createProviderHandle: (handle: ProviderRunHandle) => void
  getProviderHandle: () => ProviderRunHandle | null
  setWorkflowInteractionBlocked: () => void
}

export async function runAppProvider(deps: AppRunProviderDeps): Promise<ProviderRunResult> {
  if (deps.interrupted()) return { stopped: true }
  deps.setProviderStartedAt(new Date().toISOString())
  deps.firstTracePerf.mark('provider_launch')
  deps.firstTextPerf.mark('provider_launch')
  if (deps.managedConversation) {
    await deps.conversationStore().assertManagedWriteAllowed({
      conversationId: deps.managedConversation.conversationId,
      cwd: deps.catalogCwd,
      target: deps.managedConversation.target,
      nativeSessionId: deps.resume,
      runId: deps.managedConversation.runId
    })
    const identity = await deps.providerRegistry.continuationKey({ providerId: deps.providerId, cwd: deps.catalogCwd, agentProfileId: deps.agentProfileId })
    if (identity !== deps.managedConversation.target.continuationKey) throw new Error('Provider 接续身份在启动准备期间变化，未发送；请重新预览')
  } else await deps.assertLegacyConversationWriteAllowed({ providerId: deps.providerId, agentProfileId: deps.agentProfileId, cwd: deps.catalogCwd, nativeSessionId: deps.resume })
  if (deps.isWorkflowRun) {
    const controls = await deps.workflowRunControls({ role: 'worker', providerId: deps.providerId, agentProfileId: deps.agentProfileId,
      requestedModel: deps.request.model, permissionMode: deps.options.permissionModeOverride ?? deps.request.permissionMode }, deps.catalogCwd, deps.workflowReplica)
    if (!controls.model || !controls.stop || !controls.independentRun || !controls.terminalOutput || !deps.options.expectedWorkflowCapability || controls.identity !== deps.options.expectedWorkflowCapability) {
      throw new Error('工作流的 Provider 入口或模型/权限目录在启动准备期间变化，未发送；请重新规划并确认')
    }
  }
  const mcpExecution = deps.authorizedMcpExecution(deps.mcpExecutionSnapshot)
  if (deps.managedConversation && deps.runId !== deps.managedConversation.runId) throw new Error('统一对话 runId 与 Provider 投递 runId 不一致')
  if (deps.isAuthoringRun && deps.options.expectedWorkflowContinuationKey) await deps.assertWorkflowAuthoringIdentity(deps.options.expectedWorkflowContinuationKey,
    () => deps.providerRegistry.continuationKey({ providerId: deps.providerId, cwd: deps.catalogCwd, agentProfileId: deps.agentProfileId }))
  if (deps.isAuthoringRun && deps.options.beforeWorkflowAuthoringDispatch) await deps.options.beforeWorkflowAuthoringDispatch()
  if (deps.managedConversation?.beforeProviderDispatch) await deps.managedConversation.beforeProviderDispatch(deps.runId)
  deps.managedConversation?.onProviderDispatchAttempt?.()
  deps.options.onProviderDispatchAttempt?.()
  const handle = deps.providerRegistry.run(deps.providerId, {
    runId: deps.runId,
    ...(deps.isAuthoringRun ? { purpose: 'workflow_authoring' as const,
      ...(deps.options.authoringSchema ? { authoringSchema: deps.options.authoringSchema } : {}),
      ...(deps.options.expectedWorkflowContinuationKey ? { expectedContinuationKey: deps.options.expectedWorkflowContinuationKey } : {}) } : {}),
    prompt: deps.runtimePrompt,
    ...(deps.managedConversation?.historicalContext ? { historicalContext: deps.managedConversation.historicalContext } : {}),
    ...(deps.managedConversation?.historyReader ? { historyReader: deps.managedConversation.historyReader } : {}),
    ...(deps.managedConversation ? {
      expectedContinuationKey: deps.managedConversation.target.continuationKey,
      expectedInputTextHash: deps.managedInputTextHash,
      historyBudget: deps.managedConversation.historyBudget
    } : {}),
    trackInputReceipt: deps.adapter.historicalContext && !deps.runtimePrompt.trimStart().startsWith('/') ? true : undefined,
    cwd: deps.cwd,
    agentProfileId: deps.agentProfileId,
    resume: deps.resume,
    attachments: deps.attachments,
    model: deps.request.model,
    effort: deps.request.effort,
    permissionMode: deps.options.permissionModeOverride ?? deps.request.permissionMode,
    codexHookTrust: deps.codexHookTrust,
    openCodePluginTrust: deps.openCodePluginTrust,
    managedRecorder: deps.managedRecorderEnabled,
    ...(deps.managedRecorderEnabled && (deps.providerId === 'claude' || deps.providerId === 'qoder' || deps.providerId === 'opencode' || deps.providerId === 'pi') ? {
      managedRecorderIdentity: { runId: deps.runId, promptHash: createHash('sha256').update(deps.displayPrompt).digest('hex') }
    } : {}),
    mcpExecution,
    recordNative: deps.eventLog && ((type, payload) => deps.eventLog?.record('native', type, payload)),
    onWorkflowObservation: deps.options.onWorkflowObservation,
    emit: (event) => {
      deps.eventLog?.record('canonical', `${event.kind}/${event.stage}`, event)
      if (event.stage !== 'runtime:input_receipt' && event.stage !== 'runtime:historical_input') deps.firstTracePerf.finish({ bufferedEvents: deps.runState.items.length })
      if (event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta') && typeof event.text === 'string' && event.text.length > 0) {
        deps.firstTextPerf.finish({ bufferedEvents: deps.runState.items.length })
      }
      deps.emit(event)
    },
    onExternalSessionId: deps.publishSessionId,
    requestUserInput: async (question, signal) => {
      if (deps.isWorkflowRun) return workflowPermissionResponse(question, signal,
        (request, permissionSignal) => deps.userQuestionBroker.request({ ...request, providerId: deps.providerId }, permissionSignal),
        () => { deps.setWorkflowInteractionBlocked(); deps.requestRemoteStop() }, deps.options.onWorkflowObservation)
      if (deps.options.origin !== 'remote') return deps.userQuestionBroker.request({ ...question, providerId: deps.providerId }, signal)
      if (!deps.options.requestUserInput) throw new Error('remote_interactive_input_unsupported')
      const openedAtMs = Date.now()
      const remoteQuestion = { ...question, providerId: deps.providerId, runId: deps.runId }
      deps.publishQuestionOpened(remoteQuestion)
      const questionAbort = new AbortController()
      const relayAbort = (): void => questionAbort.abort()
      const questionSources = [signal, deps.stopLatch.signal, deps.options.stopSignal].filter((source): source is AbortSignal => Boolean(source))
      for (const source of questionSources) {
        if (source.aborted) questionAbort.abort()
        else source.addEventListener('abort', relayAbort, { once: true })
      }
      let response: AgentQuestionResponse
      try {
        response = await deps.options.requestUserInput(remoteQuestion, questionAbort.signal)
      } finally {
        for (const source of questionSources) source.removeEventListener('abort', relayAbort)
        deps.publishQuestionClosed(deps.runId, question.questionId)
      }
      const closedAtMs = Date.now()
      deps.emit({
        id: `remote-intervention-${question.questionId}`,
        ts: new Date(closedAtMs).toISOString(), runId: deps.runId, kind: 'human', stage: 'intervention',
        toolUseId: question.questionId, providerId: deps.providerId, agentId: question.agentId,
        durationMs: Math.max(0, closedAtMs - openedAtMs),
        intervention: {
          kind: question.questionKind ?? 'clarification', source: question.source ?? 'unknown',
          resolution: response.behavior === 'answered' ? 'answered' : signal.aborted ? 'provider_cancelled' : 'user_cancelled',
          request: { ...question, providerId: deps.providerId }, response,
          openedAt: new Date(openedAtMs).toISOString(), closedAt: new Date(closedAtMs).toISOString(),
          durationMs: Math.max(0, closedAtMs - openedAtMs)
        }
      })
      return response
    }
  })
  deps.createProviderHandle(handle)
  if (deps.options.stopSignal?.aborted) deps.requestStop()
  if (!handle.steer) deps.emit({
    id: deps.mainEventId('steer-capability', deps.runId), ts: new Date().toISOString(), runId: deps.runId,
    kind: 'harness', stage: 'runtime:steer_capability',
    steerCapability: { status: 'unavailable', reason: `${deps.providerId} 当前接入未提供已验证的原生 Steer；消息仍按队列发送。` }
  })
  if (deps.interrupted()) handle.interrupt()
  let result: Awaited<typeof handle.promise>
  try {
    try { result = await handle.promise } finally {
      deps.steering.close()
      await deps.steering.idle()
    }
  } catch (error) {
    deps.emit({
      id: deps.mainEventId('provider-ended', deps.runId), ts: new Date().toISOString(), runId: deps.runId,
      kind: 'harness', stage: 'runtime:provider_ended', providerId: deps.providerId,
      runtimeProvider: deps.runtimeProvider, runtimeMetadata: { status: 'failed' }
    })
    await deps.ingestion.idle()
    throw error
  }
  deps.emit({
    id: deps.mainEventId('provider-ended', deps.runId), ts: new Date().toISOString(), runId: deps.runId,
    kind: 'harness', stage: 'runtime:provider_ended', providerId: deps.providerId,
    runtimeProvider: deps.runtimeProvider,
    runtimeMetadata: { status: result.status ?? (result.stopped ? 'interrupted' : 'completed') }
  })
  await deps.ingestion.idle()
  if (result.status === 'failed') {
    const providerMessage = [...deps.runState.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result' && event.isError)?.text ??
      [...deps.runState.items].reverse().find((event) => event.stage === 'runtime:background_unresolved')?.text
    throw new AgentRuntimeError(providerMessage || `${deps.providerId} Provider 返回失败终态`, {
      provider: deps.runtimeProvider, stage: 'runtime', cwd: deps.cwd,
      nextAction: '检查该轮 Provider 结果与日志后重试'
    })
  }
  return result
}
