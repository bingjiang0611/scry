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

export interface RemoteAttentionTracker {
  baseline(connectionId: string, sessions: readonly RemoteSessionRef[]): void
  catalog(connectionId: string, catalog: Pick<DesktopRemoteCatalog, 'sessions'>): readonly string[]
  viewed(connectionId: string, context: DesktopRemoteContext | null): void
  disconnect(connectionId: string): void
  forget(connectionId: string): void
}

export function createRemoteAttentionTracker(publish: RemoteAttentionSink): RemoteAttentionTracker {
  const previous = new Map<string, readonly RemoteSessionRef[]>()
  const sessions = new Map<string, readonly RemoteSessionRef[]>()
  const unread = new Map<string, ReadonlySet<string>>()
  const viewed = new Map<string, string | null>()

  const flush = (): void => {
    publish([...unread].flatMap(([connectionId, keys]) => sessions.has(connectionId) ? [...keys] : []))
  }

  const recompute = (connectionId: string): ReadonlySet<string> => {
    const next = reconcileRemoteSessionAttention(
      connectionId, previous.get(connectionId), sessions.get(connectionId) ?? [],
      unread.get(connectionId) ?? new Set(), viewed.get(connectionId) ?? null
    )
    unread.set(connectionId, next)
    return next
  }

  return {
    // Connection establishment must observe this baseline before publishing the
    // host as connected. On reconnect the retained previous catalog detects
    // terminal results that arrived while the tunnel was down.
    baseline(connectionId, next): void {
      sessions.set(connectionId, next)
      if (previous.has(connectionId)) recompute(connectionId)
      else unread.set(connectionId, new Set())
      previous.set(connectionId, next)
      flush()
    },
    // The host catalog is the only authority for a remote run's terminal outcome.
    catalog(connectionId, catalog): readonly string[] {
      const next = Array.isArray(catalog.sessions) ? catalog.sessions : []
      if (!previous.has(connectionId)) previous.set(connectionId, next)
      sessions.set(connectionId, next)
      const result = recompute(connectionId)
      previous.set(connectionId, next)
      flush()
      return [...result]
    },
    // Only a focused remote session suppresses its own key. Clearing focus lets a
    // later completion on that same session become unread again.
    viewed(connectionId, context): void {
      viewed.set(connectionId, context?.externalSessionId ? remoteSessionAttentionKey(connectionId, context) : null)
      if (sessions.has(connectionId)) recompute(connectionId)
      flush()
    },
    // Disconnect clears visible attention but keeps the last observed catalog as
    // the reconnect baseline. Forgetting the host removes that retained identity.
    disconnect(connectionId): void {
      sessions.delete(connectionId); viewed.delete(connectionId)
      flush()
    },
    forget(connectionId): void {
      previous.delete(connectionId); sessions.delete(connectionId)
      unread.delete(connectionId); viewed.delete(connectionId)
      flush()
    }
  }
}
