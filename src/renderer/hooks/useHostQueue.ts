import { useEffect, useState } from 'react'
import type { HostQueueRequest } from '../../shared/host-queue'
import { hostQueueItems, hostQueueRequestFor, type HostQueueItem } from './host-queue-model'
import { HOST_QUEUE_COPY } from '../constants/host-queue-copy'

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
  useEffect(() => {
    if (!sessionId) {
      setState({ status: 'idle', items: [] })
      return
    }
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
 * D1: the queue for the session on screen plus the one action that can move a held entry. The host owns
 * the answer, so a release triggers a re-read rather than a local list edit.
 */
export function useSessionHostQueueWithRelease(session: {
  sessionId: string | null
  providerId?: string | null
  cwd?: string | null
}, refreshKey: string | number | undefined = 0): {
  state: HostQueueState
  release: { releasingRunId: string | null; releaseError: string | null; release: (runId: string) => void }
} {
  const [released, setReleased] = useState(0)
  // Both keys are opaque: the projection key changes, or a release bumps the counter.
  const state = useSessionHostQueue(session, `${refreshKey ?? ''}:${released}`)
  const release = useQueuedRunRelease(() => setReleased((n) => n + 1))
  return { state, release }
}

/** The wiring the App needs: the queue for whatever session is on screen. */
export function useSessionHostQueue(session: { sessionId: string | null; providerId?: string | null; cwd?: string | null }, refreshKey: string | number = 0): HostQueueState {
  const request = hostQueueRequestFor(session)
  return useHostQueue(request, refreshKey)
}
