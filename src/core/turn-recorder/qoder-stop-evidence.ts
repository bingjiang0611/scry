import { join } from 'node:path'
import type { RecorderEnablement } from './config.js'
import { appendRotatingLog } from './io.js'
import { stableTranscript } from './recorder-transcript-cache.js'
import { nestedRecord, subagentScopedPayload, type RecorderHookInput, type TranscriptRead } from './recorder-contracts.js'
import type { RecorderOpenTurnState, RecorderSessionState } from './runtime-state.js'

export type QoderStopAttribution = 'matched' | 'stale' | 'unproven'
const REQUEST_HISTORY = 32
export const QODER_STOP_TRANSCRIPT_WAIT_MS = 10_000
const COMPLETE_REPLY_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'complete', 'completed', 'stop'])

export function qoderTranscriptReplyComplete(read: TranscriptRead): boolean {
  return read.stable && !!read.stopReason && COMPLETE_REPLY_REASONS.has(read.stopReason)
}

function requestId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 && value.trim() ? value : undefined
}

function recentRequests(state: RecorderSessionState | null, generation: number) {
  return (state?.recentQoderRequests ?? []).slice(-REQUEST_HISTORY)
    .filter(entry => entry.generation >= generation - REQUEST_HISTORY && entry.generation < generation)
}

export function rememberQoderRequest(state: RecorderSessionState, open: RecorderOpenTurnState) {
  if (open.provider !== 'qoder' || open.continuation) return state
  const recent = recentRequests(state, open.generation)
  const id = requestId(open.requestSetId)
  return { ...state, recentQoderRequests: id ? [...recent, { generation: open.generation, id }].slice(-REQUEST_HISTORY) : recent }
}

export function isTopLevelQoderStop(input: RecorderHookInput): boolean {
  if (input.provider !== 'qoder' || input.event !== 'Stop' || subagentScopedPayload(input.payload)) return false
  const raw = nestedRecord(input.payload, 'raw_qoder_payload')
  return [input.payload, raw].every(p => !p || (
    !subagentScopedPayload(p) && (p.hook_event_name === undefined || p.hook_event_name === 'Stop')
  ))
}

export function qoderRequestStopAttribution(
  payload: Record<string, unknown>, open: RecorderOpenTurnState, state: RecorderSessionState | null
): QoderStopAttribution {
  const raw = nestedRecord(payload, 'raw_qoder_payload')
  const incoming = requestId(raw ? raw.parent_request_set_id : payload.parent_request_set_id)
  const session = raw ? raw.session_id : payload.session_id
  const current = requestId(open.requestSetId)
  if (!incoming || !current || open.continuation || session !== open.sessionId ||
    (raw && ((payload.parent_request_set_id !== undefined && payload.parent_request_set_id !== incoming) ||
      (payload.session_id !== undefined && payload.session_id !== session)))) return 'unproven'
  const older = recentRequests(state, open.generation).some(entry => entry.id === incoming)
  if (incoming === current) return older ? 'unproven' : 'matched'
  return older ? 'stale' : 'unproven'
}

export function readQoderStopTranscript(enablement: Extract<RecorderEnablement, { enabled: true }>, open: RecorderOpenTurnState) {
  if (open.provider !== 'qoder' || !open.transcriptPath) return undefined
  return stableTranscript(open.transcriptPath, `qoder:${open.sessionId}:${open.generation}`, 'qoder',
    open.promptHash, open.providerTurnId, open.transcriptStartOffset, open.requestSetId, open.sessionId, enablement.workspaceRoot,
    undefined, open.captureTranscriptEndOffset, enablement.dataRoot)
}

export function qoderNativeStopAttribution(
  open: RecorderOpenTurnState, id: string, read?: TranscriptRead
): QoderStopAttribution {
  if (open.providerTurnId) return open.providerTurnId === id ? 'matched' : 'stale'
  if (!open.requestSetId) return 'unproven'
  if (!read?.stable || !read.complete || read.identityMatched !== true || !read.providerTurnId) return 'unproven'
  return read.providerTurnId === id ? 'matched' : 'stale'
}

export async function logQoderStopAttribution(dataRoot: string, attribution: QoderStopAttribution): Promise<void> {
  await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} INFO qoder_stop_attribution attribution=${attribution}`
  ).catch(() => undefined)
}

export async function logQoderStopHold(
  dataRoot: string, open: RecorderOpenTurnState,
  outcome: 'deferred' | 'identified_stop' | 'activity' | 'session_end' | 'superseded' | 'grace_elapsed' | 'native_id_matched' | 'native_id_mismatch' | 'native_id_expired',
  attribution: QoderStopAttribution | undefined = open.deferredQoderStopAttribution
): Promise<void> {
  const reason = open.deferredTerminalReason
  if (open.provider !== 'qoder' || !reason || !open.deferredTerminalAt) return
  const now = Date.now()
  const start = Date.parse(open.deferredTerminalFirstAt ?? open.deferredTerminalAt)
  const waitedMs = Number.isFinite(start) ? Math.max(0, now - start) : 0
  await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
    `${new Date(now).toISOString()} INFO qoder_stop_hold reason=${reason} outcome=${outcome} attribution=${attribution ?? 'unproven'} waitedMs=${waitedMs}`
  ).catch(() => undefined)
}
