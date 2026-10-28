import {
  beginGitTurnDiff,
  cancelGitTurnDiff,
  cloneGitTurnDiffCapture,
  finishGitTurnAndSessionDiff,
  finishGitTurnDiff,
  snapshotSessionNetDiff,
  type GitTurnDiffCapture,
  type GitTurnDiffFinishOptions
} from './git'
import { appendCoalescedTrace, upsertTraceById } from './live-trace'
import { RunDiffPreviewer, type SessionDiffBaselineRegistry } from './session-diff'
import type { ProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'
import type { TraceEvent, TurnDiffBaselineOrigin, TurnDiffReason, TurnDiffSnapshot } from '../shared/trace'

export interface AppRunDiffLifecycleOptions {
  runId: string
  cwd?: string
  contextKey?: string
  resume?: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  initialCapture: Promise<GitTurnDiffCapture>
  patchExcludeBasenames: readonly string[]
  sessionDiffBaselines: SessionDiffBaselineRegistry
  getDiffContextKey: () => string
  getObservedSessionId: () => string | undefined
  getContextRevision: () => number
  hints: () => GitTurnDiffFinishOptions
  items: TraceEvent[]
  isFocused: () => boolean
  isViewed: () => boolean
  queueTrace: (event: TraceEvent) => void
  eventId: (prefix: string) => string
  now?: () => Date
}

export interface AppRunDiffLifecycle {
  turnCapture: Promise<GitTurnDiffCapture>
  sessionBaselineReady: Promise<unknown>
  notifyChange: () => Promise<void>
  finalizeTurn: () => Promise<void>
  cancelTurn: () => Promise<void>
  finalizeSession: () => Promise<void>
  releaseSessionBaseline: () => void
}

export function createAppRunDiffLifecycle(options: AppRunDiffLifecycleOptions): AppRunDiffLifecycle {
  const {
    runId, cwd, contextKey, resume, providerId, runtimeProvider, initialCapture,
    sessionDiffBaselines, items, isFocused, isViewed, queueTrace, eventId
  } = options
  const now = options.now ?? (() => new Date())
  const patchExcludeBasenames = [...options.patchExcludeBasenames]
  const finishOptions = (): GitTurnDiffFinishOptions => ({ ...options.hints(), patchExcludeBasenames })
  let turnCapture = initialCapture
  let sessionBaselineReady: Promise<unknown> = Promise.resolve()
  let sessionBaselineOrigin: TurnDiffBaselineOrigin | undefined
  let sessionBaselineCapture: Promise<GitTurnDiffCapture> | null = null
  let releaseSessionBaseline = (): void => {}

  if (cwd && contextKey) {
    const baseline = sessionDiffBaselines.ensure({
      key: options.getDiffContextKey(),
      revision: 0,
      cwd,
      ...(resume ? { sessionId: resume } : {}),
      initialCapture
    })
    releaseSessionBaseline = sessionDiffBaselines.retain(baseline)
    sessionBaselineOrigin = baseline.origin
    sessionBaselineCapture = baseline.capture
    sessionBaselineReady = baseline.capture.catch(() => undefined)
    if (baseline.capture === initialCapture) {
      // Turn and session need the same instant, but each owns an independent cleanup lifecycle.
      turnCapture = initialCapture
        .then(capture => cloneGitTurnDiffCapture(capture))
        .catch(error => {
          console.warn('[scry] Git baseline clone failed; falling back to a second capture:', runId, error)
          return beginGitTurnDiff(cwd)
        })
    }
  }

  const previewer = new RunDiffPreviewer({
    runId,
    turnCapture: cwd ? turnCapture : null,
    sessionCapture: sessionBaselineCapture,
    ...(sessionBaselineOrigin ? { sessionBaselineOrigin } : {}),
    hints: finishOptions,
    emit: ({ stage, id, snapshot }) => {
      const event: TraceEvent = {
        id,
        ts: now().toISOString(),
        runId,
        kind: 'harness',
        stage,
        providerId,
        runtimeProvider,
        turnDiff: snapshot
      }
      upsertTraceById(items, event)
      if (isFocused()) queueTrace(event)
    },
    onError: (scope, error) => console.warn('[scry] diff preview failed:', runId, scope, error)
  })

  let pairedSessionDiff: { capture: GitTurnDiffCapture; snapshot: Promise<TurnDiffSnapshot> } | undefined
  let turnDiffPromise: Promise<void> | null = null
  const finalizeTurn = (): Promise<void> => {
    previewer.sealAll()
    turnDiffPromise ??= previewer.idle()
      .then(() => turnCapture)
      .then(async capture => {
        const finalOptions = finishOptions()
        const entry = cwd && contextKey
          ? sessionDiffBaselines.get(options.getDiffContextKey(), 0, options.getObservedSessionId() ?? resume)
          : undefined
        if (!entry) return finishGitTurnDiff(capture, undefined, finalOptions)
        let baseline: GitTurnDiffCapture
        try { baseline = await entry.capture } catch {
          return finishGitTurnDiff(capture, undefined, finalOptions)
        }
        if (baseline.status !== 'ready') return finishGitTurnDiff(capture, undefined, finalOptions)
        const pair = finishGitTurnAndSessionDiff(capture, baseline, undefined, finalOptions, { patchExcludeBasenames })
        pairedSessionDiff = { capture: baseline, snapshot: pair.session }
        void pair.session.catch(error => console.warn('[scry] paired session diff failed:', runId, error))
        return pair.turn
      })
      .then(turnDiff => {
        const event: TraceEvent = {
          id: eventId('turn-diff'),
          ts: now().toISOString(),
          runId,
          kind: 'harness',
          stage: 'turn_diff',
          providerId,
          runtimeProvider,
          turnDiff
        }
        appendCoalescedTrace(items, event)
        if (isViewed()) queueTrace(event)
        if (turnDiff.status === 'failed' || turnDiff.status === 'timeout') {
          console.warn('[scry] turn diff capture degraded:', runId, turnDiff.reason, turnDiff.captureMs)
        }
        if (turnDiff.collection?.strategy === 'full_fallback' && turnDiff.collection.fallbackReason !== 'forced') {
          console.warn('[scry] turn diff used full fallback:', runId, turnDiff.collection.fallbackReason,
            turnDiff.collection.candidatePathCount, turnDiff.collection.discoveryMs, turnDiff.collection.targetedMs)
        }
        const patchUnavailable = turnDiff.files.filter(file => file.patchStatus === 'unavailable')
        if (patchUnavailable.length > 0) {
          console.warn('[scry] turn diff patch partially unavailable:', runId, patchUnavailable.length,
            [...new Set(patchUnavailable.map(file => file.patchReason))])
        }
      })
      .catch(async error => {
        try { await cancelGitTurnDiff(await turnCapture) } catch { /* capture may have failed before allocation */ }
        console.warn('[scry] turn diff finalization failed:', runId, error)
      })
    return turnDiffPromise
  }

  const cancelTurn = (): Promise<void> => {
    previewer.sealAll()
    turnDiffPromise ??= previewer.idle()
      .then(() => turnCapture)
      .then(capture => cancelGitTurnDiff(capture))
      .catch(error => console.warn('[scry] turn diff cancellation failed:', runId, error))
    return turnDiffPromise
  }

  let sessionDiffPromise: Promise<void> | null = null
  const finalizeSession = (): Promise<void> => {
    if (!cwd || !contextKey) return Promise.resolve()
    previewer.sealAll()
    sessionDiffPromise ??= (async () => {
      await previewer.idle()
      const publish = (snapshot: TurnDiffSnapshot, origin?: TurnDiffBaselineOrigin): void => {
        const event: TraceEvent = {
          id: eventId('session-diff'),
          ts: now().toISOString(),
          runId,
          kind: 'harness',
          stage: 'session_diff',
          providerId,
          runtimeProvider,
          turnDiff: origin ? { ...snapshot, baseline: origin } : snapshot
        }
        appendCoalescedTrace(items, event)
        if (isViewed()) queueTrace(event)
      }
      const unavailable = (reason: TurnDiffReason): TurnDiffSnapshot => {
        const at = now().toISOString()
        return { version: 1, status: 'unavailable', reason, files: [], beforeAt: at, afterAt: at, captureMs: 0, cleanup: 'ok' }
      }
      const sessionId = options.getObservedSessionId() ?? resume
      const entry = sessionDiffBaselines.get(options.getDiffContextKey(), 0, sessionId)
      if (!entry) {
        console.warn('[scry] session diff baseline not found:', runId, {
          contextRevision: options.getContextRevision(),
          sessionId
        })
        publish(unavailable('no_baseline'))
        return
      }
      let baseline: GitTurnDiffCapture
      try { baseline = await entry.capture } catch (error) {
        console.warn('[scry] session diff baseline capture rejected:', runId, error)
        publish(unavailable('no_baseline'), entry.origin)
        return
      }
      if (baseline.status !== 'ready') {
        console.warn('[scry] session diff baseline not ready:', runId, baseline.status, baseline.reason)
        publish({ ...unavailable(baseline.reason ?? 'no_baseline'), status: baseline.status }, entry.origin)
        return
      }
      try {
        const snapshot = await (pairedSessionDiff?.capture === baseline
          ? pairedSessionDiff.snapshot
          : snapshotSessionNetDiff(baseline, undefined, { patchExcludeBasenames }))
        publish(snapshot, entry.origin)
      } catch (error) {
        console.warn('[scry] session diff capture failed:', runId, error)
        publish(unavailable('git_error'), entry.origin)
      }
    })().catch(error => console.warn('[scry] session diff finalization failed:', runId, error))
    return sessionDiffPromise
  }

  return {
    turnCapture,
    sessionBaselineReady,
    notifyChange: () => previewer.notifyChange(),
    finalizeTurn,
    cancelTurn,
    finalizeSession,
    releaseSessionBaseline
  }
}
