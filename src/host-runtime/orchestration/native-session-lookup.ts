import { sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import {
  anySourceTombstone,
  isSessionKeyTombstoned,
  lookupBoundSessionKey,
  tombstonedSessionKey,
  type NativeIdentityKey
} from './native-session-bindings'
import { mapSessionRow } from './projection-mappers'
import { OrchestrationStoreError, type SessionProjectionRow } from './types'

export { isSessionKeyTombstoned }

export interface NativeSessionIdentity {
  sessionId: string
  provider: string
  profile: string | null
  cwd: string | undefined
}

type SessionReader = Pick<EventSink, 'getSession' | 'handle'>

export function scopedNativeSessionKey(identity: NativeSessionIdentity): string {
  return `native:${sha256Hex(JSON.stringify([identity.provider, identity.profile, identity.cwd, identity.sessionId]))}`
}

/**
 * B3: tombstones are read from the binding table first, so pruning `orch_event` can never
 * resurrect a deleted session. The event lookup stays as a read-only fallback for rows that
 * predate the binding table.
 */
export function deletedNativeSessionKey(sink: SessionReader, identity: NativeSessionIdentity): string | undefined {
  const bound = tombstonedSessionKey(sink, identity as NativeIdentityKey)
  if (bound) return bound
  const row = sink.handle.db.prepare(
    `SELECT session_key AS key FROM orch_event
     WHERE type = 'session.deleted' AND json_extract(payload, '$.nativeIdentity') = ?
     ORDER BY seq DESC LIMIT 1`
  ).get(scopedNativeSessionKey(identity)) as { key: string } | undefined
  return row?.key
}

export function wasNativeSourceDeleted(sink: SessionReader, identity: NativeSessionIdentity): boolean {
  if (anySourceTombstone(sink, { ...(identity as NativeIdentityKey), profile: null })) return true
  return Boolean(sink.handle.db.prepare(
    `SELECT 1 FROM orch_event
     WHERE type = 'session.deleted' AND json_extract(payload, '$.nativeSource') = ? LIMIT 1`
  ).get(scopedNativeSessionKey({ ...identity, profile: null })))
}

/**
 * B3: resolves a native identity through the binding table. Two matching bindings or two matching
 * projections are an error, never a fresh key allocation.
 */
export function findNativeSession(sink: SessionReader, identity: NativeSessionIdentity): SessionProjectionRow | undefined {
  const { sessionId, provider, profile, cwd } = identity
  // B3: a tombstoned identity stays deleted; re-import cannot resurrect it.
  if (tombstonedSessionKey(sink, identity as NativeIdentityKey)) return undefined
  const bound = lookupBoundSessionKey(sink, identity as NativeIdentityKey)
  if (bound) {
    const session = sink.getSession(bound)
    if (session && !session.conversationId) return session
    return undefined
  }
  if (cwd !== undefined) {
    const direct = sink.getSession(sessionId)
    if (direct && !direct.conversationId && (direct.provider ?? 'legacy_unknown') === provider &&
        direct.profile === profile && direct.cwd === cwd &&
        (direct.catalog?.nativeSessionId == null || direct.catalog.nativeSessionId === sessionId)) return direct
  }
  const rows = sink.handle.db.prepare(
    `SELECT * FROM orch_p_session
     WHERE conversation_id IS NULL AND COALESCE(provider, 'legacy_unknown') = ? AND profile IS ?
       AND (? IS NULL OR cwd = ?)
       AND (json_extract(catalog, '$.nativeSessionId') = ?
         OR (json_extract(catalog, '$.nativeSessionId') IS NULL AND session_key = ?))
     LIMIT 2`
  ).all(provider, profile, cwd ?? null, cwd ?? null, sessionId, sessionId) as Record<string, unknown>[]
  if (rows.length > 1) {
    throw new OrchestrationStoreError(
      'orchestration_binding_ambiguous',
      `Multiple projected sessions match native session ${sessionId}`
    )
  }
  return rows.length === 1 ? mapSessionRow(rows[0]) : undefined
}
