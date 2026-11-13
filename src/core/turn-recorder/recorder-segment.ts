import type { ProviderId } from '../../shared/provider.js'
import type { TraceEvent } from '../../shared/trace.js'
import { unavailable, type TurnEvidence, type TurnRole } from '../../shared/turn-record.js'
import { readJson, writeJsonAtomic } from './io.js'
import {
  recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath,
  type RecorderOpenTurnState as OpenTurnState, type RecorderSealedSegment, type RecorderSessionState as SessionState
} from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import {
  BACKGROUND_WAKE_PROVIDERS, providerTurnIdOf, stringAt, terminalStatus, timestampOf, transcriptPathOf,
  type RecorderHookInput, type RecorderHookResult, type TranscriptRead
} from './recorder-contracts.js'
import { beginOpenTurn, degradeEvidenceSections, storeLifecycleEvent } from './recorder-turn-state.js'
import { degradeUnmatchedIdentity, emptyTranscript, retainedWindowTranscript } from './recorder-transcript-background.js'
import { snapshotSessionNetDiff } from './git.js'
import { terminalSnapshot } from './git-capture.js'

/**
 * Why a Stop was held instead of sealed. A held Stop is not published: it waits for the segment to
 * go quiet, because a Provider that keeps writing into the same turn would otherwise fragment a
 * single burst of Agent work into several records.
 */
export type SealHoldReason = 'stale_terminal' | 'pending_background_tasks'

export const CONTINUATION_ROLE_SOURCE = 'recorder_background_wake'
export const CONTINUATION_USER_REASON =
  'this segment was continued by a background task notification, so it has no user prompt'
export const CONTINUATION_DIFF_REASON =
  'a continuation segment has no Git baseline of its own; the turn it continues owns the attribution'

/** Turn role for a segment opened by a background notification instead of a user prompt. */
export function continuationRole(open: OpenTurnState): TurnRole | undefined {
  if (!open.continuation) return undefined
  return { role: 'continuation', source: CONTINUATION_ROLE_SOURCE, parentId: open.continuation.rootRecordId }
}

/**
 * Hold an end event instead of publishing it. The boundary is frozen here — the Provider terminal is
 * the end of that segment's Agent work even while the record waits — so a later seal cannot stretch
 * it. The baseline stays live: only a real user prompt consumes it.
 */
export async function holdSeal(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  root: string,
  open: OpenTurnState,
  input: RecorderHookInput,
  reason: SealHoldReason,
  terminalAt: string
): Promise<RecorderHookResult> {
  const eventId = await storeLifecycleEvent(enablement, open, input.event, input.payload)
  open.status = 'closing'
  open.closingAt = terminalAt
  open.terminalAt = terminalAt
  open.terminalAtSource = 'recorder_observed_terminal'
  open.endReason ??= 'provider_terminal'
  // Freeze at the Provider boundary without consuming the baseline: a newer prompt can still
  // cancel this hold. Runtime promise queues stay on the temporary view, never in the JSON state.
  open.terminalDiffs = await Promise.all(open.captures.map(async ({ repository, capture }) => {
    const started = Date.now()
    try {
      const snapshot = await snapshotSessionNetDiff({ ...capture, opChain: undefined, finishPromise: undefined }, undefined, {
        patchExcludeBasenames: enablement.config.capture.patchExcludeBasenames,
        completePatches: true
      })
      return { repository, snapshot }
    } catch {
      // A failed boundary capture cannot be replaced by a later worktree view.
      return {
        repository,
        snapshot: terminalSnapshot(capture, 'unavailable', 'git_error', [], terminalAt, Date.now() - started, 'failed')
      }
    }
  }))
  open.terminalFallbackStatus ??= terminalStatus(input.payload, 'completed')
  open.deferredTerminalAt = new Date().toISOString()
  open.deferredTerminalEventId = eventId
  open.deferredTerminalReason = reason
  await writeJsonAtomic(openPath(root), open)
  return reason === 'pending_background_tasks'
    ? { status: 'pending', reason: 'background tasks launched by this turn have not reported; sealing after the silence window' }
    : { status: 'pending', reason: 'unidentified early terminal deferred for stale-event protection' }
}

/**
 * Activity inside a held segment keeps it open. The silence window measures quiet rather than the
 * first Stop, otherwise the hold would expire while the Provider is still writing to the turn.
 */
export async function refreshSealWindow(root: string, open: OpenTurnState): Promise<void> {
  if (!open.deferredTerminalEventId) return
  open.deferredTerminalAt = new Date().toISOString()
  await writeJsonAtomic(openPath(root), open, { sync: false })
}

/** Whether this Provider can continue one turn after its Stop when a background task reports. */
export function holdsStopForBackgroundWork(provider: ProviderId): boolean {
  return BACKGROUND_WAKE_PROVIDERS.has(provider)
}

/**
 * Open the segment a background notification continued. The wake is Agent work that happened after
 * the previous segment was sealed, so it gets a real record of its own, but it has no user prompt:
 * it carries the notification's own request identity and links back to the turn that asked.
 *
 * Content comes from the turn it continues, sliced past what that turn already published, so a
 * segment never republishes its predecessor's rows.
 */
