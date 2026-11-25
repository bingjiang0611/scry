import { useEffect, useRef, useState } from 'react'
import type { HostQueueRequest } from '../../shared/host-queue'
import { hostQueueItems, hostQueueRequestFor, type HostQueueItem } from './host-queue-model'
import { HOST_QUEUE_COPY } from '../constants/host-queue-copy'
import { RESTART_NOTE_COPY } from '../constants/restart-note-copy'

export type HostQueueState =
  /** The host answered: these are its entries, in its order. */
  | { status: 'ready'; items: HostQueueItem[] }
  /** The projection has never recorded this session, so the queue is unknown — not empty. */
  | { status: 'unknown'; items: [] }
  /** The read failed; the panel shows why instead of an empty queue. */
  | { status: 'unavailable'; items: []; reason: string }
  | { status: 'idle'; items: [] }

/**
 * D1: read the host's queue once per session. It does not poll: the host already pushes lifecycle
 * changes through the session subscription, so a timer here would only add load and risk showing a
 * stale dispatch order.
 */
export function useHostQueue(request: HostQueueRequest | null, refreshKey: string | number = 0): HostQueueState {
  const [state, setState] = useState<HostQueueState>({ status: 'idle', items: [] })
  const sessionId = request?.sessionId ?? null
  const providerId = request?.providerId ?? null
  const cwd = request?.cwd ?? null
  const agentProfileId = request?.agentProfileId ?? null
  // The entries belong to one session: while the new session's answer is in flight, showing the previous
  // session's rows would be a lie about whose queue this is.
  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    const stale = shownFor.current !== sessionId
    shownFor.current = sessionId
    if (!sessionId || stale) setState({ status: 'idle', items: [] })
    if (!sessionId) return
    const ask = hostQueueRequestFor({ sessionId, providerId, cwd, agentProfileId })
    if (!ask) return
    let live = true
    void window.scry.hostQueue(ask).then(
      (answer) => {
        if (!live) return
        setState(answer.resolved
          ? { status: 'ready', items: hostQueueItems(answer.entries) }
          : { status: 'unknown', items: [] })
      },
      (reason: unknown) => { if (live) setState({ status: 'unavailable', items: [], reason: errorText(reason) }) }
    )
    return () => { live = false }
  }, [sessionId, providerId, cwd, agentProfileId, refreshKey])
  return state
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' ? reason : '未知原因'
}

/**
 * D1: releasing a held entry is the only way it moves. The hook keeps the in-flight run and the host's
 * refusal, and asks for a re-read afterwards — the host is the authority, so the panel shows its answer
 * rather than assuming the release worked.
 */
export function useQueuedRunRelease(onReleased: () => void): {
  releasingRunId: string | null
  releaseError: string | null
  release: (runId: string) => void
} {
  const [releasingRunId, setReleasing] = useState<string | null>(null)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [releasedCount, setReleasedCount] = useState(0)
  useEffect(() => { if (releasedCount > 0) onReleased() }, [releasedCount])
  const release = (runId: string): void => {
    setReleasing(runId)
    setReleaseError(null)
    void window.scry.releaseQueuedRun(runId).then(
      (answer) => {
        setReleasing(null)
        if (!answer.ok) { setReleaseError(HOST_QUEUE_COPY.releaseRefused(answer.reason ?? '')); return }
        setReleasedCount((n) => n + 1)
      },
      (reason: unknown) => { setReleasing(null); setReleaseError(errorText(reason)) }
    )
  }
  return { releasingRunId, releaseError, release }
}

/**
 * C4: the restart offer for the session on screen, and the press that continues it. The offer is the
 * host's — it holds the events that say a run ended with cancelled background work — and the press
 * consumes it once, so the panel can only ever send that instruction one time.
 */
export interface RestartContinueState {
  offer: 'idle' | 'none' | 'pending' | 'unknown'
  pressing: boolean
  error: string | null
  press: () => void
}

export function useRestartContinue(session: {
  sessionId: string | null
  providerId?: string | null
  cwd?: string | null
  agentProfileId?: string | null
}, refreshKey: string | number | undefined = 0): RestartContinueState {
  const [offer, setOffer] = useState<RestartContinueState['offer']>('idle')
  const [pressing, setPressing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pressed, setPressed] = useState(0)
  const request = hostQueueRequestFor(session)
  const key = `${refreshKey ?? ''}:${pressed}`
  useEffect(() => {
    if (!request) { setOffer('idle'); return }
    let live = true
    setError(null)
    void window.scry.restartNote(request).then(
      (answer) => { if (live) setOffer(!answer.resolved ? 'unknown' : answer.pending ? 'pending' : 'none') },
      () => { if (live) setOffer('unknown') }
    )
    return () => { live = false }
  }, [request?.sessionId, request?.providerId, request?.cwd, request?.agentProfileId, key])
  const press = (): void => {
    if (!request || pressing) return
    setPressing(true)
    setError(null)
    void window.scry.continueAfterRestart(request).then(
      (answer) => {
        setPressing(false)
        // Even a refusal means the offer moved on: the note was consumed, or the host said why not.
        setOffer(answer.ok ? 'none' : 'unknown')
        if (!answer.ok) {
          setError(answer.reason === 'no_pending_note'
            ? RESTART_NOTE_COPY.noPendingNote
            : RESTART_NOTE_COPY.refused(answer.reason ?? ''))
        }
        setPressed((n) => n + 1)
      },
      (reason: unknown) => { setPressing(false); setError(errorText(reason)) }
    )
  }
  return { offer, pressing, error, press }
}

/**
 * D1/C4: the host's queue and the two actions that move it. Both answers are the host's, so each
 * action asks again instead of editing a local list.
 */
export function useSessionHostQueueWithRelease(session: {
  sessionId: string | null
  providerId?: string | null
  cwd?: string | null
}, refreshKey: string | number | undefined = 0): {
  state: HostQueueState
  release: { releasingRunId: string | null; releaseError: string | null; release: (runId: string) => void }
  restartContinue: RestartContinueState
} {
  const [released, setReleased] = useState(0)
  // Both keys are opaque: the projection key changes, or a release bumps the counter.
  const state = useSessionHostQueue(session, `${refreshKey ?? ''}:${released}`)
  const release = useQueuedRunRelease(() => setReleased((n) => n + 1))
  const restartContinue = useRestartContinue(session, refreshKey)
  return { state, release, restartContinue }
}

/** The wiring the App needs: the queue for whatever session is on screen. */
export function useSessionHostQueue(session: { sessionId: string | null; providerId?: string | null; cwd?: string | null }, refreshKey: string | number = 0): HostQueueState {
  const request = hostQueueRequestFor(session)
  return useHostQueue(request, refreshKey)
}
