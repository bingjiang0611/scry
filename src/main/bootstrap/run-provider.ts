import { createHash } from 'node:crypto'
import { AgentRuntimeError } from '../run-outcome'
import type { AgentInputAttachment, AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest, AgentPermissionMode, RuntimeProvider } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { ProviderRunHandle, AuthorizedMcpExecution } from '../providers/types'
import type { CodexHookTrustGrant } from '../codex-hook-trust'
import type { OpenCodeProjectPluginAuthorization } from '../opencode-plugin-trust'
import type { ManagedConversationStart } from '../conversation-service'
import type { ConversationStore, NativeSessionScope } from '../conversation-store'
import type { McpExecutionSnapshot } from '../mcp-execution-trust'
import type { ProviderRegistry } from '../providers/registry'
import type { RunSteering } from '../run-steering'
import type { UserQuestionBroker } from '../user-question'
import type { LiveTraceIngestion } from '../live-trace-ingestion'
import type { PerformanceTrace } from '../performance-timing'

export interface RunProviderBootstrapDependencies {
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  providerRegistry: ProviderRegistry
  adapter: { historicalContext?: boolean }
  request: AgentStartRequest
  runtimePrompt: string
  managedConversation?: ManagedConversationStart
  runId: string
  cwd?: string
  agentProfileId?: string
  resume?: string
  attachments: AgentInputAttachment[]
  codexHookTrust: CodexHookTrustGrant[]
  openCodePluginTrust?: OpenCodeProjectPluginAuthorization
  managedRecorderEnabled: boolean
  managedInputTextHash?: string
  displayPrompt: string
  eventLog?: { record: (stream: 'native' | 'canonical', type: string, payload: unknown) => void }
  handle: { current: ProviderRunHandle | null }
  steering: RunSteering
  interrupted: () => boolean
  requestStop: () => void
  stopLatch: AbortController
  stopSignal?: AbortSignal
  requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
  isRemoteRun: boolean
  permissionModeOverride?: AgentPermissionMode
  mcpExecutionSnapshot: McpExecutionSnapshot | null
  conversationStore: Pick<ConversationStore, 'assertManagedWriteAllowed'>
  catalogCwd: string
  assertLegacyConversationWriteAllowed: (scope: NativeSessionScope) => Promise<void>
  authorizeMcpExecution: (snapshot: McpExecutionSnapshot | null) => AuthorizedMcpExecution | undefined
  publishQuestionOpened: (request: AgentQuestionRequest) => void
  publishQuestionClosed: (runId: string, questionId: string) => void
  setProviderStartedAt: (value: string) => void
  publishSessionId: (sessionId: string | undefined) => void
  emit: (event: TraceEvent) => void
  runState: ActiveRun
  ingestion: LiveTraceIngestion
  firstTracePerf: PerformanceTrace
  firstTextPerf: PerformanceTrace
  mainEventId: (prefix: string, runId: string) => string
  userQuestionBroker: UserQuestionBroker
}

