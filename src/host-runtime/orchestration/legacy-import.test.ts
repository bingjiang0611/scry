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

      // Phase 2: Switch to `shadow` (after TTL expired: t0 + 120_000) -> incremental import
      {
        const sink = EventSink.open({ userDataDir: userData })
        try {
          const first = importLegacyStateIncrementally({
            sink,
            userDataDir: userData,
            now: t0 + 120_000,
            pendingTtlMs: 60_000
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

          // Re-running import in same shadow session is a pure no-op (zero duplicates)
          const second = importLegacyStateIncrementally({
            sink,
            userDataDir: userData,
            now: t0 + 121_000,
            pendingTtlMs: 60_000
          })
          expect(second.importedRuns).toBe(0)
          expect(second.importedSessions).toBe(0)
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
        } finally {
          sink.close()
        }
      }
    })
  })
})
