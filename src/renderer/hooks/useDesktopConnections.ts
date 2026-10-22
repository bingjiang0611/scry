import { useSyncExternalStore } from 'react'
import type { DesktopRemoteConnection } from '@shared/desktop-remote'
import { createVisibilityPollingController } from './useVisibilityPolling'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'

type Snapshot = { connections: DesktopRemoteConnection[]; loaded: boolean; refreshing: boolean; error: string | null }
let snapshot: Snapshot = { connections: [], loaded: false, refreshing: true, error: null }
const listeners = new Set<() => void>()
let revision = 0
let inFlight: { revision: number; promise: Promise<void> } | undefined
const publish = (): void => { for (const listener of listeners) listener() }

// Main owns persisted identities and SSH state. Retained host identities are
// history, not proof of reachability while a visibility refresh is pending.
export function refreshDesktopConnections(): Promise<void> {
  if (inFlight) {
    return inFlight.revision === revision ? inFlight.promise : inFlight.promise.then(() => {
      if (!document.hidden) return refreshDesktopConnections()
    })
  }
  const request = ++revision
  const promise = (async () => {
    try {
      const connections = await window.scry.desktopRemote.list()
      if (request !== revision) return
      snapshot = { connections, loaded: true, refreshing: false, error: null }
    } catch (error) {
      if (request !== revision) return
      snapshot = { ...snapshot, refreshing: false, error: error instanceof Error ? error.message : String(error) }
    }
    publish()
  })().finally(() => { inFlight = undefined })
  inFlight = { revision: request, promise }
  return promise
}

const polling = createVisibilityPollingController(refreshDesktopConnections, 3000, undefined, () => {
  revision += 1
  snapshot = { ...snapshot, refreshing: true }
  publish()
})
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) polling.start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) { polling.stop(); revision += 1 }
  }
}
const getSnapshot = (): Snapshot => snapshot
export function useDesktopConnections(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function desktopConnectionLabel(connection: DesktopRemoteConnection, error: string | null, refreshing = false): string {
  return refreshing ? copy.loadingDesktopStatus : error ? copy.status.unknown : copy.status[connection.state]
}
