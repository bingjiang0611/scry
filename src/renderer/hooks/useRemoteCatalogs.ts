import { useEffect, useSyncExternalStore } from 'react'
import type { DesktopRemoteCatalog, DesktopRemoteConnection } from '@shared/desktop-remote'

// One host catalog per saved connection, shared by the sidebar, location picker,
// hosts page and remote conversation. The catalog is a host snapshot: it is kept
// after a disconnect so the user still sees which machine owns a session, but it
// is never proof that the host is reachable or that a Provider still works.
export interface RemoteCatalogEntry {
  catalog?: DesktopRemoteCatalog
  loading: boolean
  error?: string
}
type Snapshot = ReadonlyMap<string, RemoteCatalogEntry>

let snapshot: Snapshot = new Map()
const listeners = new Set<() => void>()
const revisions = new Map<string, number>()

function publish(connectionId: string, entry: RemoteCatalogEntry): void {
  const next = new Map(snapshot)
  next.set(connectionId, entry)
  snapshot = next
  for (const listener of listeners) listener()
}

export async function refreshRemoteCatalog(connectionId: string): Promise<void> {
  const revision = (revisions.get(connectionId) ?? 0) + 1
  revisions.set(connectionId, revision)
  const previous = snapshot.get(connectionId)
  publish(connectionId, { catalog: previous?.catalog, loading: true })
  try {
    const catalog = await window.scry.desktopRemote.catalog(connectionId)
    if (revisions.get(connectionId) !== revision) return
    publish(connectionId, { catalog, loading: false })
  } catch (error) {
    if (revisions.get(connectionId) !== revision) return
    publish(connectionId, { catalog: previous?.catalog, loading: false, error: error instanceof Error ? error.message : String(error) })
  }
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

const readWhileConnected = new Set<string>()

// Read each host once per connected period. A reconnect re-reads the catalog;
// polling is left to the open conversation, which refreshes after a run settles.
// Mount this loader once (App); several mounts would only share the same set.
export function useConnectedCatalogLoader(connections: readonly DesktopRemoteConnection[], readError: string | null): void {
  const connectedIds = readError ? '' : connections.filter(connection => connection.state === 'connected').map(connection => connection.id).join('\u0000')
  useEffect(() => {
    const connected = new Set(connectedIds ? connectedIds.split('\u0000') : [])
    for (const id of readWhileConnected) if (!connected.has(id)) readWhileConnected.delete(id)
    for (const id of connected) {
      if (readWhileConnected.has(id)) continue
      readWhileConnected.add(id)
      void refreshRemoteCatalog(id)
    }
  }, [connectedIds])
}
