import { createHash } from 'node:crypto'
import type { RemoteSessionPage, RemoteSessionPageQuery, RemoteSessionSource } from './remote-gateway-types'
import type { RemoteSessionRef } from '../../shared/desktop-remote'
import { RemoteGatewayError } from './remote-gateway-types'
import { MAX_CATALOG_ITEMS, MAX_CATALOG_PAGE, sessionRefs } from './remote-gateway-sanitizers'

// The device session catalog: one immutable snapshot per page walk, so a stale cursor
// is refused instead of silently returning different content. Kept beside the other
// gateway faces rather than inside the class.
const SESSION_SNAPSHOT_TTL_MS = 30_000
const MAX_SESSION_SNAPSHOTS = 32

export interface RemoteGatewaySessionContext {
  authorize(peerCertSHA256: string): void
  sessions?: RemoteSessionSource
  catalogs: Map<string, { sessions: readonly RemoteSessionRef[]; snapshot: string; revision: string; expiresAt: number }>
}

export function listSessions(context: RemoteGatewaySessionContext, peerCertSHA256: string): RemoteSessionRef[] {
    context.authorize(peerCertSHA256)
    return sessionRefs((context.sessions?.list() ?? []).filter(session => !session.archivedAt))
  }

export function listSessionsPage(context: RemoteGatewaySessionContext, peerCertSHA256: string, input: RemoteSessionPageQuery): RemoteSessionPage {
    context.authorize(peerCertSHA256)
    const cursor = input?.cursor ?? 0
    const limit = input?.limit ?? MAX_CATALOG_PAGE
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RemoteGatewayError('invalid_session_cursor')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE) throw new RemoteGatewayError('invalid_session_limit')
    if (input.includeArchived !== undefined && typeof input.includeArchived !== 'boolean') throw new RemoteGatewayError('invalid_session_query')
    const filter = input.includeArchived === true
    const baseKey = `${peerCertSHA256}:${filter}`
    const now = Date.now()
    for (const [key, cached] of context.catalogs) {
      if (cached.expiresAt <= now) context.catalogs.delete(key)
    }
    const revision = context.sessions?.revision?.() ?? ''
    let cached: { sessions: readonly RemoteSessionRef[]; snapshot: string; revision: string; expiresAt: number } | undefined

    if (input.snapshot !== undefined) {
      const key = `${baseKey}:${revision}:${input.snapshot}`
      cached = context.catalogs.get(key)
      // An expired/evicted token, or one issued under an older source
      // revision, cannot be rebuilt from current content: doing so could make
      // a stale cursor appear valid after a concurrent refresh.
      if (!cached || cached.revision !== revision) throw new RemoteGatewayError('session_snapshot_changed')
      // Without a source revision there is no second invalidation signal. The
      // retained object is the honest frozen page walk until TTL/cap eviction;
      // authorization is still checked above on every request.
      // Refresh recency without changing the immutable catalog itself.
      cached.expiresAt = now + SESSION_SNAPSHOT_TTL_MS
      context.catalogs.delete(key)
      context.catalogs.set(key, cached)
    } else {
      const sessions = sessionRefs((context.sessions?.list() ?? []).filter(session => filter || !session.archivedAt), MAX_CATALOG_ITEMS + 1)
      if (sessions.length > MAX_CATALOG_ITEMS) throw new RemoteGatewayError('session_capacity_exceeded')
      const immutable = Object.freeze(sessions.map((session) => Object.freeze(session)))
      const snapshot = createHash('sha256').update(JSON.stringify(immutable)).digest('hex')
      cached = { sessions: immutable, snapshot, revision, expiresAt: now + SESSION_SNAPSHOT_TTL_MS }
      const key = `${baseKey}:${revision}:${snapshot}`
      context.catalogs.delete(key)
      context.catalogs.set(key, cached)
      while (context.catalogs.size > MAX_SESSION_SNAPSHOTS) {
        const oldest = context.catalogs.keys().next().value
        if (oldest === undefined) break
        context.catalogs.delete(oldest)
      }
    }

    if (cursor > cached.sessions.length) throw new RemoteGatewayError('invalid_session_cursor')
    const end = Math.min(cached.sessions.length, cursor + limit)
    return {
      sessions: cached.sessions.slice(cursor, end),
      cursor: end,
      total: cached.sessions.length,
      hasMore: end < cached.sessions.length,
      snapshot: cached.snapshot
    }
  }

