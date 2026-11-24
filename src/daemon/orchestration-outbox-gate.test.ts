import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createOutboxGate } from './orchestration-outbox-gate'

const PEER_A = `peer:${'a'.repeat(64)}`

// B1/A4: the dispatcher runs stop and question-answer effects from the same queue as run starts.
// A claim filtered to `provider.run.start` leaves every stop unclaimed forever, and because the
// run is already terminal nothing ever retries it.

function withDb(run: (db: Database.Database) => void): void {
  const userData = mkdtempSync(join(tmpdir(), 'scry-gate-'))
  const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
  try {
    run(sink.handle.db)
  } finally {
    sink.close()
    rmSync(userData, { recursive: true, force: true })
  }
}

function insertEffect(db: Database.Database, effectId: string, kind: string, seq: number): void {
  db.prepare(
    `INSERT INTO orch_outbox (effect_id, kind, policy, run_id, session_key, causation_seq, payload, state, attempts, expires_at)
     VALUES (?, ?, 'must', 'run-1', 'sess-1', ?, '{}', 'pending', 0, NULL)`
  ).run(effectId, kind, seq)
}

describe('B1: the dispatch gate claims every kind the dispatcher can execute', () => {
  it('claims a provider.run.stop effect, not only run starts', () => {
    withDb((db) => {
      insertEffect(db, 'e-stop', 'provider.run.stop', 1)
      const claimed = createOutboxGate(() => db).claim('daemon-1', Date.now())
      expect(claimed.effect?.kind).toBe('provider.run.stop')
      expect(claimed.effect?.effectId).toBe('e-stop')
    })
  })

  it('claims in causation order so stop never overtakes its own start', () => {
    withDb((db) => {
      insertEffect(db, 'e-stop', 'provider.run.stop', 5)
      insertEffect(db, 'e-answer', 'question.respond', 9)
      const gate = createOutboxGate(() => db)
      expect(gate.claim('daemon-1', Date.now()).effect?.effectId).toBe('e-stop')
    })
  })
})
