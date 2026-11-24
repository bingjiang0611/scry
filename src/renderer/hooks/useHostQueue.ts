import { useEffect, useState } from 'react'
import type { HostQueueRequest } from '../../shared/host-queue'
import type { HostQueueEntry } from '../../shared/host-queue'
import { hostQueueItems, hostQueueRequestFor, type HostQueueItem } from './host-queue-model'

export interface HostQueueState {
  items: HostQueueItem[]
  loading: boolean
  /** Why the queue could not be read; the panel says so instead of showing an empty queue. */
  error: string | null
}

/**
 * D1: read the host's queue once per session and again when the caller asks. It does not poll: the
 * host already pushes lifecycle changes through the session subscription, so a timer here would only
 * add load and risk showing a stale order.
 */
export function useHostQueue(request: HostQueueRequest | null, refreshKey = 0): HostQueueState {
  const [state, setState] = useState<HostQueueState>({ items: [], loading: request !== null, error: null })
  const sessionId = request?.sessionId ?? null
  const providerId = request?.providerId ?? null
  const cwd = request?.cwd ?? null
  const agentProfileId = request?.agentProfileId ?? null
  useEffect(() => {
    if (!sessionId) {
      setState({ items: [], loading: false, error: null })
      return
    }
    let live = true
    setState((previous) => ({ ...previous, loading: true }))
    const request = hostQueueRequestFor({ sessionId, providerId, cwd, agentProfileId })
    if (!request) { setState({ items: [], loading: false, error: null }); return }
    void window.scry.hostQueue(request).then(
      (entries: HostQueueEntry[]) => { if (live) setState({ items: hostQueueItems(entries), loading: false, error: null }) },
      (reason: unknown) => { if (live) setState({ items: [], loading: false, error: errorText(reason) }) }
    )
    return () => { live = false }
  }, [sessionId, providerId, cwd, agentProfileId, refreshKey])
  return state
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' ? reason : '未知原因'
}
