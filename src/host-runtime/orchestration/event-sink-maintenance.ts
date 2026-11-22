import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../../main/run-registry'
import type { BodyStore } from './body-store'
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
  /** Run IDs verified by the host's deletion scope before an older run had a projected key. */
  unboundRunIds?: readonly string[]
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
      .prepare('SELECT provider, profile, cwd FROM orch_p_session WHERE session_key = ?')
      .get(input.sessionKey) as { provider: string | null; profile: string | null; cwd: string | null } | undefined
    const eventRow = db
      .prepare(`SELECT 1 FROM orch_event WHERE session_key = ? AND type != 'session.deleted'
                AND json_extract(payload, '$.redacted') IS NOT 1 LIMIT 1`)
      .get(input.sessionKey)
    if (!sessionRow && !eventRow) return
    existed = true

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
      const activeOutbox = db
        .prepare("SELECT payload FROM orch_outbox WHERE state IN ('pending', 'running')")
        .all() as Array<{ payload: string }>
      for (const row of activeOutbox) {
        for (const sha of candidateShas) {
          if (row.payload.includes(sha)) stillReferenced.add(sha)
        }
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
): void {
  if (bodyStore.isPinned(sha256)) return
  const surviving = db
    .prepare('SELECT body FROM orch_p_run WHERE body IS NOT NULL')
    .all() as Array<{ body: string }>
  for (const row of surviving) {
    const parsed = JSON.parse(row.body) as { storage?: string; sha256?: string }
    if (parsed.storage === 'external' && parsed.sha256 === sha256) return
  }
  const activeOutbox = db
    .prepare("SELECT payload FROM orch_outbox WHERE state IN ('pending', 'running')")
    .all() as Array<{ payload: string }>
  for (const row of activeOutbox) {
    if (row.payload.includes(sha256)) return
  }
  bodyStore.unlinkBody(sha256)
}
