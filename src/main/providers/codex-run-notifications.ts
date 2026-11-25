import { classifyRunTermination } from '../../shared/runtime'
import type { ProviderRunRequest } from './types'
import type { CodexNotificationEnvelope } from './codex-app-server'
import {
  CODEX_TOOL_ITEM_TYPES,
  addUsage,
  canonicalTurnStatus,
  epochMilliseconds,
  hasPositiveUsage,
  subtractUsage,
  tokenUsage,
  type ThreadTokenUsage,
  type TokenUsage
} from './codex-protocol'
import {
  hookEventName,
  newEvent,
  newEventAt,
  record,
  traceFromHook,
  traceFromItem,
  usageNumber,
  type ItemTraceContext
} from './codex-trace'

export interface NativeResponseTiming {
  firstTokenMs?: number
  lastOutputMs?: number
  completedMs?: number
}

/** Timing bookkeeping for one native thread; the run loop starts and finishes these entries. */
export interface ResponseTimingState {
  boundaryMs?: number
  responses: Map<string, NativeResponseTiming>
  responseSource?: 'raw_response' | 'agent_message_item'
}

/**
 * Per-turn state the notification projection reads and writes. The run loop owns the process and
 * thread lifecycle; this object is the only shared mutable state between them.
 */
export interface CodexTurnState {
  externalSessionId: string | undefined
  turnId: string | undefined
  llmCallPendingToolHooks: number
  lastRequestUsage: TokenUsage | undefined
  turnCompleted: boolean
  lastTurnError: Record<string, unknown> | undefined
  modelContextWindow: number | undefined
  childAgents: Map<string, { parentToolUseId?: string; name?: string }>
  seenSubAgentActivities: Set<string>
  planUpdateSeq: number
  turnStartRequested: boolean
  lastSeenCumulativeUsage: TokenUsage | undefined
  turnUsage: TokenUsage | undefined
  llmCallStartMs: number | undefined
  llmCallFirstTokenMs: number | undefined
  llmCallLastOutputMs: number | undefined
  model: string | undefined
  modelProvider: string | undefined
  serviceTier: string | null | undefined
  authMode: string | undefined
  accountPlan: string | undefined
  stopped: boolean
}

export interface CodexNotificationDeps {
  state: CodexTurnState
  runRequest: ProviderRunRequest
  timingByThread: Map<string, ResponseTimingState>
  finish: (result: import('./types').ProviderRunResult) => void
  advanceLlmCallStart: (atMs: number) => void
  observeLlmOutput: (atMs: number, firstToken: boolean) => void
  resetLlmCall: (startMs: number) => void
  notificationAt: (envelope?: CodexNotificationEnvelope) => number
  timingState: (threadId: string, fallbackBoundaryMs?: number) => ResponseTimingState
  advanceTimingBoundary: (threadId: string | undefined, atMs: number) => void
  emitObservedResponse: (
    threadId: string,
    responseId: string,
    observedAtMs: number,
    context: ItemTraceContext,
    source: 'raw_response' | 'agent_message_item'
  ) => void
}

