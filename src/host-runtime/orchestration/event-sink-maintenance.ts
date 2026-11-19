import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { canonicalJson } from './canonical-json'
import { migrateOrchestrationDatabase } from './migrations'
import { applyEventToProjection } from './projection'
import { ORCHESTRATION_MIGRATIONS } from './schema'
import type { OrchestrationEventRow, OrchestrationScope } from './types'

const require = createRequire(import.meta.url)

export interface DeleteSessionInput {
  sessionKey: string
  cwd: string
  actor: string
  scope: OrchestrationScope
  at: number
}

export type DeleteSessionOutcome =
  | { status: 'deleted'; deletedBodies: number; redactedEvents: number }
  | { status: 'not_present' }
  | { status: 'unavailable'; error: string }

/**
 * data §4.7: atomically emit `session.deleted` tombstone, drop projections/outbox,
 * redact historical event preview payloads to `{"redacted":true}`, and return
 * unreferenced external body sha256s for post-commit unlink.
 */
export function deleteSessionInDb(
  db: Database.Database,
  input: DeleteSessionInput,
  beforeCommitHook?: () => void
): { existed: boolean; unreferencedShas: string[]; redactedEvents: number } {
  let unreferencedShas: string[] = []
  let redactedEvents = 0
  let existed = false

  const tx = db.transaction(() => {
    const sessionRow = db
      .prepare('SELECT 1 FROM orch_p_session WHERE session_key = ?')
      .get(input.sessionKey)
    const eventRow = db
      .prepare('SELECT 1 FROM orch_event WHERE session_key = ? LIMIT 1')
      .get(input.sessionKey)
    if (!sessionRow && !eventRow) return
    existed = true

    const runRows = db
      .prepare('SELECT run_id, body FROM orch_p_run WHERE session_key = ?')
      .all(input.sessionKey) as Array<{ run_id: string; body: string | null }>
    const candidateShas = new Set<string>()
    for (const r of runRows) {
      if (!r.body) continue
      const parsed = JSON.parse(r.body) as { storage?: string; sha256?: string }
      if (parsed.storage === 'external' && parsed.sha256) candidateShas.add(parsed.sha256)
    }

    const redacted = db
      .prepare("UPDATE orch_event SET payload = '{\"redacted\":true}' WHERE session_key = ? AND type != 'session.deleted'")
      .run(input.sessionKey)
    redactedEvents = redacted.changes

    db.prepare(
      'DELETE FROM orch_outbox WHERE run_id IN (SELECT run_id FROM orch_p_run WHERE session_key = ?)'
    ).run(input.sessionKey)

    const tombstonePayload = canonicalJson({ sessionKey: input.sessionKey, cwd: input.cwd })
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
      payload: { sessionKey: input.sessionKey, cwd: input.cwd },
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
    }
    unreferencedShas = [...candidateShas].filter((sha) => !stillReferenced.has(sha))
    beforeCommitHook?.()
  })
  tx()

  return { existed, unreferencedShas, redactedEvents }
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
