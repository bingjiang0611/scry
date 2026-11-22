import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../../main/run-registry'
import type { BodyStore } from './body-store'
import { canonicalJson } from './canonical-json'
import { migrateOrchestrationDatabase } from './migrations'
import { applyEventToProjection } from './projection'
import { ORCHESTRATION_MIGRATIONS } from './schema'
import { catalogFrontierKey } from './transcript-interval'
import type { OrchestrationEventRow, OrchestrationScope } from './types'

const require = createRequire(import.meta.url)

export interface DeleteSessionInput {
  sessionKey: string
  cwd: string
  actor: string
  scope: OrchestrationScope
  at: number
  /** Run IDs verified by the host's deletion scope before an older run had a projected key. */
  unboundRunIds?: readonly string[]
  nativeIdentity?: string
  nativeSource?: string
}

export type DeleteSessionOutcome =
  | { status: 'deleted'; deletedBodies: number; redactedEvents: number }
  | { status: 'not_present' }
  | { status: 'unavailable'; error: string }

/**
 * data §4.7: atomically emit `session.deleted` tombstone, drop projections/outbox,
 * redact historical event preview payloads to `{"redacted":true}`, and return
 * unreferenced external body sha256s for crash-safe post-commit unlink.
 */
export function deleteSessionInDb(
  db: Database.Database,
  input: DeleteSessionInput,
  beforeCommitHook?: () => void
): { existed: boolean; redactedEvents: number } {
  let redactedEvents = 0
  let existed = false

  const tx = db.transaction(() => {
    const sessionRow = db
      .prepare('SELECT provider, profile, cwd FROM orch_p_session WHERE session_key = ?')
      .get(input.sessionKey) as { provider: string | null; profile: string | null; cwd: string | null } | undefined
    const eventRow = db
      .prepare(`SELECT 1 FROM orch_event WHERE session_key = ? AND type != 'session.deleted'
                AND json_extract(payload, '$.redacted') IS NOT 1 LIMIT 1`)
      .get(input.sessionKey)
    if (!sessionRow && !eventRow) return
    existed = true
    db.prepare('DELETE FROM orch_meta WHERE key = ?').run(catalogFrontierKey(input.sessionKey))
    db.prepare('DELETE FROM orch_meta WHERE key = ?').run(`conversation_catalog:${input.sessionKey}`)

    const runRows = db
      .prepare(
        `SELECT run_id, body FROM orch_p_run WHERE session_key = ?
           OR (session_key IS NULL AND provider IS ? AND profile IS ? AND cwd = ?
              AND run_id IN (SELECT value FROM json_each(?)))`
      )
      .all(
        input.sessionKey, sessionRow?.provider ?? null, sessionRow?.profile ?? null, sessionRow?.cwd ?? null,
        canonicalJson(sessionRow ? input.unboundRunIds ?? [] : [])
      ) as Array<{ run_id: string; body: string | null }>
    const runIds = canonicalJson(runRows.map((row) => row.run_id))
    const candidateShas = new Set<string>()
    for (const r of runRows) {
      if (!r.body) continue
      const parsed = JSON.parse(r.body) as { storage?: string; sha256?: string }
      if (parsed.storage === 'external' && parsed.sha256) candidateShas.add(parsed.sha256)
    }

    const redacted = db.prepare(
      `UPDATE orch_event SET payload = '{"redacted":true}'
       WHERE type != 'session.deleted' AND (session_key = ? OR run_id IN (SELECT value FROM json_each(?)))`
    ).run(input.sessionKey, runIds)
    redactedEvents = redacted.changes

    for (const table of ['orch_outbox', 'orch_p_interaction', 'orch_p_turn', 'orch_p_run']) {
      db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?))`).run(runIds)
    }

    const tombstone = {
      sessionKey: input.sessionKey, cwd: input.cwd,
      ...(input.nativeIdentity ? { nativeIdentity: input.nativeIdentity } : {}),
      ...(input.nativeSource ? { nativeSource: input.nativeSource } : {})
    }
    const tombstonePayload = canonicalJson(tombstone)
    const info = db
      .prepare(
        `INSERT INTO orch_event (
          event_id, at, type, stream, session_key, run_id, cwd, command_id,
          actor, scope, payload, evidence, principal, via, actor_run_id
        ) VALUES (?, ?, 'session.deleted', ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, ?, NULL, NULL)`
      )
      .run(
        randomUUID(),
        input.at,
        `session:${input.sessionKey}`,
        input.sessionKey,
        input.cwd,
        input.actor,
        input.scope,
        tombstonePayload,
        input.actor
      )
    applyEventToProjection(db, {
      seq: Number(info.lastInsertRowid),
      eventId: '',
      at: input.at,
      type: 'session.deleted',
      stream: `session:${input.sessionKey}`,
      sessionKey: input.sessionKey,
      runId: null,
      cwd: input.cwd,
      commandId: null,
      actor: input.actor,
      scope: input.scope,
      payload: tombstone,
      evidence: null,
      principal: input.actor,
      via: null,
      actorRunId: null
    })

    const stillReferenced = new Set<string>()
    if (candidateShas.size > 0) {
      const surviving = db
        .prepare('SELECT body FROM orch_p_run WHERE body IS NOT NULL')
        .all() as Array<{ body: string }>
      for (const row of surviving) {
        const parsed = JSON.parse(row.body) as { storage?: string; sha256?: string }
        if (parsed.storage === 'external' && parsed.sha256) stillReferenced.add(parsed.sha256)
      }
      const activeOutbox = db
        .prepare("SELECT payload FROM orch_outbox WHERE state IN ('pending', 'running')")
        .all() as Array<{ payload: string }>
      for (const row of activeOutbox) {
        for (const sha of candidateShas) {
          if (row.payload.includes(sha)) stillReferenced.add(sha)
        }
      }
    }
    if (candidateShas.size > 0) {
      const pendingErase = db.prepare('INSERT OR IGNORE INTO orch_body_erase (session_key, sha256) VALUES (?, ?)')
      for (const sha of candidateShas) {
        if (!stillReferenced.has(sha)) pendingErase.run(input.sessionKey, sha)
      }
    }
    beforeCommitHook?.()
  })
  tx()

  return { existed, redactedEvents }
}

/**
 * data §4.8: prune events older than `olderThanAt` while retaining the latest event per stream
 * and updating `pruned_through` in the same transaction. Receipts are NEVER pruned.
 */
export function pruneEventsInDb(
  db: Database.Database,
  olderThanAt: number,
  currentPrunedThrough: number
): { deletedEvents: number; prunedThrough: number } {
  let deletedEvents = 0
  let prunedThrough = currentPrunedThrough
  const tx = db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT e.seq FROM orch_event e
         WHERE e.at < ?
           AND e.seq < (SELECT MAX(e2.seq) FROM orch_event e2 WHERE e2.stream = e.stream)`
      )
      .all(olderThanAt) as Array<{ seq: number }>
    if (candidates.length === 0) return
    const maxPruned = candidates.reduce((acc, row) => Math.max(acc, row.seq), prunedThrough)
    const del = db.prepare('DELETE FROM orch_event WHERE seq = ?')
    for (const row of candidates) {
      del.run(row.seq)
      deletedEvents += 1
    }
    prunedThrough = maxPruned
    db.prepare("INSERT OR REPLACE INTO orch_meta (key, value) VALUES ('pruned_through', ?)").run(
      String(prunedThrough)
    )
  })
  tx()
  return { deletedEvents, prunedThrough }
}

