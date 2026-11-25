import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../../main/conversation-store'
import { SessionLedger } from '../../main/remote/session-ledger'
import { EventSink } from './event-sink'
import {
  importLegacyStateIncrementally,
  loadLegacyLedgerPlan,
  repairMissingShadowBodies,
  startDeferredLegacyImport
} from './legacy-import'
import { ShadowMirror } from './shadow-mirror'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-legacy-edge-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('P4-1 S2 missing-body startup repair and ordinal-miss safety', () => {
  it('S2: repairs dangling >16 KiB external body file from H1 ledger on restart, and counts deviation if H1 detail is absent', () => {
    withTempDir((userData) => {
      const ledgerDir = join(userData, 'remote', 'ledger')
      mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
      const ledgerRunId = SessionLedger.newRunId()
      const intentId = SessionLedger.newIntentId()
      const detail = JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-s2', prompt: 'crash mid-run', blob: 'B'.repeat(24_000) })
      const t0 = 1_700_000_000_000

      writeFileSync(
        join(ledgerDir, 'session-ledger.log'),
        `${JSON.stringify({ seq: 1, at: t0, runId: ledgerRunId, kind: 'intent_recorded', intentId, detail })}\n`,
        { mode: 0o600 }
      )

      let expectedSha = ''
      const mirror1 = ShadowMirror.open({ userDataDir: userData })
      try {
        mirror1.onLedgerEvent({ seq: 1, at: t0, runId: ledgerRunId, kind: 'intent_recorded', intentId, detail })
        const run = mirror1.sink!.getRun(ledgerRunId)
        expect(run?.body?.storage).toBe('external')
        expectedSha = run!.body!.sha256
        expect(mirror1.sink!.bodyStore.hasExternalBody(expectedSha)).toBe(false)
      } finally {
        mirror1.sink!.close()
      }

      const sink2 = EventSink.open({ userDataDir: userData })
      try {
        const plan = loadLegacyLedgerPlan(sink2, userData)
        const result = repairMissingShadowBodies(sink2, plan)
        expect(result).toEqual({ repaired: 1, stillMissing: 0 })
        expect(sink2.bodyStore.hasExternalBody(expectedSha)).toBe(true)
        expect(statSync(sink2.bodyStore.externalPath(expectedSha)).mode & 0o777).toBe(0o600)
        expect(sink2.bodyStore.readBody(sink2.getRun(ledgerRunId)!.body!).toString('utf8')).toBe(detail)
      } finally {
        sink2.close()
      }

      rmSync(join(userData, 'orchestration', 'bodies'), { recursive: true, force: true })
      rmSync(ledgerDir, { recursive: true, force: true })
      const mirror3 = ShadowMirror.open({ userDataDir: userData })
      try {
        const plan = loadLegacyLedgerPlan(mirror3.sink!, userData)
        const result = repairMissingShadowBodies(mirror3.sink!, plan)
        expect(result).toEqual({ repaired: 0, stillMissing: 1 })
        mirror3.recordMissingBodies(result.stillMissing)
        expect(mirror3.stats().missingBodies).toBe(1)
        expect(mirror3.stats().deviations).toBe(1)
      } finally {
        mirror3.close()
      }
    })
  })

  it('skips orch_p_turn and counts deviation rather than fabricating MAX+1 when historical conversation file is missing', () => {
    withTempDir((userData) => {
      const ledgerDir = join(userData, 'remote', 'ledger')
      mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
      const ledgerRunId = SessionLedger.newRunId()
      const canonicalRunId = SessionLedger.newRunId()
      const t0 = 1_700_000_000_000
      writeFileSync(
        join(ledgerDir, 'session-ledger.log'),
        [
          JSON.stringify({
            seq: 1,
            at: t0,
            runId: ledgerRunId,
            kind: 'intent_recorded',
            intentId: SessionLedger.newIntentId(),
            detail: JSON.stringify({
              providerId: 'codex',
              cwd: '/tmp/ws-gone',
              prompt: 'orphan conv turn',
              conversation: { conversationId: 'conv-deleted-on-disk', runId: canonicalRunId }
            })
          }),
          JSON.stringify({ seq: 2, at: t0 + 1, runId: ledgerRunId, kind: 'run_dispatched' }),
          JSON.stringify({ seq: 3, at: t0 + 2, runId: ledgerRunId, kind: 'run_settled' })
        ].join('\n') + '\n',
        { mode: 0o600 }
      )

      const sink = EventSink.open({ userDataDir: userData })
      try {
        const summary = importLegacyStateIncrementally({
          sink,
          userDataDir: userData,
          now: t0 + 10_000,
          reconcileOpenRuns: false,
          shadowOnly: true
        })
        expect(summary.importedRuns).toBe(1)
        expect(summary.rejectedCommands).toBe(1)
        expect(sink.getRun(canonicalRunId)?.lifecycle).toBe('settled')
        expect(sink.getTurnByRunId(canonicalRunId)).toBeUndefined()
        expect(sink.getTurn('conv-deleted-on-disk', 1)).toBeUndefined()
        expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        sink.close()
      }
    })
  })

  it('S1: historical backfill terminal events and intents do not overwrite newer live session lastRunId/outcome/provider/profile/cwd', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-legacy-s1-session-'))
    try {
      const wsOld = join(userData, 'ws-old')
      const wsNew = join(userData, 'ws-new')
      mkdirSync(wsOld, { recursive: true })
      mkdirSync(wsNew, { recursive: true })
      const store = new ConversationStore(userData)
      let conv = await store.create(wsOld)
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
          { status: 'accepted', nativeSessionId: 'native-s1', outcome: 'completed', nativeItems: [] },
          []
        )
      }

      const ledgerDir = join(userData, 'remote', 'ledger')
      mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
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
              agentProfileId: 'old-profile',
              cwd: wsOld,
              prompt: `historical turn ${i + 1}`,
              conversation: { conversationId: conv.id, runId: oldRunIds[i] }
            })
          }),
          JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 1, runId: ledgerRunId, kind: 'run_dispatched' }),
          JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 2, runId: ledgerRunId, kind: 'run_settled' })
        )
      }
      writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`)

      const mirror = ShadowMirror.open({ userDataDir: userData })
      try {
        mirror.setDeferringLegacyWatermark(true)

        const turn4Canonical = SessionLedger.newRunId()
        const turn4Ledger = SessionLedger.newRunId()
        mirror.onLedgerEvent({
          seq: 100,
          at: t0 + 50_000,
          runId: turn4Ledger,
          kind: 'intent_recorded',
          intentId: SessionLedger.newIntentId(),
          detail: JSON.stringify({
            providerId: 'claude',
            agentProfileId: 'live-profile',
            cwd: wsNew,
            prompt: 'live turn 4 newer metadata',
            conversation: { conversationId: conv.id, runId: turn4Canonical, ordinal: 4 }
          })
        })
        mirror.onLedgerEvent({ seq: 101, at: t0 + 50_001, runId: turn4Ledger, kind: 'run_dispatched' })
        mirror.onLedgerEvent({ seq: 102, at: t0 + 50_002, runId: turn4Ledger, kind: 'run_failed', detail: 'rate_limited' })

        const deferred = startDeferredLegacyImport({
          sink: mirror.sink!,
          userDataDir: userData,
          now: t0 + 60_000,
          reconcileOpenRuns: false,
          shadowOnly: true
        })
        const summary = await deferred.promise
        expect(summary.rejectedCommands).toBe(0)

        const session = mirror.sink!.getSession(conv.id)
        expect(session?.lastRunId).toBe(turn4Canonical)
        expect(session?.lastRunOutcome?.value).toBe('failed')
        expect(session?.provider).toBe('claude')
        expect(session?.profile).toBe('live-profile')
        expect(session?.cwd).toBe(wsNew)
        expect(mirror.sink!.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        mirror.close()
      }
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
