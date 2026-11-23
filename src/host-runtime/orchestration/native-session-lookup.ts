import { sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import { mapSessionRow } from './projection-mappers'
import type { SessionProjectionRow } from './types'

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

export function deletedNativeSessionKey(sink: SessionReader, identity: NativeSessionIdentity): string | undefined {
  const row = sink.handle.db.prepare(
    `SELECT session_key AS key FROM orch_event
     WHERE type = 'session.deleted' AND json_extract(payload, '$.nativeIdentity') = ?
     ORDER BY seq DESC LIMIT 1`
  ).get(scopedNativeSessionKey(identity)) as { key: string } | undefined
  return row?.key
}

export function wasNativeSourceDeleted(sink: SessionReader, identity: NativeSessionIdentity): boolean {
  return Boolean(sink.handle.db.prepare(
    `SELECT 1 FROM orch_event
     WHERE type = 'session.deleted' AND json_extract(payload, '$.nativeSource') = ? LIMIT 1`
  ).get(scopedNativeSessionKey({ ...identity, profile: null })))
}

export function findNativeSession(sink: SessionReader, identity: NativeSessionIdentity): SessionProjectionRow | undefined {
  const { sessionId, provider, profile, cwd } = identity
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
  return rows.length === 1 ? mapSessionRow(rows[0]) : undefined
}