/** Verifies that replaying all events from empty equals online projections (plan §10). */
export function verifyReplayConsistencyInDb(
  db: Database.Database,
  events: OrchestrationEventRow[]
): { matches: boolean; diff?: string } {
  const DatabaseCtor = require('better-sqlite3') as typeof import('better-sqlite3')
  const mem = new DatabaseCtor(':memory:')
  try {
    migrateOrchestrationDatabase(mem, ORCHESTRATION_MIGRATIONS)
    for (const evt of events) {
      applyEventToProjection(mem, evt)
    }
    const tables = ['orch_p_session', 'orch_p_turn', 'orch_p_run', 'orch_p_interaction'] as const
    for (const table of tables) {
      const actual = canonicalJson(db.prepare(`SELECT * FROM ${table}`).all())
      const replayed = canonicalJson(mem.prepare(`SELECT * FROM ${table}`).all())
      if (actual !== replayed) {
        return { matches: false, diff: `${table} mismatch:\nactual=${actual}\nreplayed=${replayed}` }
      }
    }
    return { matches: true }
  } finally {
    mem.close()
  }
}

/**
 * core §2.5 + R5: tightening-only stop bypasses the storage fence without touching SQLite
 * and cascades along in-memory `RunRegistryState.parentRunId` edges.
 */
