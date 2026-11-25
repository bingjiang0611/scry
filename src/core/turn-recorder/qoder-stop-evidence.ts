import { join } from 'node:path'
import type { RecorderEnablement } from './config.js'
import { appendRotatingLog } from './io.js'
import { stableTranscript } from './recorder-transcript-cache.js'
import type { TranscriptRead } from './recorder-contracts.js'
import type { RecorderOpenTurnState } from './runtime-state.js'
import { transcriptIdentityEligible, transcriptIdentityContradictory, transcriptProviderTurnId, transcriptRequestSetId } from '../../main/normalize-transcript-identity.js'

/** `tool_use` and unknown reasons are not evidence of completion. */
export const FINISHED_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'complete', 'completed', 'stop'])

/** Native proof, never prompt text or the time a hook happened to reach us. */
export function qoderStopEvidence(read: TranscriptRead, open: RecorderOpenTurnState): {
  first: boolean; completedAt?: string
} {
  if (open.provider !== 'qoder' || open.continuation || !read.stable || !read.complete || !read.source || read.identityMatched !== true ||
    !read.providerTurnId || (!open.providerTurnId && !open.requestSetId) || !read.source.content.endsWith('\n')) return { first: false }
  let first = false
  let userCount = 0
  let selected = false
  let selectedCount = 0
  let chain: string | undefined
  let lastAssistantParent: string | undefined
  let completedAt: string | undefined
  for (const line of read.source.content.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try { row = JSON.parse(line) } catch { return { first: false } }
    if (!row || typeof row !== 'object' || !transcriptIdentityEligible(row, true)) continue
    if ((row.sessionId != null && row.sessionId !== open.sessionId) || transcriptIdentityContradictory(row)) return { first: false }
    const id = transcriptProviderTurnId(row)
    const request = transcriptRequestSetId(row)
    const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : undefined
    const nativeMatch = id === read.providerTurnId && (!open.requestSetId || !request || request === open.requestSetId)
    const linked = chain !== undefined && row.parentUuid === chain && (!id || nativeMatch) &&
      (!open.requestSetId || !request || request === open.requestSetId)
    if (row.type === 'user') {
      const msg = row.message as { content?: unknown } | undefined
      const text = typeof msg?.content === 'string' ? msg.content : undefined
      const origin = row.origin as { kind?: string } | undefined
      if (origin?.kind === 'task-notification' || text?.trimStart().startsWith('<task-notification>')) {
        completedAt = undefined
        if (linked) chain = uuid
        continue
      }
      const toolResult = Array.isArray(msg?.content) && msg.content.some(item => item?.type === 'tool_result')
      if (toolResult) {
        completedAt = undefined
        chain = selected && linked ? uuid : undefined
        continue
      }
      // A Qoder command-wrapper meta row can supply the native id to its preceding turn.
      if (row.isMeta === true) {
        if (nativeMatch && linked) chain = uuid
        continue
      }
      userCount++
      selected = nativeMatch
      if (selected) selectedCount++
      first = open.generation === 1 && userCount === 1 && selected && read.source.startOffset === 0 && row.parentUuid === null &&
        !!uuid && row.sessionId === open.sessionId
      chain = selected ? uuid : undefined
      lastAssistantParent = undefined
      completedAt = undefined
    } else if (row.type === 'assistant') {
      completedAt = undefined
      // Streaming updates can repeat the same assistant UUID with its original parent.
      const update = !!uuid && uuid === chain && row.parentUuid === lastAssistantParent && !id && !request
      if (!selected || row.isMeta === true || (!nativeMatch && !linked && !update)) { chain = undefined; continue }
      chain = uuid
      lastAssistantParent = typeof row.parentUuid === 'string' ? row.parentUuid : undefined
      const stop = (row.message as { stop_reason?: string } | undefined)?.stop_reason
      const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
      const start = Date.parse(read.startedAt ?? open.startedAt)
      if (stop && FINISHED_STOP_REASONS.has(stop) && at >= start && at <= Date.now()) completedAt = new Date(at).toISOString()
    }
  }
  // More than one occurrence is ambiguous, even if the normal display parser picks one.
  return selectedCount === 1 && selected ? { first, ...(completedAt ? { completedAt } : {}) } : { first: false }
}

export function readQoderStopTranscript(enablement: Extract<RecorderEnablement, {enabled: true}>, open: RecorderOpenTurnState) {
  if (open.provider !== 'qoder' || !open.transcriptPath) return undefined
  return stableTranscript(open.transcriptPath, `qoder:${open.sessionId}:${open.generation}`, 'qoder',
    open.promptHash, open.providerTurnId, 0, open.requestSetId, open.sessionId, enablement.workspaceRoot,
    undefined, open.captureTranscriptEndOffset, enablement.dataRoot)
}

export async function logQoderStopHold(
  dataRoot: string, open: RecorderOpenTurnState,
  outcome: 'deferred' | 'transcript_evidence' | 'identified_stop' | 'activity' | 'session_end' | 'superseded' | 'first_turn_poll' | 'grace_elapsed' | 'background_detected'
): Promise<void> {
  const reason = open.deferredTerminalReason
  if (open.provider !== 'qoder' || (reason !== 'stale_terminal' && reason !== 'pending_background_tasks') || !open.deferredTerminalAt) return
  const now = Date.now()
  const start = Date.parse(open.deferredTerminalFirstAt ?? open.deferredTerminalAt)
  const waitedMs = Number.isFinite(start) ? Math.max(0, now - start) : 0
  await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
    `${new Date(now).toISOString()} INFO qoder_stop_hold reason=${reason} outcome=${outcome} waitedMs=${waitedMs}`
  ).catch(() => undefined)
}
