import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { billingProviderForUpstream } from '../../shared/billing'
import { classifyRunTermination } from '../../shared/runtime'
import { sanitizeOpenCodeServerLog } from './opencode-server'
import { aggregateOpenCodeTurn, emitOpenCodeTurnResponseParts } from './opencode-turn-evidence'
import { errorText } from './opencode-errors'
import { unwrap } from './opencode-errors'
import {
  eventState,
  newEvent,
  openCodeMessageId,
  openCodeMessageParentId,
  openCodeMessageRole,
  openCodeUserText,
  record,
  rememberOpenCodeMessage
} from './opencode-records'
import type { ProviderRunRequest } from './types'
import type { HistoricalInput } from './historical-input'

export interface OpenCodeTurnInput {
  request: ProviderRunRequest
  client: OpencodeClient
  externalSessionId: string
  response: { info: Record<string, unknown>; parts: unknown[] }
  /** Resolved model context windows; unavailable windows stay unknown. */
  modelContext: Promise<Map<string, number>>
  outgoingText: string
  history: HistoricalInput
  /** Event-stream observation failure, if any; reported as partial observation. */
  observationError: unknown
  /** Publishes turn identity before this call settles so a failure keeps it. */
  publish: (state: { providerTurnId?: string; recordingFailure?: { message: string } }) => void
}

/**
 * Publishes one completed turn from the canonical response plus the full
 * message snapshot. A successful HTTP reply alone never proves the input was
 * persisted, so acceptance needs the parent user message with the exact text.
 */