export function createRunProvider(deps: RunProviderBootstrapDependencies): () => Promise<{ externalSessionId?: string; providerTurnId?: string; forkTurnId?: string; stopped?: boolean; status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'; recordingFailure?: { message: string } }> {
  const {
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
    eventLog,
    handle,
    steering,
    interrupted,
    requestStop,
    stopLatch,
    stopSignal,
    requestUserInput,
    publishSessionId,
    emit,
    runState,
    ingestion,
    firstTracePerf,
    firstTextPerf,
    mainEventId,
    userQuestionBroker,
    isRemoteRun,
    permissionModeOverride,
    mcpExecutionSnapshot,
    conversationStore,
    catalogCwd,
    assertLegacyConversationWriteAllowed,
    authorizeMcpExecution,
    publishQuestionOpened,
    publishQuestionClosed,
    setProviderStartedAt
  } = deps
  const runProvider = async (): Promise<{
    externalSessionId?: string
    providerTurnId?: string
    forkTurnId?: string
    stopped?: boolean
    status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
    recordingFailure?: { message: string }
  }> => {
    if (interrupted()) return { stopped: true }
    setProviderStartedAt(new Date().toISOString())
    firstTracePerf.mark('provider_launch')
    firstTextPerf.mark('provider_launch')
    // Re-hash executable bytes at the actual Provider launch boundary, after all
    // attachment/recorder/diff preparation that may have yielded to the event loop.
    if (managedConversation) {
      await conversationStore.assertManagedWriteAllowed({
        conversationId: managedConversation.conversationId,
        cwd: catalogCwd,
        target: managedConversation.target,
        nativeSessionId: resume,
        runId: managedConversation.runId
      })
      const identity = await providerRegistry.continuationKey({ providerId, cwd: catalogCwd, agentProfileId })
      if (identity !== managedConversation.target.continuationKey) throw new Error('Provider 接续身份在启动准备期间变化，未发送；请重新预览')
    } else await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: resume })
    const mcpExecution = authorizeMcpExecution(mcpExecutionSnapshot)
    if (managedConversation && runId !== managedConversation.runId) {
      throw new Error('统一对话 runId 与 Provider 投递 runId 不一致')
    }
    managedConversation?.onProviderDispatchAttempt?.()
    handle.current = providerRegistry.run(providerId, {
      runId,
      prompt: runtimePrompt,
      ...(managedConversation?.historicalContext ? { historicalContext: managedConversation.historicalContext } : {}),
      ...(managedConversation?.historyReader ? { historyReader: managedConversation.historyReader } : {}),
      ...(managedConversation ? {
        expectedContinuationKey: managedConversation.target.continuationKey,
        expectedInputTextHash: managedInputTextHash,
        historyBudget: managedConversation.historyBudget
      } : {}),
      // First / same-provider turns need receipts too. Native slash commands retain
      // their existing dispatch; a successful control command is not model-input evidence.
      trackInputReceipt: adapter.historicalContext && !runtimePrompt.trimStart().startsWith('/') ? true : undefined,
      cwd,
      agentProfileId,
      resume,
      attachments,
      model: request.model,
      effort: request.effort,
      permissionMode: permissionModeOverride ?? request.permissionMode,
      codexHookTrust,
      openCodePluginTrust,
      managedRecorder: managedRecorderEnabled,
      ...(managedRecorderEnabled && (providerId === 'claude' || providerId === 'qoder' || providerId === 'opencode' || providerId === 'pi') ? {
        managedRecorderIdentity: {
          runId,
          promptHash: createHash('sha256').update(displayPrompt).digest('hex')
        }
      } : {}),
      mcpExecution,
      recordNative: eventLog && ((type, payload) => eventLog.record('native', type, payload)),
      emit: (event) => {
        eventLog?.record('canonical', `${event.kind}/${event.stage}`, event)
        // The input-attempt diagnostic precedes the native call, not a Provider response.
        if (event.stage !== 'runtime:input_receipt' && event.stage !== 'runtime:historical_input') {
          firstTracePerf.finish({ bufferedEvents: runState.items.length })
        }
        if (event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta') &&
          typeof event.text === 'string' && event.text.length > 0) {
          // This is the first provider text event, not a renderer paint or a UI display time.
          firstTextPerf.finish({ bufferedEvents: runState.items.length })
        }
        emit(event)
      },
      onExternalSessionId: publishSessionId,
      requestUserInput: async (question, signal) => {
        if (!isRemoteRun) return userQuestionBroker.request({ ...question, providerId }, signal)
        if (!requestUserInput) throw new Error('remote_interactive_input_unsupported')
        const openedAtMs = Date.now()
        const remoteQuestion = { ...question, providerId, runId }
        publishQuestionOpened(remoteQuestion)
        const questionAbort = new AbortController()
        const relayAbort = (): void => questionAbort.abort()
        const questionSources = [signal, stopLatch.signal, stopSignal].filter((source): source is AbortSignal => Boolean(source))
        for (const source of questionSources) {
          if (source.aborted) questionAbort.abort()
          else source.addEventListener('abort', relayAbort, { once: true })
        }
        let response: AgentQuestionResponse
        try {
          response = await requestUserInput(remoteQuestion, questionAbort.signal)
        } finally {
          for (const source of questionSources) source.removeEventListener('abort', relayAbort)
          publishQuestionClosed(runId, question.questionId)
        }
        const closedAtMs = Date.now()
        emit({
          id: `remote-intervention-${question.questionId}`,
          ts: new Date(closedAtMs).toISOString(), runId, kind: 'human', stage: 'intervention',
          toolUseId: question.questionId, providerId, agentId: question.agentId,
          durationMs: Math.max(0, closedAtMs - openedAtMs),
          intervention: {
            kind: question.questionKind ?? 'clarification', source: question.source ?? 'unknown',
            resolution: response.behavior === 'answered' ? 'answered' : signal.aborted ? 'provider_cancelled' : 'user_cancelled',
            request: { ...question, providerId }, response,
            openedAt: new Date(openedAtMs).toISOString(), closedAt: new Date(closedAtMs).toISOString(),
            durationMs: Math.max(0, closedAtMs - openedAtMs)
          }
        })
        return response
      }
    })
    if (stopSignal?.aborted) requestStop()
    if (!handle.current?.steer) emit({
      id: mainEventId('steer-capability', runId), ts: new Date().toISOString(), runId,
      kind: 'harness', stage: 'runtime:steer_capability',
      steerCapability: { status: 'unavailable', reason: `${providerId} 当前接入未提供已验证的原生 Steer；消息仍按队列发送。` }
    })
    if (interrupted()) handle.current?.interrupt()
    let result: Awaited<ProviderRunHandle['promise']>
    try {
      try { result = await handle.current!.promise } finally {
        steering.close()
        await steering.idle()
      }
    } catch (error) {
      emit({
        id: mainEventId('provider-ended', runId),
        ts: new Date().toISOString(),
        runId,
        kind: 'harness',
        stage: 'runtime:provider_ended',
        providerId,
        runtimeProvider,
        runtimeMetadata: { status: 'failed' }
      })
      await ingestion.idle()
      throw error
    }
    emit({
      id: mainEventId('provider-ended', runId),
      ts: new Date().toISOString(),
      runId,
      kind: 'harness',
      stage: 'runtime:provider_ended',
      providerId,
      runtimeProvider,
      runtimeMetadata: { status: result.status ?? (result.stopped ? 'interrupted' : 'completed') }
    })
    await ingestion.idle()
    if (result.status === 'failed') {
      const providerMessage = [...runState.items].reverse().find(
        (event) => event.kind === 'harness' && event.stage === 'result' && event.isError
      )?.text ?? [...runState.items].reverse().find((event) => event.stage === 'runtime:background_unresolved')?.text
      throw new AgentRuntimeError(providerMessage || `${providerId} Provider 返回失败终态`, {
        provider: runtimeProvider,
        stage: 'runtime',
        cwd,
        nextAction: '检查该轮 Provider 结果与日志后重试'
      })
    }
    return result
  }
  return runProvider
}
