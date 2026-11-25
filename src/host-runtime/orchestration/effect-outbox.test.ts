import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { EventSink } from './event-sink'
import {
  claimNextEffect,
  deferEffect,
  failEffect,
  retryEffect,
  runEffectWorkerPass,
  succeedEffect,
  OUTBOX_LEASE_MS
} from './effect-outbox'

function withSink(run: (sink: EventSink) => void): void {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-b1-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    run(sink)
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function enqueue(
  sink: EventSink,
  effectId: string,
  options: { sessionKey?: string; causationSeq: number; payload?: object; state?: string } = { causationSeq: 1 }
): void {
  sink.handle.db
    .prepare(
      `INSERT INTO orch_outbox (effect_id, kind, policy, run_id, causation_seq, payload, state, session_key)
       VALUES (?, 'provider.run.start', 'process_bound', NULL, ?, ?, ?, ?)`
    )
    .run(
      effectId,
      options.causationSeq,
      JSON.stringify(options.payload ?? { runId: effectId, sessionKey: options.sessionKey ?? null }),
      options.state ?? 'pending',
      options.sessionKey ?? null
    )
}

it('claims the oldest effect once and hands out a lease with an incremented attempt', () => {
  withSink((sink) => {
    enqueue(sink, 'e1', { sessionKey: 'sess-a', causationSeq: 1 })
    enqueue(sink, 'e2', { sessionKey: 'sess-b', causationSeq: 2 })
    const first = claimNextEffect({ db: sink.handle.db, owner: 'worker-a', now: 100 }).effect
    expect(first).toMatchObject({ effectId: 'e1', attempts: 1, leaseOwner: 'worker-a' })
    const second = claimNextEffect({ db: sink.handle.db, owner: 'worker-b', now: 101 }).effect
    expect(second).toMatchObject({ effectId: 'e2', attempts: 1, leaseOwner: 'worker-b' })
    expect(claimNextEffect({ db: sink.handle.db, owner: 'worker-c', now: 102 }).effect).toBeUndefined()
  })
})

it('keeps one in-flight effect per session so a later effect cannot overtake it', () => {
  withSink((sink) => {
    enqueue(sink, 'a1', { sessionKey: 'sess-a', causationSeq: 1 })
    enqueue(sink, 'a2', { sessionKey: 'sess-a', causationSeq: 2 })
    enqueue(sink, 'b1', { sessionKey: 'sess-b', causationSeq: 3 })
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 10 }).effect?.effectId).toBe('a1')
    // a2 must wait for a1, but another session is free to run in parallel.
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 11 }).effect?.effectId).toBe('b1')
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 12 }).effect).toBeUndefined()
    expect(succeedEffect({ db: sink.handle.db, effectId: 'a1', owner: 'w', now: 13, resultSeq: 5 })).toBe(true)
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 14 }).effect?.effectId).toBe('a2')
  })
})

it('requires the lease owner to settle, retry or fail an effect', () => {
  withSink((sink) => {
    enqueue(sink, 'e1', { causationSeq: 1 })
    claimNextEffect({ db: sink.handle.db, owner: 'worker-a', now: 10 })
    expect(succeedEffect({ db: sink.handle.db, effectId: 'e1', owner: 'worker-b', now: 11, resultSeq: 1 })).toBe(false)
    expect(failEffect({ db: sink.handle.db, effectId: 'e1', owner: 'worker-b', now: 11, reason: 'x' })).toBe(false)
    expect(retryEffect({ db: sink.handle.db, effectId: 'e1', owner: 'worker-b', now: 11, reason: 'x' }).status).toBe(
      'lease_lost'
    )
    expect(succeedEffect({ db: sink.handle.db, effectId: 'e1', owner: 'worker-a', now: 12, resultSeq: 9 })).toBe(true)
    const row = sink.handle.db.prepare('SELECT state, result_seq, lease_owner FROM orch_outbox WHERE effect_id = ?').get('e1')
    expect(row).toEqual({ state: 'done', result_seq: 9, lease_owner: null })
  })
})

it('retries with exponential backoff and gives up after five attempts', () => {
  withSink((sink) => {
    enqueue(sink, 'e1', { causationSeq: 1 })
    const delays: number[] = []
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = claimNextEffect({ db: sink.handle.db, owner: 'w', now: attempt * 1000 }).effect
      expect(claimed?.attempts).toBe(attempt)
      const outcome = retryEffect({ db: sink.handle.db, effectId: 'e1', owner: 'w', now: attempt * 1000, reason: 'boom' })
      if (outcome.status === 'retry') {
        delays.push(outcome.delayMs)
        expect(outcome.delayMs).toBe(Math.min(30_000, 100 * 2 ** (attempt - 1)))
      } else {
        expect(outcome.status).toBe('exhausted')
      }
    }
    // The fifth attempt is the last one: it fails instead of returning another delay.
    expect(delays).toEqual([100, 200, 400, 800])
    const row = sink.handle.db.prepare('SELECT state, last_error, lease_owner FROM orch_outbox WHERE effect_id = ?').get('e1')
    expect(row).toEqual({ state: 'failed', last_error: 'boom', lease_owner: null })
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 10_000 }).effect).toBeUndefined()
  })
})

