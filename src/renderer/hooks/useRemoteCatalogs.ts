import { useSyncExternalStore } from 'react'
import type { DesktopRemoteCatalog, DesktopRemoteConnection } from '@shared/desktop-remote'
import { useVisibilityPolling } from './useVisibilityPolling'

// One host catalog per saved connection, shared by the sidebar, location picker,
// hosts page and remote conversation. The catalog is a host snapshot: it is kept
// after a disconnect so the user still sees which machine owns a session, but it
// is never proof that the host is reachable or that a Provider still works.
export interface RemoteCatalogEntry {
  catalog?: DesktopRemoteCatalog
  loading: boolean
  stale?: boolean
  error?: string
}
type Snapshot = ReadonlyMap<string, RemoteCatalogEntry>

let snapshot: Snapshot = new Map()
const listeners = new Set<() => void>()
const revisions = new Map<string, number>()
const inFlight = new Map<string, { revision: number; promise: Promise<void> }>()

function publish(connectionId: string, entry: RemoteCatalogEntry): void {
  const next = new Map(snapshot)
  next.set(connectionId, entry)
  snapshot = next
  for (const listener of listeners) listener()
}

export function refreshRemoteCatalog(connectionId: string): Promise<void> {
  const pending = inFlight.get(connectionId)
  if (pending) {
    if (pending.revision === revisions.get(connectionId)) return pending.promise
    return pending.promise.then(() => { if (!document.hidden && snapshot.has(connectionId)) return refreshRemoteCatalog(connectionId) })
  }
  const revision = (revisions.get(connectionId) ?? 0) + 1
  revisions.set(connectionId, revision)
  const previous = snapshot.get(connectionId)
  publish(connectionId, { ...previous, loading: true })
  const promise = (async () => {
    try {
      const catalog = await window.scry.desktopRemote.catalog(connectionId)
      if (revisions.get(connectionId) !== revision) return
      publish(connectionId, { catalog, loading: false, stale: false })
    } catch (error) {
      if (revisions.get(connectionId) !== revision) return
      publish(connectionId, { catalog: previous?.catalog, loading: false, stale: previous?.stale,
        error: error instanceof Error ? error.message : String(error) })
    }
  })().finally(() => { inFlight.delete(connectionId) })
  inFlight.set(connectionId, { revision, promise })
  return promise
}

// Forgetting a host must not leave its projects reachable from the picker.
export function forgetRemoteCatalog(connectionId: string): void {
  revisions.set(connectionId, (revisions.get(connectionId) ?? 0) + 1)
  if (!snapshot.has(connectionId)) return
  const next = new Map(snapshot)
  next.delete(connectionId)
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const getSnapshot = (): Snapshot => snapshot

export function useRemoteCatalogs(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Keep host session activity fresh even when its conversation is not open.
// Catalog reads use host snapshots, not Provider discovery. One App-owned poll
// per connected host, at most every 3s; slow reads are never stacked.
// A failed read retains history, but its error invalidates live activity badges.
export function useConnectedCatalogLoader(connections: readonly DesktopRemoteConnection[], readError: string | null, refreshing = false): void {
  const connectedIds = readError || refreshing ? '' : connections.filter(connection => connection.state === 'connected').map(connection => connection.id).join('\u0000')
  const ids = connectedIds ? connectedIds.split('\u0000') : []
  useVisibilityPolling(`remote-catalogs:${connectedIds}`, () => Promise.all(ids.map(refreshRemoteCatalog)).then(() => {}), 3000, () => {
    for (const id of ids) {
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
      publish(id, { ...snapshot.get(id), loading: true, stale: true })
    }
  })
}
