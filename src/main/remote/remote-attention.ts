import type { DesktopRemoteCatalog, DesktopRemoteContext, RemoteSessionRef } from '../../shared/desktop-remote'
import { reconcileRemoteSessionAttention, remoteSessionAttentionKey } from '../../shared/remote-session-attention'

/**
 * Remote sessions run on a paired host, so this client has no local run to badge.
 * Attention is derived from the host's own catalog evidence with the same rule the
 * sidebar uses, and cleared when this client opens that exact session. Without this
 * the Dock badge either stayed empty after a remote run finished or never cleared.
 */
export interface RemoteAttentionSink {
  (keys: readonly string[]): void
}

export function createRemoteAttentionTracker(publish: RemoteAttentionSink) {
  const previous = new Map<string, readonly RemoteSessionRef[]>()
  const sessions = new Map<string, readonly RemoteSessionRef[]>()
  const unread = new Map<string, ReadonlySet<string>>()
  const viewed = new Map<string, string | null>()

  const flush = (): void => {
    publish([...unread.values()].flatMap((keys) => [...keys]))
  }

  const recompute = (connectionId: string): void => {
    const next = reconcileRemoteSessionAttention(
      connectionId, previous.get(connectionId), sessions.get(connectionId) ?? [],
      unread.get(connectionId) ?? new Set(), viewed.get(connectionId) ?? null
    )
    unread.set(connectionId, next)
  }

  return {
    // The host catalog is the only authority for a remote run's terminal outcome.
    catalog(connectionId: string, catalog: Pick<DesktopRemoteCatalog, 'sessions'>): void {
      const next = Array.isArray(catalog.sessions) ? catalog.sessions : []
      // First discovery is a baseline, so historical results are not announced.
      if (!previous.has(connectionId)) previous.set(connectionId, next)
      sessions.set(connectionId, next)
      recompute(connectionId)
      previous.set(connectionId, next)
      flush()
    },
    // Opening a remote session clears its own key; the renderer already shows the run.
    viewed(connectionId: string, context: DesktopRemoteContext): void {
      if (!context.externalSessionId) return
      viewed.set(connectionId, remoteSessionAttentionKey(connectionId, context))
      sessions.set(connectionId, sessions.get(connectionId) ?? [])
      recompute(connectionId)
      flush()
    },
    disconnect(connectionId: string): void {
      previous.delete(connectionId); sessions.delete(connectionId)
      unread.delete(connectionId); viewed.delete(connectionId)
      flush()
    }
  }
}
