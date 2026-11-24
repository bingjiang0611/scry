import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../../main/conversation-store'
import { SessionLedger } from '../../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../../main/remote/legacy-ledger-file.fixtures'
import { scopedIntentId } from '../../main/remote/remote-gateway'
import { AuthorityEngine } from './authority-engine'
import { EventSink } from './event-sink'
import { importLegacyStateIncrementally, startDeferredLegacyImport } from './legacy-import'
import { LedgerProjectionMirror } from './ledger-projection-mirror'

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
  it('keeps an imported compacted receipt exact after pruning and rejects another payload', () => {
    withTempDir((userDataDir) => {
      const peerCertSHA256 = 'a'.repeat(64)
      const commandId = scopedIntentId(peerCertSHA256, SessionLedger.newIntentId())
      const runId = SessionLedger.newRunId()
      const detail = JSON.stringify({ providerId: 'codex', cwd: userDataDir, prompt: 'original legacy send' })
      const store = new SessionLedgerFileStore(makeLedgerDir(userDataDir))
      try {
        const ledger = new SessionLedger({ store, maxEvents: 3 })
        ledger.recordIntent({ intentId: commandId, runId, detail })
        ledger.markDispatched(runId)
        ledger.markSettled(runId)
        // The next append compacts the settled state, which keeps the digest only.
        ledger.recordIntent({ intentId: SessionLedger.newIntentId(), runId: SessionLedger.newRunId() })
      } finally {
        store.close()
      }
      const sink = EventSink.open({ userDataDir, checkpointIntervalMs: 0 })
      try {
        importLegacyStateIncrementally({ sink, userDataDir, pendingTtlMs: 120_000, reconcileOpenRuns: true })
        const original = sink.getReceipt(commandId, 'system')!
        expect(original.status).toBe('accepted')
        expect(sink.pruneEvents({ olderThanAt: Date.now() + 1 }).deletedEvents).toBeGreaterThan(0)
        const engine = new AuthorityEngine({ sink })
        const input = { peerCertSHA256, grantScope: 'remote' as const, commandId, detail }
        expect(engine.submitSync(input)).toEqual({ kind: 'duplicate', runId, seq: original.resultSeq })
        expect(engine.submitSync({ ...input, detail: detail.replace('original', 'different') }))
          .toMatchObject({ kind: 'rejected', reason: 'command_payload_conflict' })
      } finally {
        sink.close()
      }
    })
  })

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

  it('reproduces and prevents PK collision when live turn 4 interleaves before deferred backfill of pre-fix turns 1-3', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-legacy-interleave-test-'))
    try {
      const wsDir = join(userData, 'ws-interleave')
      mkdirSync(wsDir, { recursive: true })
      const store = new ConversationStore(userData)
      let conv = await store.create(wsDir)
      const oldRunIds: string[] = []
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        const rId = SessionLedger.newRunId()
        oldRunIds.push(rId)
        await store.begin(conv.id, {
          runId: rId,
          commandId: SessionLedger.newIntentId(),
          payloadHash: String(ordinal).repeat(64).slice(0, 64),
          expectedRevision: conv.revision,
          target: { providerId: 'codex', continuationKey: 'codex:default' },
          items: [],
          selectedItems: []
        })
        conv = await store.settle(
          conv.id,
          rId,
          { status: 'accepted', nativeSessionId: 'native-interleave', outcome: 'completed', nativeItems: [] },
          []
        )
      }

      const ledgerDir = makeLedgerDir(userData)
      const t0 = 1_700_000_000_000
      const lines: string[] = []
      let seq = 0
      for (let i = 0; i < oldRunIds.length; i += 1) {
        const ledgerRunId = SessionLedger.newRunId()
        lines.push(
          JSON.stringify({
            seq: ++seq,
            at: t0 + i * 10,
            runId: ledgerRunId,
            kind: 'intent_recorded',
            intentId: SessionLedger.newIntentId(),
            detail: JSON.stringify({
              providerId: 'codex',
              cwd: '/tmp/ws-interleave',
              prompt: `pre-fix turn ${i + 1}`,
              conversation: { conversationId: conv.id, runId: oldRunIds[i] }
            })
          }),
          JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 1, runId: ledgerRunId, kind: 'run_dispatched' }),
          JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 2, runId: ledgerRunId, kind: 'run_settled' })
        )
      }
      writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`)

      const mirror = LedgerProjectionMirror.open({ userDataDir: userData })
      try {
        mirror.setDeferringLegacyWatermark(true)

        // 1. Live turn 4 commits BEFORE deferred backfill imports pre-fix turns 1-3
        const turn4Canonical = SessionLedger.newRunId()
        const turn4Ledger = SessionLedger.newRunId()
        mirror.onLedgerEvent({
          seq: 100,
          at: t0 + 5_000,
          runId: turn4Ledger,
          kind: 'intent_recorded',
          intentId: SessionLedger.newIntentId(),
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: '/tmp/ws-interleave',
            prompt: 'live turn 4',
            conversation: { conversationId: conv.id, runId: turn4Canonical, ordinal: 4 }
          })
        })
        mirror.onLedgerEvent({ seq: 101, at: t0 + 5_001, runId: turn4Ledger, kind: 'run_dispatched' })
        mirror.onLedgerEvent({ seq: 102, at: t0 + 5_002, runId: turn4Ledger, kind: 'run_settled' })

        // 2. Deferred backfill runs NOW while turn 4 already occupies ordinal 4
        const deferred = startDeferredLegacyImport({
          sink: mirror.sink!,
          userDataDir: userData,
          now: t0 + 6_000,
          reconcileOpenRuns: false,
          shadowOnly: true
        })
        const summary = await deferred.promise
        mirror.recordImportRejections(summary.rejectedCommands)
        mirror.setDeferringLegacyWatermark(false, summary.legacyLedgerSeq)

        // 3. Live turn 5 arrives at H3 ordinal 5: MUST NOT collide with deferred backfill or fence!
        const turn5Canonical = SessionLedger.newRunId()
        const turn5Ledger = SessionLedger.newRunId()
        mirror.onLedgerEvent({
          seq: 103,
          at: t0 + 7_000,
          runId: turn5Ledger,
          kind: 'intent_recorded',
          intentId: SessionLedger.newIntentId(),
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: '/tmp/ws-interleave',
            prompt: 'live turn 5',
            conversation: { conversationId: conv.id, runId: turn5Canonical, ordinal: 5 }
          })
        })
        mirror.onLedgerEvent({ seq: 104, at: t0 + 7_001, runId: turn5Ledger, kind: 'run_dispatched' })
        mirror.onLedgerEvent({ seq: 105, at: t0 + 7_002, runId: turn5Ledger, kind: 'run_settled' })

        expect(mirror.stats().failedOpen).toBe(false)
        expect(mirror.stats().deviations).toBe(0)
        expect(mirror.sink!.getTurn(conv.id, 1)?.runId).toBe(oldRunIds[0])
        expect(mirror.sink!.getTurn(conv.id, 2)?.runId).toBe(oldRunIds[1])
        expect(mirror.sink!.getTurn(conv.id, 3)?.runId).toBe(oldRunIds[2])
        expect(mirror.sink!.getTurn(conv.id, 4)?.runId).toBe(turn4Canonical)
        expect(mirror.sink!.getTurn(conv.id, 5)?.runId).toBe(turn5Canonical)
        expect(mirror.sink!.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        mirror.close()
      }
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