export async function beginContinuationTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionId: string,
  event: string,
  payload: Record<string, unknown>
): Promise<OpenTurnState | undefined> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const session = await readJson<SessionState>(statePath(root))
  const previous = session?.lastSegment
  // Without a measured predecessor there is nothing to link to and no boundary to slice at.
  if (!previous) return undefined
  const transcriptPath = transcriptPathOf(payload) ?? previous.transcriptPath
  const requestSetId = stringAt(payload, 'request_set_id', 'requestSetId')
  const providerTurnId = providerTurnIdOf(payload, provider)
  const open = await beginOpenTurn(
    enablement, provider, sessionId, event, payload,
    false, false, undefined, undefined,
    { startedAt: timestampOf(payload), ...(providerTurnId ? { providerTurnId } : {}) },
    {
      rootRecordId: previous.rootRecordId,
      sealedRecordId: previous.recordId,
      ...(previous.publishedEvents != null ? { publishedEvents: previous.publishedEvents } : {}),
      ...(previous.providerTurnId ? { providerTurnId: previous.providerTurnId } : {}),
      ...(requestSetId ? { requestSetId } : {})
    }
  )
  // A wake payload may omit the path; the continued turn's own transcript is the same file.
  if (transcriptPath && open.transcriptPath !== transcriptPath) {
    open.transcriptPath = transcriptPath
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  await storeLifecycleEvent(enablement, open, event, payload)
  return open
}

/**
 * How a segment reads the transcript. A continuation sits inside the turn it continues, so it uses
 * that turn's native identity: its own request set never names a transcript turn, because the
 * notification row is folded into the continued turn. Publishing the continued turn's rows again
 * would count the same tool calls twice, so content is sliced past the sealed boundary.
 */
export function segmentTranscriptView(open: OpenTurnState, transcript: TranscriptRead): {
  transcript: TranscriptRead
  ownsRows: boolean
  providerTurnId?: string
  requestSetId?: string
} {
  if (!open.continuation) {
    return {
      transcript,
      ownsRows: true,
      ...(open.providerTurnId ? { providerTurnId: open.providerTurnId } : {}),
      ...(open.requestSetId ? { requestSetId: open.requestSetId } : {})
    }
  }
  const published = open.continuation.publishedEvents
  const measurable = published != null && transcript.identityMatched !== false
  return {
    // Only rows the transcript supplied can be sliced by count: derived events (credits, sidecars)
    // are appended at the end of a growing list, so their position is not a boundary. They belong to
    // the segment that first saw them.
    transcript: measurable
      ? { ...transcript, events: transcriptSourceEvents(transcript.events).slice(published) }
      : { ...transcript, complete: false },
    ownsRows: measurable,
    ...(open.continuation.providerTurnId ? { providerTurnId: open.continuation.providerTurnId } : {})
  }
}

/** Label a continuation segment: no user prompt, no Git baseline, and content only after the seal. */
export function applyContinuationEvidence(
  evidence: TurnEvidence,
  open: OpenTurnState,
  ownsRows: boolean,
  captureDiff: boolean
): void {
  if (!open.continuation) return
  evidence.user = unavailable(CONTINUATION_USER_REASON)
  if (captureDiff && evidence.diff.status !== 'disabled') evidence.diff = unavailable(CONTINUATION_DIFF_REASON)
  if (!ownsRows) {
    degradeEvidenceSections(
      evidence,
      'the sealed segment could not measure its transcript boundary, so this segment may repeat content it already published'
    )
  }
}

/** The sealed boundary the next wake continues from, or undefined when it could not be measured. */
export function sealedSegment(
  open: OpenTurnState,
  recordId: string,
  completedAt: string,
  providerTurnId: string | undefined,
  publishedEvents: number | undefined
): RecorderSealedSegment {
  return {
    recordId,
    rootRecordId: open.continuation?.rootRecordId ?? recordId,
    at: completedAt,
    ...(providerTurnId ? { providerTurnId } : {}),
    ...(open.transcriptPath ? { transcriptPath: open.transcriptPath } : {}),
    ...(publishedEvents != null ? { publishedEvents } : {})
  }
}

/**
 * A forced close whose identity never matched still holds body rows. Keep the window this turn
 * actually wrote — bounded by its own start row and the next user prompt — instead of publishing
 * hook-only evidence. No window is invented when the transcript cannot prove one.
 */
export async function forcedIdentityWindow(
  open: OpenTurnState,
  runId: string,
  cwd: string
): Promise<{ transcript: TranscriptRead; retained: boolean }> {
  const retained = open.continuation
    ? undefined
    : await retainedWindowTranscript(open, runId, cwd).catch(() => undefined)
  return { transcript: retained ?? emptyTranscript(false), retained: !!retained }
}

/**
 * A forced or unmatched close keeps the body it has but cannot claim completeness. The diff is the
 * exception: spanning a window nobody bounded would attribute other turns' work to this one, so it
 * is reported as unavailable with the reason instead of published.
 */
export function applyForcedEvidence(
  evidence: TurnEvidence,
  forcedReason: string | undefined,
  identityUnmatched: boolean,
  unmatchedReason: string | undefined,
  retainedWindow: boolean,
  diffCapturesReady: boolean
): void {
  if (forcedReason) {
    degradeEvidenceSections(
      evidence,
      identityUnmatched
        ? `${forcedReason}; the transcript no longer contains this turn, so only lifecycle-hook evidence remains`
        : forcedReason
    )
    evidence.diff = unavailable(`${forcedReason}; the turn diff baseline spans that window and cannot be attributed to this turn`)
  }
  if (!identityUnmatched) return
  degradeUnmatchedIdentity(evidence, unmatchedReason!, retainedWindow)
  if (diffCapturesReady) {
    evidence.diff = unavailable(`${unmatchedReason!}; the Git baseline may include work after the unmatched turn boundary`)
  }
}

/**
 * The transcript rows a segment can be sliced by. Ids the parser assigned (`transcript-…`) identify
 * rows; everything else is a projection the recorder derived from them, whose position moves as the
 * file grows.
 */
export function transcriptSourceEvents(events: TraceEvent[]): TraceEvent[] {
  return events.filter((event) => event.id.startsWith('transcript-'))
}
