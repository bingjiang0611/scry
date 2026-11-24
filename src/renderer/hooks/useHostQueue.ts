import { useEffect, useState } from 'react'
import type { HostQueueRequest } from '../../shared/host-queue'
import { hostQueueItems, hostQueueRequestFor, type HostQueueItem } from './host-queue-model'

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
export function useHostQueue(request: HostQueueRequest | null, refreshKey = 0): HostQueueState {
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

/** The wiring the App needs: the queue for whatever session is on screen. */
export function useSessionHostQueue(session: { sessionId: string | null; providerId?: string | null; cwd?: string | null }, refreshKey = 0): HostQueueState {
  const request = hostQueueRequestFor(session)
  return useHostQueue(request, refreshKey)
}