export async function publishOpenCodeTurn(input: OpenCodeTurnInput): Promise<{
  providerTurnId?: string
  stopped: boolean
  status: 'completed' | 'failed' | 'interrupted'
  recordingFailure?: { message: string }
}> {
  const { request, client, externalSessionId, response, outgoingText, history } = input
  let observationError = input.observationError
  const modelContextPromise = input.modelContext
  let providerTurnId: string | undefined
  let recordingFailure: { message: string } | undefined
    const info = record(response.info)
    providerTurnId = openCodeMessageParentId(info)
    let messageSnapshotStatus: 'complete' | 'bounded' | 'failed' | 'unavailable' = 'unavailable'
    let messageSnapshotRows: Array<{ info?: unknown; parts?: unknown }> | undefined
    if (typeof client.session.messages === 'function') {
      try {
        const rows = await unwrap<Array<{ info?: unknown; parts?: unknown }>>(client.session.messages({
          sessionID: externalSessionId,
          directory: request.cwd,
          limit: 1_000
        }), 'session.messages')
        messageSnapshotRows = rows
        messageSnapshotStatus = rows.length === 1_000 ? 'bounded' : 'complete'
        const state = eventState(request)
        if (messageSnapshotStatus === 'complete') {
          const snapshotMessageIds = new Set(rows.map((row) => openCodeMessageId(record(row.info))).filter(Boolean))
          for (const messageId of state.streamedTextByMessageId.keys()) {
            if (snapshotMessageIds.has(messageId)) continue
            request.emit(newEvent(request.runId, {
              kind: 'model',
              stage: 'text',
              text: '',
              messageId,
              runtimeMetadata: { source: 'opencode_message_snapshot', replacesStreamedText: true }
            }))
            state.streamedTextByMessageId.delete(messageId)
            state.clearedTextMessageIds.delete(messageId)
          }
          state.messages.clear()
        }
        for (const row of rows) rememberOpenCodeMessage(state, record(row.info))
      } catch (error) {
        messageSnapshotStatus = 'failed'
        observationError ??= error
      }
    }
    const parentId = openCodeMessageParentId(info)
    const parentUserRow = parentId
      ? messageSnapshotRows?.find((row) => {
          const candidate = record(row.info)
          return openCodeMessageId(candidate) === parentId && openCodeMessageRole(candidate) === 'user'
        })
      : undefined
    const snapshotHasParentUser = parentUserRow !== undefined
    // The parent user message is bound to the session by this exact id and to this
    // submission by its exact text. A bounded page that still contains that row
    // proves the input; the page limit only bounds which other rows are proven.
    const persistedText = parentUserRow ? openCodeUserText(parentUserRow.parts) : undefined
    const snapshotProvesParentUser = parentId !== undefined && persistedText === outgoingText
    if (history.snapshot()?.status === 'unknown') {
      // The prompt response names the canonical assistant message; only a matching
      // persisted user message with the exact outgoing text proves our input.
      if ((messageSnapshotStatus === 'complete' || messageSnapshotStatus === 'bounded') && snapshotProvesParentUser) {
        history.accepted(externalSessionId, 'opencode_prompt_user_message', parentId)
      } else {
        history.unverified(messageSnapshotStatus === 'complete'
          ? 'OpenCode 权威消息快照中未找到与本次投递一致的 user 消息'
          : messageSnapshotStatus === 'bounded'
            ? 'OpenCode 有界权威消息页未包含与本次投递一致的 user 消息'
            : `OpenCode 权威消息快照不完整：${messageSnapshotStatus}`)
      }
    }
    if (request.managedRecorder) {
      if (messageSnapshotStatus !== 'complete') {
        recordingFailure = { message: `OpenCode managed recorder 无法取得完整权威消息快照：${messageSnapshotStatus}` }
      } else if (!parentId) {
        recordingFailure = { message: 'OpenCode managed recorder 缺少权威 user message id' }
      } else if (!snapshotHasParentUser) {
        recordingFailure = { message: 'OpenCode managed recorder 权威消息快照缺少父 user message' }
      }
    }
    const aggregate = aggregateOpenCodeTurn(info, eventState(request).messages, await modelContextPromise)
    providerTurnId = request.managedRecorder ? parentId : aggregate.providerTurnId
    emitOpenCodeTurnResponseParts(
      request,
      messageSnapshotStatus === 'complete' ? messageSnapshotRows : undefined,
      info,
      Array.isArray(response.parts) ? response.parts : []
    )
    const aggregateUnavailable =
      messageSnapshotStatus === 'bounded' || messageSnapshotStatus === 'failed' || recordingFailure !== undefined
    const timing = aggregateUnavailable ? undefined : aggregate.timing
    const upstream = String(info.providerID ?? '')
    const sourceProvider = billingProviderForUpstream(upstream)
    const cost = aggregateUnavailable ? undefined : aggregate.costUsd
    const providerStopReason = typeof info.finish === 'string' && info.finish.trim() ? info.finish.trim() : undefined
    const nativeInterrupted = /^(?:abort|cancelled?|interrupted)$/.test((providerStopReason ?? '').toLowerCase())
    const nativeStatus = nativeInterrupted ? 'interrupted' : info.error ? 'failed' : 'completed'
    const terminationReason = classifyRunTermination({
      rawReason: providerStopReason,
      message: info.error ? errorText(info.error) : undefined
    })
    request.emit(newEvent(request.runId, {
      kind: 'harness',
      stage: 'result',
      messageId: providerTurnId,
      durationMs: timing?.durationMs,
      tokensIn: aggregateUnavailable ? undefined : aggregate.tokensIn,
      tokensOut: aggregateUnavailable ? undefined : aggregate.tokensOut,
      reasoningTokens: aggregateUnavailable ? undefined : aggregate.reasoningTokens,
      cacheReadTokens: aggregateUnavailable ? undefined : aggregate.cacheReadTokens,
      cacheCreationTokens: aggregateUnavailable ? undefined : aggregate.cacheCreationTokens,
      contextTokens: aggregateUnavailable ? undefined : aggregate.contextTokens,
      contextModel: aggregateUnavailable ? undefined : aggregate.contextModel,
      contextProvider: aggregateUnavailable ? undefined : aggregate.contextProvider,
      contextUsageSource: aggregateUnavailable ? undefined : aggregate.contextUsageSource,
      contextUsageQuality: aggregateUnavailable ? undefined : aggregate.contextUsageQuality,
      costUsd: cost,
      costSource: cost === undefined ? undefined : 'provider_reported',
      costConfidence: cost === undefined ? undefined : 'provider_reported',
      costUnit: cost === undefined ? undefined : 'usd',
      billingProvider: sourceProvider,
      upstreamProvider: upstream || undefined,
      usageSource: aggregateUnavailable ? undefined : 'opencode_turn_messages',
      modelUsage: aggregateUnavailable ? undefined : aggregate.modelUsage,
      isError: !!info.error,
      ...(terminationReason ? { terminationReason } : {}),
      ...(providerStopReason ? { providerStopReason } : {}),
      runtimeMetadata: {
        modelProvider: upstream,
        source: 'opencode_server',
        finish: info.finish,
        aggregatedAssistantMessages: aggregate.messageCount,
        messageCoverage: recordingFailure
          ? 'incomplete_snapshot'
          : messageSnapshotStatus === 'bounded'
            ? 'bounded_snapshot'
            : messageSnapshotStatus === 'failed'
              ? 'failed_snapshot'
              : aggregate.messageCoverage,
        timingBoundary: aggregateUnavailable ? 'unavailable' : aggregate.timingBoundary,
        messageSnapshotStatus,
        observationStatus: observationError == null ? 'complete' : 'partial',
        ...(observationError == null ? {} : {
          observationError: sanitizeOpenCodeServerLog(errorText(observationError)).slice(0, 500)
        })
      }
    }, timing?.ts))
    input.publish({ providerTurnId, recordingFailure })
    if (info.error && !nativeInterrupted) throw new Error(`OpenCode Provider 失败：${errorText(info.error)}`)
    return {
      providerTurnId,
      stopped: nativeInterrupted,
      status: nativeStatus,
      recordingFailure
    }
}
