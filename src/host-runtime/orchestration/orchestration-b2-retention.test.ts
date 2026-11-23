import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { pruneOrchestrationInDb } from './orchestration-retention'

const HOUR = 3_600_000

function withSink(run: (sink: EventSink) => void): void {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-b2-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    run(sink)
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function appendEvent(sink: EventSink, at: number, stream: string, type: string, payload: object): void {
  sink.handle.db
    .prepare(
      `INSERT INTO orch_event (event_id, at, type, stream, session_key, run_id, cwd, command_id, actor, scope, payload, principal)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 'system', 'system', ?, 'system')`
    )
    .run(`evt-${stream}-${type}-${at}`, at, type, stream, stream.startsWith('run:') ? stream.slice(4) : null, canonicalJson(payload))
}

describe('B2: retention', () => {
  it('writes pruned_through before deleting and honours batches', () => {
    withSink((sink) => {
      const now = 100 * HOUR
      for (let i = 0; i < 7; i += 1) appendEvent(sink, now - (20 - i) * HOUR, `stream:${i}`, 'noop', { i })
      // Every stream keeps its head, so add a second event per stream that may be pruned.
      for (let i = 0; i < 7; i += 1) appendEvent(sink, now - (20 - i) * HOUR, `stream:${i}`, 'newer', { i })
      sink.handle.db
        .prepare("INSERT OR REPLACE INTO orch_meta (key, value) VALUES ('projection_applied_seq', '14')")
        .run()
      const before = sink.handle.db.prepare('SELECT COUNT(*) FROM orch_event').pluck().get() as number
      const report = pruneOrchestrationInDb(sink.handle.db, {
        now,
        eventRetentionMs: 10 * HOUR,
        batchSize: 3
      })
      expect(report.deletedEvents).toBe(7)
      expect(report.batches).toBeGreaterThan(1)
      // Watermark precedes deletion, so a crash mid-prune can only under-prune.
      expect(report.wroteWatermarkFirst).toBe(true)
      const after = sink.handle.db.prepare('SELECT COUNT(*) FROM orch_event').pluck().get() as number
      expect(after).toBeLessThan(before)
      const watermark = sink.handle.db
        .prepare("SELECT value FROM orch_meta WHERE key = 'pruned_through'")
        .pluck()
        .get() as string
      expect(Number(watermark)).toBeGreaterThan(0)
    })
  })

  it('keeps the head of every stream and never prunes past the applied projection position', () => {
    withSink((sink) => {
      const now = 100 * HOUR
      appendEvent(sink, now - 30 * HOUR, 'session:a', 'older', {})
      appendEvent(sink, now - 29 * HOUR, 'session:b', 'older', {})
      // Projection has applied nothing yet: pruning is not allowed to run ahead of it.
      expect(pruneOrchestrationInDb(sink.handle.db, { now, eventRetentionMs: HOUR }).deletedEvents).toBe(0)

      appendEvent(sink, now - 2 * HOUR, 'session:a', 'newer', {})
      appendEvent(sink, now - 2 * HOUR, 'session:b', 'newer', {})
      const applied = sink.handle.db.prepare('SELECT MAX(seq) FROM orch_event').pluck().get() as number
      sink.handle.db
        .prepare("INSERT OR REPLACE INTO orch_meta (key, value) VALUES ('projection_applied_seq', ?)")
        .run(String(applied))
      const report = pruneOrchestrationInDb(sink.handle.db, { now, eventRetentionMs: HOUR })
      // One head per stream survives even though it is older than the cutoff.
      expect(report.deletedEvents).toBe(2)
      const kept = sink.handle.db.prepare('SELECT stream, type FROM orch_event ORDER BY stream, seq').all()
      expect(kept).toEqual([
        { stream: 'session:a', type: 'newer' },
        { stream: 'session:b', type: 'newer' }
      ])
    })
  })

  it('keeps events still referenced by a live outbox row', () => {
    withSink((sink) => {
      const now = 100 * HOUR
      appendEvent(sink, now - 30 * HOUR, 'run:r1', 'run.admitted', {})
      appendEvent(sink, now - 30 * HOUR, 'run:r1', 'run.progress', {})
      appendEvent(sink, now - 30 * HOUR, 'run:r1', 'run.dispatched', {})
      appendEvent(sink, now - 30 * HOUR, 'run:r2', 'run.admitted', {})
      appendEvent(sink, now - 30 * HOUR, 'run:r2', 'run.progress', {})
      appendEvent(sink, now - 5 * HOUR, 'run:r2', 'run.dispatched', {})
      sink.handle.db
        .prepare(
          `INSERT INTO orch_outbox (effect_id, kind, policy, run_id, causation_seq, payload, state, claimed_at)
           VALUES ('ob-1', 'provider.run.start', 'process_bound', 'r1', 3, '{"runId":"r1"}', 'running', ?)`
        )
        .run(now - 30 * HOUR)

      sink.handle.db
        .prepare("INSERT OR REPLACE INTO orch_meta (key, value) VALUES ('projection_applied_seq', '6')")
        .run()
      const report = pruneOrchestrationInDb(sink.handle.db, { now, eventRetentionMs: HOUR })
      const remaining = sink.handle.db.prepare('SELECT run_id, type FROM orch_event ORDER BY seq').all()
      // Everything before the live effect's causation seq anchors it and survives with the heads.
      expect(remaining).toEqual([
        { run_id: 'r1', type: 'run.admitted' },
        { run_id: 'r1', type: 'run.progress' },
        { run_id: 'r1', type: 'run.dispatched' },
        { run_id: 'r2', type: 'run.dispatched' }
      ])
      expect(report.deletedEvents).toBe(2)
    })
  })

  it('prunes finished outbox rows after 72h and dead rows after 30 days', () => {
    withSink((sink) => {
      const now = 1000 * HOUR
      const insert = sink.handle.db.prepare(
        `INSERT INTO orch_outbox (effect_id, kind, policy, causation_seq, payload, state, completed_at)
         VALUES (?, 'provider.run.start', 'process_bound', 1, '{}', ?, ?)`
      )
      insert.run('done-old', 'done', now - 80 * HOUR)
      insert.run('done-fresh', 'done', now - 4 * HOUR)
      insert.run('failed-old', 'failed', now - 31 * 24 * HOUR)
      insert.run('failed-fresh', 'failed', now - 2 * 24 * HOUR)
      insert.run('voided-old', 'voided', now - 31 * 24 * HOUR)
      insert.run('pending-old', 'pending', null)

      const report = pruneOrchestrationInDb(sink.handle.db, { now, eventRetentionMs: HOUR })
      expect(report.deletedOutbox).toBe(3)
      const left = sink.handle.db.prepare('SELECT effect_id FROM orch_outbox ORDER BY effect_id').all()
      expect(left).toEqual([{ effect_id: 'done-fresh' }, { effect_id: 'failed-fresh' }, { effect_id: 'pending-old' }])
    })
  })

  it('clears inline prompts once an outbox row is no longer dispatchable', () => {
    withSink((sink) => {
      const now = 100 * HOUR
      const payload = canonicalJson({
        runId: 'r1',
        body: { storage: 'inline', sha256: sha256Hex('prompt'), bytes: 6, inline: 'secret' }
      })
      sink.handle.db
        .prepare(
          `INSERT INTO orch_outbox (effect_id, kind, policy, run_id, causation_seq, payload, state, completed_at)
           VALUES ('ob-done', 'provider.run.start', 'process_bound', 'r1', 1, ?, 'done', ?)`
        )
        .run(payload, now)

      const report = pruneOrchestrationInDb(sink.handle.db, { now, eventRetentionMs: HOUR })
      expect(report.clearedInlineBodies).toBe(1)
      const stored = sink.handle.db.prepare('SELECT payload FROM orch_outbox WHERE effect_id = ?').pluck().get('ob-done')
      expect(String(stored)).not.toContain('secret')
      expect(JSON.parse(String(stored)).body).toEqual({
        storage: 'inline',
        sha256: sha256Hex('prompt'),
        bytes: 6
      })
    })
  })

  it('queues terminal run bodies for erasure instead of keeping them forever', () => {
    withSink((sink) => {
      const now = 100 * HOUR
      sink.handle.db
        .prepare(
          `INSERT INTO orch_p_run (run_id, owner_actor, scope, origin, provider, profile, cwd, lifecycle, rev_seq, intent_seq, body, settled_at)
           VALUES ('r-old', 'system', 'system', 'local', 'codex', NULL, '/tmp/ws', 'settled', 5, 1, ?, ?)`
        )
        .run(canonicalJson({ storage: 'external', sha256: 'a'.repeat(64), bytes: 10 }), now - 40 * 24 * HOUR)
      sink.handle.db
        .prepare(
          `INSERT INTO orch_p_run (run_id, owner_actor, scope, origin, provider, profile, cwd, lifecycle, rev_seq, intent_seq, body)
           VALUES ('r-live', 'system', 'system', 'local', 'codex', NULL, '/tmp/ws', 'running', 5, 1, ?)`
        )
        .run(canonicalJson({ storage: 'external', sha256: 'b'.repeat(64), bytes: 10 }))

      const report = pruneOrchestrationInDb(sink.handle.db, { now, eventRetentionMs: HOUR })
      expect(report.queuedBodyErasures).toBe(1)
      const queued = sink.handle.db.prepare('SELECT session_key, sha256 FROM orch_body_erase').all()
      expect(queued).toEqual([{ session_key: 'run:r-old', sha256: 'a'.repeat(64) }])
    })
  })
})

describe('B4: receipt growth', () => {
  it('prunes system and effect receipts with events but keeps device, user and resolveIntent rows', () => {
    withSink((sink) => {
      const now = 1000 * HOUR
      const insert = sink.handle.db.prepare(
        `INSERT INTO orch_command (command_id, actor, type, payload_sha256, accepted_at, status, reason, result, result_seq, principal)
         VALUES (?, ?, ?, 'x', ?, 'accepted', NULL, NULL, NULL, ?)`
      )
      insert.run('sys-old', 'system', 'session.discover', now - 40 * 24 * HOUR, 'system')
      insert.run('effect-old', 'effect:native-bind', 'run.effect_result', now - 40 * 24 * HOUR, 'system')
      insert.run('peer-old', 'peer:abc', 'run.submit', now - 40 * 24 * HOUR, 'peer:abc')
      insert.run('user-old', 'local-user', 'run.stop', now - 40 * 24 * HOUR, 'local-user')
      insert.run('intent-old', 'system', 'run.resolve_intent', now - 40 * 24 * HOUR, 'system')

      const report = pruneOrchestrationInDb(sink.handle.db, { now, eventRetentionMs: HOUR })
      expect(report.deletedReceipts).toBe(2)
      const left = sink.handle.db.prepare('SELECT command_id FROM orch_command ORDER BY command_id').all()
      expect(left).toEqual([
        { command_id: 'intent-old' },
        { command_id: 'peer-old' },
        { command_id: 'user-old' }
      ])
    })
  })
})
