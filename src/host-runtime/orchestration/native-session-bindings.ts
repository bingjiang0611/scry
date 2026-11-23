import type Database from 'better-sqlite3'
import { OrchestrationStoreError } from './types'

export interface NativeIdentityKey {
  sessionId: string
  provider: string
  profile: string | null
  cwd: string | undefined
}

function normalize(identity: NativeIdentityKey): { provider: string; profile: string; cwd: string; nativeId: string } {
  return {
    provider: identity.provider,
    profile: identity.profile ?? '',
    cwd: identity.cwd ?? '',
    nativeId: identity.sessionId
  }
}

/**
 * B3: records `(provider, profile, cwd, native_id) -> session_key`. Re-binding the same pair is
 * idempotent; binding the same identity to a different key is a conflict, never a silent reassign.
 */
export function bindNativeSession(
  source: { handle: { db: Database.Database } },
  identity: NativeIdentityKey,
  sessionKey: string,
  at = Date.now()
): string {
  const db = source.handle.db
  const { provider, profile, cwd, nativeId } = normalize(identity)
  const existing = db
    .prepare(
      'SELECT session_key, deleted_at FROM orch_binding WHERE provider = ? AND profile = ? AND cwd = ? AND native_id = ?'
    )
    .get(provider, profile, cwd, nativeId) as { session_key: string; deleted_at: number | null } | undefined
  if (existing) {
    if (existing.session_key !== sessionKey) {
      throw new OrchestrationStoreError(
        'orchestration_binding_conflict',
        `Native session ${nativeId} is already bound to ${existing.session_key}`
      )
    }
    return existing.session_key
  }
  try {
    db.prepare(
      `INSERT INTO orch_binding (provider, profile, cwd, native_id, session_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(provider, profile, cwd, nativeId, sessionKey, at)
  } catch (error) {
    throw new OrchestrationStoreError(
      'orchestration_binding_conflict',
      error instanceof Error ? error.message : String(error)
    )
  }
  return sessionKey
}

/** Returns the live (non-tombstoned) session key bound to this native identity. */
export function lookupBoundSessionKey(
  source: { handle: { db: Database.Database } },
  identity: NativeIdentityKey
): string | undefined {
  const { provider, profile, cwd, nativeId } = normalize(identity)
  const rows = source.handle.db
    .prepare(
      `SELECT session_key FROM orch_binding
       WHERE provider = ? AND profile = ? AND cwd = ? AND native_id = ? AND deleted_at IS NULL
       LIMIT 2`
    )
    .all(provider, profile, cwd, nativeId) as Array<{ session_key: string }>
  if (rows.length > 1) {
    throw new OrchestrationStoreError(
      'orchestration_binding_ambiguous',
      `Multiple bindings for native session ${nativeId}`
    )
  }
  return rows[0]?.session_key
}

/** Marks the binding retired. The row stays so the identity can never be re-bound. */
export function tombstoneBinding(
  source: { handle: { db: Database.Database } },
  sessionKey: string,
  at: number
): void {
  source.handle.db
    .prepare('UPDATE orch_binding SET deleted_at = COALESCE(deleted_at, ?), delete_epoch = delete_epoch + 1 WHERE session_key = ?')
    .run(at, sessionKey)
}

/** Tombstoned key for an exact identity (profile included). */
export function tombstonedSessionKey(
  source: { handle: { db: Database.Database } },
  identity: NativeIdentityKey
): string | undefined {
  const { provider, profile, cwd, nativeId } = normalize(identity)
  const row = source.handle.db
    .prepare(
      `SELECT session_key FROM orch_binding
       WHERE provider = ? AND profile = ? AND cwd = ? AND native_id = ? AND deleted_at IS NOT NULL
       LIMIT 1`
    )
    .get(provider, profile, cwd, nativeId) as { session_key: string } | undefined
  return row?.session_key
}

/** B2: tombstone lookup by session key, used where the native id is not the session key. */
export function isSessionKeyTombstoned(
  source: { handle: { db: Database.Database } },
  sessionKey: string
): boolean {
  return Boolean(
    source.handle.db
      .prepare('SELECT 1 FROM orch_binding WHERE session_key = ? AND deleted_at IS NOT NULL LIMIT 1')
      .get(sessionKey)
  )
}

/** True when any profile of this provider+cwd identity has a tombstone. */
export function anySourceTombstone(
  source: { handle: { db: Database.Database } },
  identity: NativeIdentityKey
): boolean {
  const { provider, cwd, nativeId } = normalize(identity)
  return Boolean(
    source.handle.db
      .prepare(
        `SELECT 1 FROM orch_binding
         WHERE provider = ? AND cwd = ? AND native_id = ? AND deleted_at IS NOT NULL LIMIT 1`
      )
      .get(provider, cwd, nativeId)
  )
}

/**
 * B3: projects the native identity of a session into the binding table. `INSERT OR IGNORE` keeps
 * the first key for an identity; a session that is already tombstoned stays tombstoned.
 */
export function projectSessionBinding(
  db: Database.Database,
  input: {
    sessionKey: string
    provider: string | null
    profile: string | null
    cwd: string | null
    catalog: unknown
    at: number
  }
): void {
  const catalog = input.catalog as { nativeSessionId?: unknown } | null | undefined
  const nativeId = typeof catalog?.nativeSessionId === 'string' ? catalog.nativeSessionId : undefined
  if (!nativeId) return
  db.prepare(
    `INSERT OR IGNORE INTO orch_binding (provider, profile, cwd, native_id, session_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    input.provider ?? 'legacy_unknown',
    input.profile ?? '',
    input.cwd ?? '',
    nativeId,
    input.sessionKey,
    input.at
  )
}
