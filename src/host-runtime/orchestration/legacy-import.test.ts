import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLedger } from '../../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../../main/remote/session-ledger-file'
import { EventSink } from './event-sink'
import { importLegacyStateIncrementally } from './legacy-import'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-legacy-import-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeLedgerDir(userDataDir: string): string {
  const dir = join(userDataDir, 'remote', 'ledger')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

describe('P4-1 off <-> shadow/on incremental import (plan §9 rule 1)', () => {
  it('imports H1 ledger + app-sessions.json incrementally across off -> shadow -> off -> shadow without duplicates', () => {
    withTempDir((userData) => {
      const ledgerDir = makeLedgerDir(userData)
      const t0 = 1_700_000_000_000

      // Phase 1: `off` mode writes 3 runs to H1 ledger + 1 session to app-sessions.json
      const runSettled = SessionLedger.newRunId()
      const runOrphanDispatched = SessionLedger.newRunId()
      const runExpiredRecorded = SessionLedger.newRunId()
      {
        const store = new SessionLedgerFileStore(ledgerDir)
        try {
          const ledger = new SessionLedger({ store, clock: () => t0 })
          ledger.recordIntent({
            intentId: SessionLedger.newIntentId(),
            runId: runSettled,
            detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: 'settled' })
          })
          ledger.markDispatched(runSettled)
          ledger.markSettled(runSettled)

          ledger.recordIntent({
            intentId: SessionLedger.newIntentId(),
            runId: runOrphanDispatched,
            detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: 'orphan' })
          })
          ledger.markDispatched(runOrphanDispatched)

          ledger.recordIntent({
            intentId: SessionLedger.newIntentId(),
            runId: runExpiredRecorded,
            detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: 'expired' })
          })
        } finally {
          store.close()
        }
      }

      writeFileSync(
        join(userData, 'app-sessions.json'),
        JSON.stringify([
          {
            sessionId: 'sess-legacy-1',
            providerId: 'codex',
            cwd: '/tmp/ws',
            title: 'Legacy Title',
            preview: 'hello',
            ts: t0,
            lastRunOutcome: 'completed'
          }
        ])
      )

      // Phase 2: Authoritative mode (reconcileOpenRuns: true, after TTL expired) -> incremental import
      {
        const sink = EventSink.open({ userDataDir: userData })
        try {
          const first = importLegacyStateIncrementally({
            sink,
            userDataDir: userData,
            now: t0 + 120_000,
            pendingTtlMs: 60_000,
            reconcileOpenRuns: true
          })
          expect(first.importedRuns).toBe(3)
          expect(first.importedSessions).toBe(1)

          expect(sink.getRun(runSettled)?.lifecycle).toBe('settled')
          // Dispatched without terminal -> interrupted with unavailable(host_restarted), settledAt=null
          const orphan = sink.getRun(runOrphanDispatched)
          expect(orphan?.lifecycle).toBe('interrupted')
          expect(orphan?.settledAt).toBeNull()
          expect(orphan?.outcome).toMatchObject({
            status: 'unavailable',
            quality: 'unavailable',
            omissionReason: 'host_restarted'
          })
          // Recorded + expired TTL -> cancelled(pending_expired)
          expect(sink.getRun(runExpiredRecorded)?.lifecycle).toBe('cancelled')

          // app-sessions.json imported with quality: inferred (never exact!)
          const sess = sink.getSession('sess-legacy-1')
          expect(sess?.legacy).toBe(true)
          expect(sess?.title).toBe('Legacy Title')
          expect(sess?.lastRunOutcome?.quality).toBe('inferred')

          // Re-running import in same session is a pure no-op (zero duplicates)
          const second = importLegacyStateIncrementally({
            sink,
            userDataDir: userData,
            now: t0 + 121_000,
            pendingTtlMs: 60_000,
            reconcileOpenRuns: true
          })
          expect(second.importedRuns).toBe(0)
          expect(second.importedSessions).toBe(0)
          expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
        } finally {
          sink.close()
        }
      }

      // Phase 3: Switch back to `off`, add 1 new H1 run and 1 new session in app-sessions.json
      const runFourth = SessionLedger.newRunId()
      {
        const store = new SessionLedgerFileStore(ledgerDir)
        try {
          const ledger = new SessionLedger({ store, clock: () => t0 + 200_000 })
          ledger.recordIntent({
            intentId: SessionLedger.newIntentId(),
            runId: runFourth,
            detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: 'fourth' })
          })
          ledger.markDispatched(runFourth)
          ledger.markSettled(runFourth)
        } finally {
          store.close()
        }
      }
      writeFileSync(
        join(userData, 'app-sessions.json'),
        JSON.stringify([
          {
            sessionId: 'sess-legacy-1',
            providerId: 'codex',
            cwd: '/tmp/ws',
            title: 'Legacy Title',
            preview: 'hello',
            ts: t0,
            lastRunOutcome: 'completed'
          },
          {
            sessionId: 'sess-legacy-2',
            providerId: 'codex',
            cwd: '/tmp/ws',
            title: 'Second Legacy',
            preview: 'world',
            ts: t0 + 200_000
          }
        ])
      )

      // Phase 4: Switch back to `shadow` -> imports ONLY the 4th run and updated catalog, no duplicates!
      {
        const sink = EventSink.open({ userDataDir: userData })
        try {
          const third = importLegacyStateIncrementally({
            sink,
            userDataDir: userData,
            now: t0 + 205_000,
            pendingTtlMs: 60_000
          })
          expect(third.importedRuns).toBe(1)
          expect(third.importedSessions).toBe(1)
          expect(sink.getRun(runFourth)?.lifecycle).toBe('settled')
          expect(sink.getSession('sess-legacy-2')?.title).toBe('Second Legacy')

          // Verify zero duplicate intent_recorded events for any run
          const intents = sink.listEvents().filter((e) => e.type === 'run.intent_recorded')
          expect(intents).toHaveLength(4)
          expect(new Set(intents.map((e) => e.runId)).size).toBe(4)
          expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
        } finally {
          sink.close()
        }
      }
    })
  })

  it('keeps open runs faithful in P4-1 shadow mode, marks outbox shadowOnly/done, and leaves snapshot-only settledAt null', () => {
    withTempDir((userData) => {
      const ledgerDir = makeLedgerDir(userData)
      const t0 = 1_700_000_000_000
      const snapSettled = SessionLedger.newRunId()
      const snapDispatched = SessionLedger.newRunId()
      const snapRecorded = SessionLedger.newRunId()

      // Write a snapshot-only ledger (no session-ledger.log tail, so terminalAt is unavailable)
      writeFileSync(
        join(ledgerDir, 'session-ledger.snapshot.json'),
        JSON.stringify({
          snapshot: {
            lastSeq: 12,
            runs: [
              {
                runId: snapSettled,
                intentId: SessionLedger.newIntentId(),
                intentSeq: 1,
                intentAt: t0,
                intentDetail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: 'snap settled' }),
                lifecycle: 'settled'
              },
              {
                runId: snapDispatched,
                intentId: SessionLedger.newIntentId(),
                intentSeq: 4,
                intentAt: t0 + 1000,
                intentDetail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: 'snap open' }),
                lifecycle: 'dispatched'
              },
              {
                runId: snapRecorded,
                intentId: SessionLedger.newIntentId(),
                intentSeq: 7,
                intentAt: t0 + 2000,
                intentDetail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: 'snap recorded' }),
                lifecycle: 'recorded'
              }
            ]
          }
        })
      )

      const sink = EventSink.open({ userDataDir: userData })
      try {
        const summary = importLegacyStateIncrementally({
          sink,
          userDataDir: userData,
          now: t0 + 300_000,
          reconcileOpenRuns: false,
          shadowOnly: true
        })
        expect(summary.importedRuns).toBe(3)

        // Snapshot-only terminal run: NEVER fabricate settledAt; mark unavailable with explicit reason
        const settled = sink.getRun(snapSettled)
        expect(settled?.lifecycle).toBe('settled')
        expect(settled?.settledAt).toBeNull()
        expect(settled?.outcome).toEqual({
          status: 'unavailable',
          quality: 'unavailable',
          source: ['legacy-ledger:12'],
          omissionReason: 'snapshot_terminal_timestamp_unavailable'
        })

        // Shadow mode preserves open lifecycles so H1 recover()/pump() drive terminal state cleanly
        expect(sink.getRun(snapDispatched)?.lifecycle).toBe('dispatched')
        expect(sink.getRun(snapRecorded)?.lifecycle).toBe('recorded')

        // Every imported outbox row is marked done + shadowOnly so P4-2 never re-dispatches them
        const outbox = sink.listOutbox()
        expect(outbox).toHaveLength(3)
        for (const row of outbox) {
          expect(row.state).toBe('done')
          expect(row.leaseOwner).toBe('shadow:no-dispatch')
          expect(row.payload.shadowOnly).toBe(true)
        }
        expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        sink.close()
      }
    })
  })

  it('batches 2,000 legacy runs into bounded transactions without per-run fsync overhead', () => {
    withTempDir((userData) => {
      const ledgerDir = makeLedgerDir(userData)
      const t0 = 1_700_000_000_000
      const lines: string[] = []
      let seq = 0
      for (let i = 0; i < 2_000; i += 1) {
        const runId = SessionLedger.newRunId()
        const intentId = SessionLedger.newIntentId()
        lines.push(
          JSON.stringify({
            seq: ++seq,
            at: t0 + i * 10,
            runId,
            kind: 'intent_recorded',
            intentId,
            detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-bulk', prompt: `run ${i}` })
          }),
          JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 1, runId, kind: 'run_dispatched' }),
          JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 2, runId, kind: 'run_settled' })
        )
      }
      writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`)

      const sink = EventSink.open({ userDataDir: userData })
      try {
        const started = performance.now()
        const summary = importLegacyStateIncrementally({
          sink,
          userDataDir: userData,
          now: t0 + 100_000,
          reconcileOpenRuns: false,
          shadowOnly: true,
          batchSize: 500
        })
        const elapsedMs = performance.now() - started
        expect(summary.importedRuns).toBe(2_000)
        expect(summary.legacyLedgerSeq).toBe(6_000)
        expect(elapsedMs).toBeLessThan(5_000)
        // Re-run is a fast no-op
        const noop = importLegacyStateIncrementally({ sink, userDataDir: userData, now: t0 + 100_001 })
        expect(noop.importedRuns).toBe(0)
      } finally {
        sink.close()
      }
    })
  })
})
