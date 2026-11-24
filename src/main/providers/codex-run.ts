import {
  type AgentSteerInput,
  type AgentSteerResult
} from '../../shared/runtime'
import { HISTORY_READER_SERVER, HISTORY_READER_TOOL, type HistoryReaderConnection } from '../conversation-history-reader'
import type { CodexHookTrustGrant } from '../codex-hook-trust'
import type { CodexAppServerClient, CodexNotificationEnvelope } from './codex-app-server'
import { CodexAppServerResponseError } from './codex-app-server'
import { HistoricalInput } from './historical-input'
import { createServerRequestHandler } from './codex-run-requests'
import {
  createCodexNotificationHandler,
  type CodexTurnState,
  type ResponseTimingState
} from './codex-run-notifications'
import type { ProviderRunHandle, ProviderRunRequest, ProviderRunResult } from './types'
import type { AuthorizedMcpExecution } from './types'
import type { CapabilityEnvelope, ProviderContext, SkillMeta } from '../../shared/provider'
import {
  newEvent,
  newEventAt,
  record,
  type ItemTraceContext
} from './codex-trace'
import {
  codexAccess,
  codexInput,
  codexMcpStatus,
  epochMilliseconds,
  explicitSkillMention,
  type CodexThreadResponse,
  type CodexTurnResponse,
} from './codex-protocol'

/**
 * One Codex turn: attach to a thread, stream app-server notifications into trace events, and settle
 * with the run's own accounting. Split from the adapter because the adapter is a client pool and a
 * surface, while this is the only place that reads turn notifications.
 */
export interface CodexRunDeps {
  request: <T>(
    method: string,
    params?: unknown,
    cwd?: string,
    hookTrust?: CodexHookTrustGrant[],
    mcpExecution?: AuthorizedMcpExecution,
    expectedContinuationKey?: string,
    historyReader?: HistoryReaderConnection
  ) => Promise<T>
  getClient: (
    cwd?: string,
    hookTrust?: CodexHookTrustGrant[],
    mcpExecution?: AuthorizedMcpExecution,
    expectedContinuationKey?: string,
    historyReader?: HistoryReaderConnection
  ) => CodexAppServerClient
  shutdownClient: (client: CodexAppServerClient) => Promise<void>
  scheduleClientShutdown: (client: CodexAppServerClient) => void
  clientActivity: Map<CodexAppServerClient, number>
  clientActiveRuns: Map<CodexAppServerClient, number>
  modelCache: Map<string, { data: unknown; observedAt: number }>
  skills: {
    list: (
      context: ProviderContext,
      forceReload?: boolean,
      expectedContinuationKey?: string
    ) => Promise<CapabilityEnvelope<SkillMeta[]>>
  }
}