export function stopRunBypassingFenceInRegistry<
  State extends RunRegistryState,
  Control extends RunRegistryControl
>(
  runId: string,
  registry: RunRegistry<State, Control>,
  stopControl: (control: Control) => void
): string[] {
  const visited = new Set<string>()
  const queue = [runId]
  const stopped: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    const entry = registry.get(current)
    if (entry && !entry.state.done) {
      stopControl(entry.control)
      stopped.push(current)
    }
    for (const active of registry.activeStates()) {
      if (active.parentRunId === current && !visited.has(active.runId)) {
        queue.push(active.runId)
      }
    }
  }
  return stopped
}

export function unlinkUnreferencedExternalBodyInDb(
  db: Database.Database,
  bodyStore: BodyStore,
  sha256: string
): 'pinned' | 'referenced' | 'erased' {
  if (bodyStore.isPinned(sha256)) return 'pinned'
  const surviving = db
    .prepare('SELECT body FROM orch_p_run WHERE body IS NOT NULL')
    .all() as Array<{ body: string }>
  for (const row of surviving) {
    const parsed = JSON.parse(row.body) as { storage?: string; sha256?: string }
    if (parsed.storage === 'external' && parsed.sha256 === sha256) return 'referenced'
  }
  const activeOutbox = db
    .prepare("SELECT payload FROM orch_outbox WHERE state IN ('pending', 'running')")
    .all() as Array<{ payload: string }>
  for (const row of activeOutbox) {
    if (row.payload.includes(sha256)) return 'referenced'
  }
  bodyStore.unlinkBody(sha256)
  return 'erased'
}

export function resumeBodyErasure(
  db: Database.Database,
  bodyStore: BodyStore,
  options: { sessionKey?: string; sha256?: string; canWrite?: () => boolean } = {}
): { completed: number; erased: number; deferred: number; error?: string } {
  const select = 'SELECT session_key, sha256 FROM orch_body_erase'
  const rows = (options.sessionKey !== undefined ? db.prepare(`${select} WHERE session_key = ?`).all(options.sessionKey)
    : options.sha256 !== undefined ? db.prepare(`${select} WHERE sha256 = ?`).all(options.sha256)
    : db.prepare(select).all()) as Array<{ session_key: string; sha256: string }>
  const clear = db.prepare('DELETE FROM orch_body_erase WHERE session_key = ? AND sha256 = ?')
  let completed = 0
  let erased = 0
  let deferred = 0
  let error: string | undefined
  for (const row of rows) {
    try {
      const result = unlinkUnreferencedExternalBodyInDb(db, bodyStore, row.sha256)
      if (result === 'pinned') {
        // The deleting session has no remaining references. A concurrent submit
        // still owns the bytes until commit or abandonment. Retain the durable
        // erasure queue through that boundary and recheck all surviving owners.
        bodyStore.eraseAfterUnpin(row.sha256, () => {
          if (!db.open || options.canWrite?.() === false) return
          try {
            const next = resumeBodyErasure(db, bodyStore, { sha256: row.sha256, canWrite: options.canWrite })
            if (next.error) console.warn('[scry] orchestration body erasure pending:', next.error)
          } catch (failure) {
            console.warn('[scry] orchestration body erasure pending:', failure)
          }
        })
        deferred += 1
        continue
      }
      clear.run(row.session_key, row.sha256)
      completed += 1
      if (result === 'erased') erased += 1
    } catch (failure) {
      error ??= failure instanceof Error ? failure.message : String(failure)
    }
  }
  return { completed, erased, deferred, ...(error ? { error } : {}) }
}
