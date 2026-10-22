import { useSyncExternalStore } from 'react'
import type { DesktopRemoteConnection } from '@shared/desktop-remote'
import { useVisibilityPolling } from './useVisibilityPolling'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'

type Snapshot = { connections: DesktopRemoteConnection[]; loaded: boolean; error: string | null }
let snapshot: Snapshot = { connections: [], loaded: false, error: null }
const listeners = new Set<() => void>()
let revision = 0

// Main owns persisted identities and SSH state. This is only a shared projection:
// a saved host is not necessarily connected, and a failed read is not an empty list.
export async function refreshDesktopConnections(): Promise<void> {
  const request = ++revision
  try {
    const connections = await window.scry.desktopRemote.list()
    if (request !== revision) return
    snapshot = { connections, loaded: true, error: null }
  } catch (error) {
    if (request !== revision) return
    snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) revision += 1
  }
}
const getSnapshot = (): Snapshot => snapshot
export function useDesktopConnections(): Snapshot {
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useVisibilityPolling('desktop-connections', refreshDesktopConnections, 3000)
  return result
}

export function desktopConnectionLabel(connection: DesktopRemoteConnection, error: string | null): string {
  return error ? copy.status.unknown : copy.status[connection.state]
}