export function createCodexNotificationHandler(deps: CodexNotificationDeps) {
  const { state, runRequest } = deps
  return (method: string, value: unknown, envelope?: CodexNotificationEnvelope): void => {
      const params = record(value)
      
      
      if (!state.externalSessionId) return
      const notificationThreadId = typeof params.threadId === 'string' ? params.threadId : undefined
      const child = notificationThreadId ? state.childAgents.get(notificationThreadId) : undefined
      const isRoot = notificationThreadId === state.externalSessionId
      if (!isRoot && !child) return
      if (isRoot && state.turnId && params.turnId && params.turnId !== state.turnId) return
      
      runRequest.recordNative?.(method, value)
      const traceContext: ItemTraceContext = !isRoot && child
        ? { agentId: notificationThreadId, parentToolUseId: child.parentToolUseId }
        : {}
      const observedAtMs = deps.notificationAt(envelope)
      if (method === 'turn/started') {
        const turn = record(params.turn)
        if (notificationThreadId) {
          const state = deps.timingState(notificationThreadId)
          if (state.responses.size === 0) {
            state.boundaryMs = epochMilliseconds(turn.startedAt) ?? observedAtMs
          }
        }
        
        if (isRoot) deps.resetLlmCall(observedAtMs)
      } else if (method === 'item/agentMessage/delta') {
        if (isRoot) deps.observeLlmOutput(observedAtMs, true)
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
        if (isRoot) deps.observeLlmOutput(observedAtMs, true)
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
        deps.emitObservedResponse(notificationThreadId, responseId, observedAtMs, traceContext, 'raw_response')
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = record(params.item)
        if (isRoot) {
          const type = String(item.type ?? '')
          if (['reasoning', 'agentMessage', 'webSearch'].includes(type)) {
            deps.observeLlmOutput(observedAtMs, method === 'item/started')
          } else if (method === 'item/started' && CODEX_TOOL_ITEM_TYPES.includes(type)) {
            
            if (state.llmCallPendingToolHooks > 0) state.llmCallPendingToolHooks -= 1
            else deps.observeLlmOutput(observedAtMs, false)
          }
        }
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
          const receiverThreadIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : []
          for (const receiverThreadId of receiverThreadIds) {
            state.childAgents.set(receiverThreadId, {
              parentToolUseId: typeof item.id === 'string' ? item.id : undefined,
              name: typeof item.model === 'string' ? item.model : undefined
            })
            deps.timingState(receiverThreadId, observedAtMs)
          }
        } else if (
          item.type === 'subAgentActivity' &&
          item.kind === 'started' &&
          typeof item.agentThreadId === 'string' &&
          item.agentThreadId !== state.externalSessionId
        ) {
          const existing = state.childAgents.get(item.agentThreadId)
          state.childAgents.set(item.agentThreadId, {
            parentToolUseId: existing?.parentToolUseId ?? (typeof item.id === 'string' ? item.id : undefined),
            name: typeof item.agentPath === 'string' ? item.agentPath : existing?.name
          })
        }
        
        
        const subAgentActivityId = item.type === 'subAgentActivity' && typeof item.id === 'string'
          ? item.id
          : undefined
        const duplicateSubAgentActivity = subAgentActivityId != null && state.seenSubAgentActivities.has(subAgentActivityId)
        if (!duplicateSubAgentActivity) {
          if (subAgentActivityId) state.seenSubAgentActivities.add(subAgentActivityId)
          for (const event of traceFromItem(
            runRequest.runId,
            item,
            method === 'item/completed',
            traceContext
          )) runRequest.emit(event)
        }
        if (method === 'item/completed') {
          const type = String(item.type ?? '')
          if (type === 'agentMessage' && notificationThreadId && typeof item.id === 'string') {
            deps.emitObservedResponse(
              notificationThreadId,
              item.id,
              observedAtMs,
              traceContext,
              'agent_message_item'
            )
          } else if (CODEX_TOOL_ITEM_TYPES.includes(type)) {
            const completedAtMs =
              usageNumber(params.completedAtMs) ?? observedAtMs
            deps.advanceTimingBoundary(notificationThreadId, completedAtMs)
            if (isRoot) deps.advanceLlmCallStart(completedAtMs)
          }
        }
      } else if (method === 'turn/plan/updated') {
        const planToolUseId = `plan:${String(params.turnId ?? state.turnId ?? 'turn')}:${(state.planUpdateSeq += 1)}`
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
        const run = record(params.run)
        if (method === 'hook/completed') {
          const completedAtMs = epochMilliseconds(run.completedAt) ?? observedAtMs
          deps.advanceTimingBoundary(notificationThreadId, completedAtMs)
          
          if (isRoot) deps.advanceLlmCallStart(observedAtMs)
        } else if (isRoot && hookEventName(run.eventName) === 'PreToolUse') {
          
          deps.observeLlmOutput(observedAtMs, false)
          state.llmCallPendingToolHooks += 1
        }
      } else if (method === 'thread/tokenUsage/updated') {
        
        if (!isRoot) return
        const usage = record(params.tokenUsage) as unknown as ThreadTokenUsage
        const total = tokenUsage(usage.total)
        
        
        if (!state.turnStartRequested) {
          if (usage.total) state.lastSeenCumulativeUsage = total
          return
        }
        if (state.turnId && typeof params.turnId === 'string' && params.turnId !== state.turnId) return
        const last = tokenUsage(usage.last)
        const delta = usage.total
          ? state.lastSeenCumulativeUsage
            ? subtractUsage(total, state.lastSeenCumulativeUsage)
            : usage.last
              ? last
              : runRequest.resume
                ? undefined
                : total
          : usage.last
            ? last
            : undefined
        if (delta && hasPositiveUsage(delta)) state.turnUsage = addUsage(state.turnUsage, delta)
        
        
        
        const callTokens = delta && hasPositiveUsage(delta) ? delta.outputTokens : undefined
        const callEndMs = state.llmCallLastOutputMs ?? observedAtMs
        if (callTokens != null && callTokens > 0 && state.llmCallStartMs != null && callEndMs > state.llmCallStartMs) {
          runRequest.emit(newEventAt(runRequest.runId, observedAtMs, {
            kind: 'harness',
            stage: 'runtime:llm_call',
            llmCall: {
              outputTokens: callTokens,
              durationMs: callEndMs - state.llmCallStartMs,
              ...(state.llmCallFirstTokenMs != null ? { firstTokenMs: state.llmCallFirstTokenMs - state.llmCallStartMs } : {}),
              ...(state.model ? { model: state.model } : {})
            }
          }))
        }
        
        if (!delta || hasPositiveUsage(delta)) deps.resetLlmCall(observedAtMs)
        if (usage.total) state.lastSeenCumulativeUsage = total
        state.lastRequestUsage = usage.last ? last : undefined
        state.modelContextWindow = usageNumber(usage.modelContextWindow) ?? state.modelContextWindow
      } else if (method === 'turn/completed') {
        
        if (!isRoot) {
          const turn = record(params.turn)
          if (child?.parentToolUseId) {
            const childStatus = canonicalTurnStatus(turn.status, state.stopped)
            runRequest.emit(newEvent(runRequest.runId, {
              kind: 'tool',
              stage: 'tool_result',
              tool: 'Agent',
              toolUseId: child.parentToolUseId,
              name: child.name,
              agentId: notificationThreadId,
              output: JSON.stringify(turn),
              isError: childStatus === 'failed',
              runtimeMetadata: {
                source: 'codex_child_turn',
                agentStatus: childStatus,
                nativeTurnStatus: turn.status
              }
            }))
          }
          return
        }
        state.turnCompleted = true
        const turn = record(params.turn)
        const turnError = record(turn.error)
        const effectiveError = Object.keys(turnError).length > 0 ? turnError : state.lastTurnError
        const errorMessage = typeof effectiveError?.message === 'string' ? effectiveError.message : undefined
        const providerStopReason = [
          turn.stopReason,
          turn.stop_reason,
          turn.finishReason,
          turn.finish_reason,
          effectiveError?.code,
          effectiveError?.type
        ]
          .find((value): value is string => typeof value === 'string' && !!value.trim())
        const terminationReason = classifyRunTermination({
          rawReason: providerStopReason,
          message: effectiveError ? JSON.stringify(effectiveError).slice(0, 4_000) : errorMessage
        })
        const finalUsage = state.turnUsage ?? state.lastRequestUsage
        const billingProvider = state.authMode === 'apiKey' ? 'openai' : state.authMode === 'chatgpt' ? 'codex' : undefined
        const accountLabel = state.authMode === 'apiKey'
          ? 'OpenAI API key'
          : state.authMode === 'chatgpt' && state.accountPlan
            ? `Codex ${state.accountPlan}`
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
          contextTokens: state.lastRequestUsage?.inputTokens,
          contextModel: state.lastRequestUsage?.inputTokens != null && state.modelContextWindow && state.model ? state.model : undefined,
          contextProvider: state.lastRequestUsage?.inputTokens != null && state.modelContextWindow ? state.modelProvider ?? 'openai' : undefined,
          contextUsageSource: state.lastRequestUsage?.inputTokens != null && state.modelContextWindow ? 'codex_app_server_last_usage' : undefined,
          contextUsageQuality: state.lastRequestUsage?.inputTokens != null && state.modelContextWindow ? 'exact' : undefined,
          isError: turn.status === 'failed',
          ...(terminationReason ? { terminationReason } : {}),
          ...(providerStopReason ? { providerStopReason } : {}),
          modelUsage: state.model ? [{
            model: state.model,
            inputTokens: finalUsage?.inputTokens,
            outputTokens: finalUsage?.outputTokens,
            cacheReadTokens: finalUsage?.cachedInputTokens,
            cacheCreationTokens: finalUsage?.cacheWriteInputTokens,
            reasoningTokens: finalUsage?.reasoningOutputTokens,
            contextWindow: state.modelContextWindow,
            billingProvider,
            upstreamProvider: state.modelProvider ?? 'openai',
            accountLabel,
            usageSource: 'codex_app_server'
          }] : undefined,
          billingProvider,
          upstreamProvider: state.modelProvider ?? 'openai',
          accountLabel,
          usageSource: 'codex_app_server',
          runtimeMetadata: {
            modelProvider: state.modelProvider ?? 'openai',
            model: state.model,
            serviceTier: state.serviceTier,
            authMode: state.authMode,
            accountPlan: state.accountPlan,
            turnStatus: turn.status,
            ...(effectiveError ? { turnError: effectiveError } : {})
          }
        }))
        deps.finish({
          externalSessionId: state.externalSessionId,
          providerTurnId: state.turnId,
          stopped: state.stopped,
          status: canonicalTurnStatus(turn.status, state.stopped)
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
          state.lastTurnError = record(params.error)
          
          
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

  }
}
