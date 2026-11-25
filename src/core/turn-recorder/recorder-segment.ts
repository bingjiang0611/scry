import type { ProviderId } from '../../shared/provider.js'
import type { TraceEvent } from '../../shared/trace.js'
import { partial, unavailable, type TurnEvidence, type TurnRole } from '../../shared/turn-record.js'
import { readJson, writeJsonAtomic } from './io.js'
import {
  recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath,
  type RecorderOpenTurnState as OpenTurnState, type RecorderSealedSegment, type RecorderSessionState as SessionState
} from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import {
  BACKGROUND_WAKE_PROVIDERS, explicitTimestampOf, providerTurnIdOf, stringAt, terminalStatus, timestampOf,
  transcriptPathOf,
  type RecorderHookInput, type RecorderHookResult, type TranscriptRead
} from './recorder-contracts.js'
import { beginOpenTurn, degradeEvidenceSections, storeLifecycleEvent } from './recorder-turn-state.js'
import { hostProcessChain } from './host-process.js'
import { degradeUnmatchedIdentity, emptyTranscript, retainedWindowTranscript } from './recorder-transcript-background.js'
import { snapshotSessionNetDiff } from './git.js'
import { segmentFreeze } from './recorder-segment-diff.js'
import { terminalSnapshot } from './git-capture.js'

export type SealHoldReason = 'stale_terminal' | 'pending_background_tasks'

export const CONTINUATION_ROLE_SOURCE = 'recorder_background_wake'
export const CONTINUATION_USER_REASON =
  'this segment was continued by a background task notification, so it has no user prompt'
export const CONTINUATION_NO_BASELINE_REASON =
  'the segment this continues published no end state for this repository, so its changes cannot be separated from this segment'

export function continuationRole(open: OpenTurnState): TurnRole | undefined {
  if (!open.continuation) return undefined
  return { role: 'continuation', source: CONTINUATION_ROLE_SOURCE, parentId: open.continuation.rootRecordId }
}

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
  const frozen = segmentFreeze({ enabled: enablement.config.capture.diff, open, gaveUp: false })
  open.terminalDiffs = await Promise.all(open.captures.map(async ({ repository, capture }) => {
    const started = Date.now()
    try {
      const snapshot = await snapshotSessionNetDiff({ ...capture, opChain: undefined, finishPromise: undefined }, undefined, {
        patchExcludeBasenames: enablement.config.capture.patchExcludeBasenames,
        diffExclude: [...(enablement.config.capture.diffExclude ?? []), ...(open.capture?.diffExclude ?? [])],
        completePatches: true,
        ...(frozen ? { onAfter: frozen.option(repository) } : {})
      })
      return { repository, snapshot }
    } catch {
      return {
        repository,
        snapshot: terminalSnapshot(capture, 'unavailable', 'git_error', [], terminalAt, Date.now() - started, 'failed')
      }
    }
  }))
  if (frozen) {
    const sealed = frozen.list()
    if (sealed.length) open.frozenDiffs = sealed
  }
  open.terminalFallbackStatus ??= terminalStatus(input.payload, 'completed')
  if (reason === 'pending_background_tasks') {
    open.stopObservedAt = terminalAt
    open.stopObservedAtSource = explicitTimestampOf(input.payload) ? 'provider_terminal_event' : 'recorder_observed_terminal'
  }
  open.deferredTerminalAt = new Date().toISOString()
  open.deferredTerminalEventId = eventId
  open.deferredTerminalReason = reason
  await writeJsonAtomic(openPath(root), open)
  return reason === 'pending_background_tasks'
    ? { status: 'pending', reason: 'background tasks launched by this turn have not reported; sealing after the silence window' }
    : { status: 'pending', reason: 'unidentified early terminal deferred for stale-event protection' }
}

export async function refreshSealWindow(root: string, open: OpenTurnState): Promise<void> {
  if (!open.deferredTerminalEventId) return
  open.deferredTerminalAt = new Date().toISOString()
  await writeJsonAtomic(openPath(root), open, { sync: false })
}

export function holdsStopForBackgroundWork(provider: ProviderId): boolean {
  return BACKGROUND_WAKE_PROVIDERS.has(provider)
}

export async function beginContinuationTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string
): Promise<OpenTurnState | undefined> {
  const { provider, event, payload } = input
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const session = await readJson<SessionState>(statePath(root))
  const previous = session?.lastSegment
  if (!previous) return undefined
  const transcriptPath = transcriptPathOf(payload) ?? previous.transcriptPath
  const requestSetId = stringAt(payload, 'request_set_id', 'requestSetId')
  const providerTurnId = providerTurnIdOf(payload, provider)
  const open = await beginOpenTurn(
    enablement, provider, sessionId, event, payload,
    false, false, input.uploadEnvironment, input.capture,
    { startedAt: timestampOf(payload), ...(providerTurnId ? { providerTurnId } : {}) },
    {
      rootRecordId: previous.rootRecordId,
      sealedRecordId: previous.recordId,
      ...(previous.publishedEvents != null ? { publishedEvents: previous.publishedEvents } : {}),
      ...(previous.providerTurnId ? { providerTurnId: previous.providerTurnId } : {}),
      ...(requestSetId ? { requestSetId } : {})
    },
    input.ancestryFromPid ? await hostProcessChain(input.ancestryFromPid) : undefined
  )
  if (transcriptPath && open.transcriptPath !== transcriptPath) {
    open.transcriptPath = transcriptPath
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  await storeLifecycleEvent(enablement, open, event, payload)
  return open
}

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
    transcript: measurable
      ? { ...transcript, events: transcriptSourceEvents(transcript.events).slice(published) }
      : { ...transcript, complete: false },
    ownsRows: measurable,
    ...(open.continuation.providerTurnId ? { providerTurnId: open.continuation.providerTurnId } : {})
  }
}

export function recordStartedAt(open: OpenTurnState, transcriptStartedAt?: string): string {
  if (open.continuation) return open.startedAt
  return transcriptStartedAt ?? open.startedAt
}

export function applyContinuationEvidence(
  evidence: TurnEvidence,
  open: OpenTurnState,
  ownsRows: boolean,
  captureDiff: boolean
): void {
  if (!open.continuation) return
  evidence.user = unavailable(CONTINUATION_USER_REASON)
  const missing = captureDiff
    ? open.captures.filter(({ capture }) => capture.status !== 'ready').map(({ repository }) => repository)
    : []
  if (missing.length > 0 && evidence.diff.status !== 'disabled') {
    const reason = [evidence.diff.omissionReason, `${CONTINUATION_NO_BASELINE_REASON}: ${missing.join(', ')}`]
      .filter(Boolean)
      .join('; ')
    evidence.diff = evidence.diff.status === 'partial' && evidence.diff.value
      ? partial(evidence.diff.value, evidence.diff.source, reason, 'exact',
          [...(evidence.diff.omissionCodes ?? []), 'continuation_no_baseline'])
      : unavailable(reason, evidence.diff.source)
  }
  if (!ownsRows) {
    degradeEvidenceSections(
      evidence,
      'the sealed segment could not measure its transcript boundary, so this segment may repeat content it already published'
    )
  }
}

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

export function transcriptSourceEvents(events: TraceEvent[]): TraceEvent[] {
  return events.filter((event) => event.id.startsWith('transcript-'))
}