export function createCodexRun(deps: CodexRunDeps) {
  const { request, getClient, shutdownClient, scheduleClientShutdown, clientActivity, clientActiveRuns, skills } = deps
  return (runRequest: ProviderRunRequest): ProviderRunHandle => {
    const history = new HistoricalInput(runRequest)
    const state: CodexTurnState = {
      externalSessionId: runRequest.resume,
      turnId: undefined,
      llmCallPendingToolHooks: 0,
      lastRequestUsage: undefined,
      turnCompleted: false,
      lastTurnError: undefined,
      modelContextWindow: undefined,
      childAgents: new Map(),
      seenSubAgentActivities: new Set(),
      planUpdateSeq: 0,
      turnStartRequested: false,
      lastSeenCumulativeUsage: undefined,
      turnUsage: undefined,
      llmCallStartMs: undefined,
      llmCallFirstTokenMs: undefined,
      llmCallLastOutputMs: undefined,
      model: undefined,
      modelProvider: undefined,
      serviceTier: undefined,
      authMode: undefined,
      accountPlan: undefined,
      stopped: false
    }
    let unsubscribe = () => {}
    let unsubscribeRequest = () => {}
    const approvalControllers = new Set<AbortController>()
    const advanceLlmCallStart = (atMs: number): void => {
      if (state.llmCallLastOutputMs != null) return
      state.llmCallStartMs = state.llmCallStartMs == null ? atMs : Math.max(state.llmCallStartMs, atMs)
    }
    const observeLlmOutput = (atMs: number, firstToken: boolean): void => {
      if (state.llmCallStartMs == null || atMs < state.llmCallStartMs) return
      if (firstToken) state.llmCallFirstTokenMs ??= atMs
      state.llmCallLastOutputMs = Math.max(state.llmCallLastOutputMs ?? atMs, atMs)
    }
    const resetLlmCall = (startMs: number): void => {
      state.llmCallStartMs = startMs
      state.llmCallFirstTokenMs = undefined
      state.llmCallLastOutputMs = undefined
      state.llmCallPendingToolHooks = 0
    }
    let activeClient: CodexAppServerClient | undefined
    const timingByThread = new Map<string, ResponseTimingState>()
    let finish: ((value: ProviderRunResult) => void) | undefined
    let accountReadError: string | undefined
    let interruptDispatched = false
    const dispatchInterrupt = (): void => {
      if (interruptDispatched || !state.externalSessionId || !state.turnId) return
      interruptDispatched = true
      // This native turn belongs to the retained client. A credential refresh
      // must not redirect or prevent stopping that already-owned operation.
      void activeClient!.request(
        'turn/interrupt',
        { threadId: state.externalSessionId, turnId: state.turnId }
      ).catch((error) => {
        runRequest.emit(newEvent(runRequest.runId, {
          kind: 'harness', stage: 'runtime:error', isError: true,
          text: `Codex interrupt failed; waiting for native completion: ${error instanceof Error ? error.message : String(error)}`
        }))
      })
    }

    const handleServerRequest = createServerRequestHandler({ state, runRequest, approvalControllers, emit: () => {} })

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
      const created: ResponseTimingState = { boundaryMs: fallbackBoundaryMs, responses: new Map() }
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
      state.responses.set(responseId, {})
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
        const appServer = getClient(
          runRequest.cwd,
          runRequest.codexHookTrust,
          runRequest.mcpExecution,
          runRequest.expectedContinuationKey,
          runRequest.historyReader
        )
        activeClient = appServer
        clientActivity.set(appServer, (clientActivity.get(appServer) ?? 0) + 1)
        clientActiveRuns.set(appServer, (clientActiveRuns.get(appServer) ?? 0) + 1)
        await appServer.start()
        const generationFailure = appServer.failureForCurrentGeneration()
        unsubscribeRequest = appServer.onRequest(handleServerRequest)
        const accountPromise = appServer.request<Record<string, unknown>>('account/read', { refreshToken: false }).catch((error) => {
          accountReadError = String((error as Error).message)
          return null
        })
        unsubscribe = appServer.onNotification(createCodexNotificationHandler({
          state,
          runRequest,
          timingByThread,
          finish: (result) => finish?.(result),
          advanceLlmCallStart,
          observeLlmOutput,
          resetLlmCall,
          notificationAt,
          timingState,
          advanceTimingBoundary,
          emitObservedResponse
        }))

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
              runRequest.codexHookTrust,
              runRequest.mcpExecution,
              runRequest.expectedContinuationKey,
              runRequest.historyReader
            )
          : await request<CodexThreadResponse>(
              'thread/start',
              {
                cwd: runRequest.cwd,
                ...access,
                ...(runRequest.model ? { model: runRequest.model.id } : {})
              },
              runRequest.cwd,
              runRequest.codexHookTrust,
              runRequest.mcpExecution,
              runRequest.expectedContinuationKey,
              runRequest.historyReader
            )
        state.externalSessionId = thread.thread.id
        history.verifySession(state.externalSessionId)
        if (runRequest.historyReader) {
          const statuses = codexMcpStatus(await appServer.request('mcpServerStatus/list', { threadId: state.externalSessionId, detail: 'full' }))
          const reader = statuses.find(server => server.name === HISTORY_READER_SERVER)
          if (!reader?.toolNames?.includes(HISTORY_READER_TOOL) || reader.status === 'failed' || reader.status === 'needs-auth') {
            throw new Error('Codex 未确认历史检索工具可用，输入未投递')
          }
        }
        state.model = thread.model
        state.modelProvider = thread.modelProvider
        state.serviceTier = thread.serviceTier
        const accountResponse = await accountPromise
        const account = record(accountResponse && record(accountResponse).account)
        state.authMode = typeof account.type === 'string' ? account.type : undefined
        state.accountPlan = typeof account.planType === 'string' ? account.planType : undefined
        if (accountReadError) {
          runRequest.emit(newEvent(runRequest.runId, {
            kind: 'harness',
            stage: 'runtime:telemetry_degraded',
            text: 'Codex account detection failed; billing provider is unavailable',
            runtimeMetadata: { source: 'codex_app_server', capability: 'billing_identity', error: accountReadError }
          }))
        }
        runRequest.onExternalSessionId?.(state.externalSessionId)
        if (state.stopped) return { externalSessionId: state.externalSessionId, stopped: true, status: 'interrupted' }
        let input: unknown[] = []
        const mention = explicitSkillMention(runRequest.prompt)
        const skill = mention
          ? (await skills.list({ providerId: 'codex', cwd: runRequest.cwd }, false, runRequest.expectedContinuationKey)).data?.find(
              (item) => item.enabled && item.name === mention.name
            )
          : undefined
        if (state.stopped) return { externalSessionId: state.externalSessionId, stopped: true, status: 'interrupted' }
        const text = history.text(skill && mention ? mention.text : runRequest.prompt, skill !== undefined)
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
        input = [
          ...input,
          ...codexInput(text, runRequest.attachments)
        ]
        history.attempting(text)
        // Notifications can arrive before the turn/start response supplies the native turn ID.
        state.turnStartRequested = true
        const turn = await request<CodexTurnResponse>('turn/start', {
          threadId: state.externalSessionId,
          input,
          cwd: runRequest.cwd,
          approvalPolicy: access.approvalPolicy,
          ...(access.approvalsReviewer ? { approvalsReviewer: access.approvalsReviewer } : {}),
          ...(runRequest.model ? { model: runRequest.model.id } : {}),
          ...(runRequest.effort ? { effort: runRequest.effort } : {})
        }, runRequest.cwd, runRequest.codexHookTrust, runRequest.mcpExecution, runRequest.expectedContinuationKey, runRequest.historyReader)
        state.turnId = turn.turn.id
        if (state.turnId) history.accepted(state.externalSessionId, 'codex_turn_start_response', state.turnId)
        runRequest.emit(newEvent(runRequest.runId, {
          kind: 'harness',
          stage: 'runtime:steer_capability',
          steerCapability: { status: 'available', attachments: true },
          runtimeMetadata: { source: 'codex_app_server', threadId: state.externalSessionId, turnId: state.turnId }
        }))
        if (state.externalSessionId) {
          const startedAtMs = epochMilliseconds(turn.turn.startedAt) ?? Date.now()
          const timing = timingState(state.externalSessionId)
          if (timing.responses.size === 0 && timing.boundaryMs == null) timing.boundaryMs = startedAtMs
        }
        if (state.stopped) dispatchInterrupt()
        // A failed control request is not termination evidence either. Keep notifications
        // and execution ownership until native completion or transport termination.
        return await Promise.race([
          done,
          generationFailure.then((error) => Promise.reject(error))
        ])
      } finally {
        unsubscribe()
        unsubscribeRequest()
        for (const controller of approvalControllers) controller.abort()
        approvalControllers.clear()
        if (activeClient) {
          const active = Math.max(0, (clientActivity.get(activeClient) ?? 1) - 1)
          if (active > 0) clientActivity.set(activeClient, active)
          else clientActivity.delete(activeClient)
          const runs = Math.max(0, (clientActiveRuns.get(activeClient) ?? 1) - 1)
          if (runs > 0) clientActiveRuns.set(activeClient, runs)
          else clientActiveRuns.delete(activeClient)
          if (runRequest.historyReader) await shutdownClient(activeClient)
          else scheduleClientShutdown(activeClient)
        }
      }
    })()

    const steer = async (input: AgentSteerInput): Promise<AgentSteerResult> => {
      const threadId = state.externalSessionId
      const expectedTurnId = state.turnId
      if (state.stopped || state.turnCompleted || !threadId || !expectedTurnId) {
        return {
          status: 'unavailable',
          message: state.stopped
            ? 'Codex turn has stopped'
            : state.turnCompleted
              ? 'Codex turn has completed'
              : 'Codex native turn identity is not ready'
        }
      }
      const client = activeClient
      // Do not let client.request() auto-start a new generation after this run lost its
      // transport; steering is same-turn admission, never a restart path.
      if (!client || client.pid == null) return { status: 'unknown', message: 'Codex app-server transport is unavailable' }
      try {
        const response = await client.requestRunning<{ turnId?: unknown }>('turn/steer', {
          threadId,
          expectedTurnId,
          clientUserMessageId: input.messageId,
          input: codexInput(input.prompt, input.attachments)
        })
        if (response?.turnId !== expectedTurnId) return { status: 'unknown', message: 'Codex Steer 回执缺少匹配的原生 turn 身份，不能确认接收。' }
        return { status: 'accepted', providerTurnId: response.turnId }
      } catch (error) {
        if (error instanceof CodexAppServerResponseError) {
          if (error.code === -32601) return { status: 'unavailable', message: error.message }
          if (error.code === undefined || error.code === -32603) return { status: 'unknown', message: error.message }
          return { status: 'rejected', message: error.message }
        }
        return { status: 'unknown', message: error instanceof Error ? error.message : String(error) }
      }
    }

    const interrupt = (): void => {
      state.stopped = true
      for (const controller of approvalControllers) controller.abort()
      dispatchInterrupt()
    }

    return {
      promise,
      interrupt,
      steer,
      forceKill: () => activeClient?.close(),
      // app-server client 按 cwd 复用（clientActivity 计数）：close() 会断掉同一 client 上
      // 所有并发 run，所以不能当作 run-scoped 硬杀自动发出。
      forceKillScope: 'shared_transport',
      // A5：活动计数为 1 时 close() 只回收本 run 的 client，自动升级可以发出。
      exclusiveKillAvailable: () =>
        activeClient !== undefined && (clientActiveRuns.get(activeClient) ?? 0) <= 1,
      getExternalSessionId: () => state.externalSessionId,
      getProviderTurnId: () => state.turnId,
      getInputReceipt: () => history.snapshot()
    }
  }
}