it('fails an undecodable effect without blocking the queue', () => {
  withSink((sink) => {
    sink.handle.db
      .prepare(
        `INSERT INTO orch_outbox (effect_id, kind, policy, causation_seq, payload, state, session_key)
         VALUES ('broken', 'provider.run.start', 'process_bound', 1, 'not json', 'pending', 'sess-a')`
      )
      .run()
    enqueue(sink, 'ok', { sessionKey: 'sess-a', causationSeq: 2 })
    const seen: string[] = []
    const report = runEffectWorkerPass({
      db: sink.handle.db,
      owner: 'w',
      now: () => 100,
      execute: (effect) => {
        seen.push(effect.effectId)
        return 'done'
      }
    })
    expect(seen).toEqual(['ok'])
    expect(report).toMatchObject({ claimed: 2, failed: 1, completed: 1 })
    const broken = sink.handle.db.prepare('SELECT state, last_error FROM orch_outbox WHERE effect_id = ?').get('broken')
    expect(broken).toEqual({ state: 'failed', last_error: 'decode_failed' })
  })
})

it('skips expired effects and reports them as voided', () => {
  withSink((sink) => {
    sink.handle.db
      .prepare(
        `INSERT INTO orch_outbox (effect_id, kind, policy, causation_seq, payload, state, expires_at, session_key)
         VALUES ('expired', 'provider.run.start', 'process_bound', 1, '{"runId":"expired"}', 'pending', 50, NULL)`
      )
      .run()
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 100 }).effect).toBeUndefined()
    const row = sink.handle.db.prepare('SELECT state, last_error FROM orch_outbox WHERE effect_id = ?').get('expired')
    expect(row).toEqual({ state: 'voided', last_error: 'pending_expired' })
  })
})

it('R1: a deferred effect does not starve the other sessions', () => {
  withSink((sink) => {
    enqueue(sink, 'a1', { sessionKey: 'sess-a', causationSeq: 1 })
    enqueue(sink, 'b1', { sessionKey: 'sess-b', causationSeq: 2 })
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 1_000 }).effect?.effectId).toBe('a1')
    // The gate holds session A (its run is still live), so the row goes back with a backoff.
    expect(
      deferEffect({ db: sink.handle.db, effectId: 'a1', owner: 'w', reason: 'queue_held', now: 1_000, delayMs: 500 })
    ).toBe(true)
    // Before the backoff elapses the queue must move on: the old behaviour re-claimed a1 forever.
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 1_010 }).effect?.effectId).toBe('b1')
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 1_010 }).effect).toBeUndefined()
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 1_500 }).effect?.effectId).toBe('a1')
  })
})

it('R1: a retried effect waits out its backoff before it can block another session again', () => {
  withSink((sink) => {
    enqueue(sink, 'a1', { sessionKey: 'sess-a', causationSeq: 1 })
    enqueue(sink, 'b1', { sessionKey: 'sess-b', causationSeq: 2 })
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 2_000 }).effect?.effectId).toBe('a1')
    expect(retryEffect({ db: sink.handle.db, effectId: 'a1', owner: 'w', now: 2_000, reason: 'auth_pending' })).toMatchObject({
      status: 'retry',
      delayMs: 100
    })
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 2_010 }).effect?.effectId).toBe('b1')
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 2_050 }).effect).toBeUndefined()
    expect(claimNextEffect({ db: sink.handle.db, owner: 'w', now: 2_100 }).effect?.effectId).toBe('a1')
  })
})

// R6: nothing reclaimed a row whose owner died mid-claim. It stayed `running` forever and, because a
// session queue counts `running` rows, it blocked every later effect of that session.
it('R6: reclaims a claimed effect whose lease expired and leaves a live lease alone', () => {
  withSink((sink) => {
    enqueue(sink, 'e1', { sessionKey: 'sess-a', causationSeq: 1 })
    enqueue(sink, 'e2', { sessionKey: 'sess-b', causationSeq: 2 })
    const db = sink.handle.db
    expect(claimNextEffect({ db, owner: 'dead-worker', now: 1_000 }).effect?.effectId).toBe('e1')

    // Still within the lease: the claim belongs to its owner and must not be stolen.
    expect(claimNextEffect({ db, owner: 'other', now: 1_000 + OUTBOX_LEASE_MS - 1 }).effect?.effectId).toBe('e2')
    expect(db.prepare("SELECT state, lease_owner FROM orch_outbox WHERE effect_id = 'e1'").get())
      .toEqual({ state: 'running', lease_owner: 'dead-worker' })

    // Past the lease: the row is claimable again, and the expired lease is recorded on the row.
    const reclaimed = claimNextEffect({ db, owner: 'worker-b', now: 1_000 + OUTBOX_LEASE_MS + 1 }).effect
    expect(reclaimed).toMatchObject({ effectId: 'e1', leaseOwner: 'worker-b', attempts: 2 })
    expect(db.prepare("SELECT last_error FROM orch_outbox WHERE effect_id = 'e1'").get())
      .toEqual({ last_error: 'lease_expired' })
  })
})
