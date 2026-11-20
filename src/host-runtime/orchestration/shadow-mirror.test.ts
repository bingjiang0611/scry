import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLedger, type LedgerEvent, type LedgerStore } from '../../main/remote/session-ledger'
import type { Conversation } from '../../shared/conversation'
import {
  MAX_PENDING_TTL_MS,
  parseOrchestrationFullfsync,
  parseOrchestrationMode,
  parsePendingTtlMs
} from './mode'
import { ShadowMirror } from './shadow-mirror'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-shadow-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function memoryLedgerStore(): LedgerStore {
  const events: LedgerEvent[] = []
  return {
    assertAvailable: () => undefined,
    loadAll: () => [...events],
    append: (event) => {
      events.push(event)
    }
  }
}

describe('P4-1 SCRY_ORCHESTRATION switch parsing', () => {
  it('defaults to off, supports shadow and on in P4-2, and caps pending TTL at 60 s', () => {
    expect(parseOrchestrationMode({})).toEqual({ requested: 'off', effective: 'off', refused: false })
    expect(parseOrchestrationMode({ SCRY_ORCHESTRATION: 'off' })).toEqual({ requested: 'off', effective: 'off', refused: false })
    expect(parseOrchestrationMode({ SCRY_ORCHESTRATION: 'shadow' })).toEqual({ requested: 'shadow', effective: 'shadow', refused: false })
    expect(parseOrchestrationMode({ SCRY_ORCHESTRATION: 'on' })).toEqual({
      requested: 'on',
      effective: 'on',
      refused: false
    })
    expect(parseOrchestrationMode({ SCRY_ORCHESTRATION: 'bogus' })).toEqual({ requested: 'off', effective: 'off', refused: false })

    expect(parseOrchestrationFullfsync({})).toBeUndefined()
    expect(parseOrchestrationFullfsync({ SCRY_ORCHESTRATION_FULLFSYNC: '1' })).toBe(true)
    expect(parseOrchestrationFullfsync({ SCRY_ORCHESTRATION_FULLFSYNC: '0' })).toBe(false)

    expect(parsePendingTtlMs({})).toBe(MAX_PENDING_TTL_MS)
    expect(parsePendingTtlMs({ SCRY_ORCHESTRATION_PENDING_TTL_MS: '500' })).toBe(500)
    expect(parsePendingTtlMs({ SCRY_ORCHESTRATION_PENDING_TTL_MS: '3600000' })).toBe(MAX_PENDING_TTL_MS)
    expect(parsePendingTtlMs({ SCRY_ORCHESTRATION_PENDING_TTL_MS: '-10' })).toBe(MAX_PENDING_TTL_MS)
  })
})

describe('P4-1 ShadowMirror H1 #emit and H3 settle parity + fail-open', () => {
  it('mirrors H1 send, question, answer, settle, stop/cancel, and failure field-for-field with peer actors', () => {
    withTempDir((userData) => {
      const localPeer = 'a'.repeat(64)
      const remotePeer = 'b'.repeat(64)
      const metaByRun = new Map<string, { peerCertSHA256: string; grantScope: 'local' | 'remote' }>()
      let pendingAnsweredByPeer: string | undefined
      const mirror = ShadowMirror.open({ userDataDir: userData })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          onEvent: (event) => {
            const base = metaByRun.get(event.runId)
            const answeredByPeer = pendingAnsweredByPeer
            pendingAnsweredByPeer = undefined
            mirror.onLedgerEvent(
              event,
              base || answeredByPeer ? { ...(base ?? {}), ...(answeredByPeer ? { answeredByPeer } : {}) } : undefined
            )
          }
        })

        // 1. Full local App send -> dispatch -> session -> question -> answer -> close -> settle
        const run1 = SessionLedger.newRunId()
        const intent1 = SessionLedger.newIntentId()
        metaByRun.set(run1, { peerCertSHA256: localPeer, grantScope: 'local' })
        ledger.recordIntent({
          intentId: intent1,
          runId: run1,
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: '/tmp/ws-1',
            prompt: 'fix bug',
            conversation: { conversationId: 'conv-1', runId: 'turn-run-1' }
          })
        })
        ledger.markDispatched(run1)
        ledger.markProgress(run1, JSON.stringify({ event: 'session', externalSessionId: 'ext-1' }))
        ledger.markProgress(
          run1,
          JSON.stringify({ event: 'question_opened', questionId: 'q-1', kind: 'approval', source: 'provider' })
        )
        pendingAnsweredByPeer = remotePeer
        ledger.markProgress(
          run1,
          JSON.stringify({
            event: 'question_answered',
            questionId: 'q-1',
            answerId: 'ans-1'
          })
        )
        ledger.markProgress(
          run1,
          JSON.stringify({ event: 'question_closed', questionId: 'q-1', resolution: 'answered' })
        )
        ledger.markSettled(run1)

        // 2. Cancelled remote run
        const run2 = SessionLedger.newRunId()
        const intent2 = SessionLedger.newIntentId()
        metaByRun.set(run2, { peerCertSHA256: remotePeer, grantScope: 'remote' })
        ledger.recordIntent({
          intentId: intent2,
          runId: run2,
          detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-1', prompt: 'stop me' })
        })
        ledger.markDispatched(run2)
        ledger.markCancelled(run2)

        // 3. Failed remote run with ~1.2 MB intent body (just under H1 1,200,000 cap; externalized to BodyStore off pre-first-token path)
        const run3 = SessionLedger.newRunId()
        const bigBody = 'M'.repeat(1_199_800)
        metaByRun.set(run3, { peerCertSHA256: remotePeer, grantScope: 'remote' })
        ledger.recordIntent({
          intentId: SessionLedger.newIntentId(),
          runId: run3,
          detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-1', prompt: 'fail me', blob: bigBody })
        })
        ledger.markDispatched(run3)
        // Before terminal event (pre-first-token path), BodyStore must NOT have written/fsynced the external body file yet
        const preTerminalRun3 = mirror.sink!.getRun(run3)
        expect(preTerminalRun3?.body?.storage).toBe('external')
        expect(mirror.sink!.bodyStore.hasExternalBody(preTerminalRun3!.body!.sha256)).toBe(false)
        ledger.markFailed(run3, 'provider_crashed')

        // Verify zero deviations and full field-for-field parity against H1 SessionLedger
        const st = mirror.stats()
        expect(st.failures).toBe(0)
        expect(st.deviations).toBe(0)
        expect(st.failedOpen).toBe(false)
        expect(st.preFirstTokenCommitsByRun.get('turn-run-1')).toBe(2)

        const shadowRun1 = mirror.sink!.getRun('turn-run-1')
        expect(shadowRun1).toMatchObject({
          runId: 'turn-run-1',
          sessionKey: 'conv-1',
          ownerActor: `peer:${localPeer}`,
          scope: 'local',
          origin: 'local',
          provider: 'codex',
          profile: null,
          cwd: '/tmp/ws-1',
          promptPreview: 'fix bug',
          lifecycle: ledger.runState(run1),
          stopState: null,
          outputSeq: null,
          parentRunId: null
        })
        expect(shadowRun1?.settledAt).toBeTypeOf('number')
        expect(shadowRun1?.outcome).toMatchObject({ status: 'available', quality: 'exact', value: 'settled' })
        expect(mirror.sink!.getReceipt(intent1, `peer:${localPeer}`)?.status).toBe('accepted')

        const interaction = mirror.sink!.getInteraction('turn-run-1', 'q-1')
        expect(interaction).toMatchObject({
          runId: 'turn-run-1',
          questionId: 'q-1',
          kind: 'approval',
          source: 'provider',
          state: 'closed',
          answerId: 'ans-1',
          answeredBy: `peer:${remotePeer}`
        })

        // Every shadow outbox row (both provider.run.start AND question.respond) must be done/shadowOnly
        const outbox = mirror.sink!.listOutbox()
        expect(outbox.some((row) => row.kind === 'question.respond')).toBe(true)
        for (const row of outbox) {
          expect(row.state, row.kind).toBe('done')
          expect(row.leaseOwner, row.kind).toBe('shadow:no-dispatch')
          expect(row.payload.shadowOnly, row.kind).toBe(true)
        }

        const shadowRun2 = mirror.sink!.getRun(run2)
        expect(shadowRun2).toMatchObject({
          runId: run2,
          ownerActor: `peer:${remotePeer}`,
          scope: 'remote',
          origin: 'remote',
          lifecycle: ledger.runState(run2)
        })
        expect(mirror.sink!.getReceipt(intent2, `peer:${remotePeer}`)?.status).toBe('accepted')

        const shadowRun3 = mirror.sink!.getRun(run3)
        expect(shadowRun3?.lifecycle).toBe(ledger.runState(run3))
        expect(shadowRun3?.body?.storage).toBe('external')
        expect(shadowRun3?.body?.bytes).toBeGreaterThan(1_150_000)
        expect(mirror.sink!.bodyStore.hasExternalBody(shadowRun3!.body!.sha256)).toBe(true)
        expect(mirror.sink!.getMeta('legacy_ledger_seq')).toBe(String(ledger.describe().lastSeq))
        expect(mirror.sink!.verifyReplayConsistency()).toEqual({ matches: true })

        // 4. H3 settle mirrors turn delivery into orch_p_turn
        const fakeConversation: Conversation = {
          version: 1,
          id: 'conv-1',
          cwd: '/tmp/ws-1',
          revision: 2,
          bindings: [{ id: 'b-1', providerId: 'codex', continuationKey: 'k', nativeSessionId: 'ext-1' }],
          turns: [
            {
              origin: 'dispatch',
              ordinal: 1,
              runId: 'turn-run-1',
              bindingId: 'b-1',
              commandId: 'c-1',
              intentHash: 'h-1',
              resumeSessionId: null,
              items: [],
              importedItems: [],
              omittedItems: [],
              delivery: { status: 'accepted', nativeSessionId: 'ext-1', outcome: 'completed', nativeItems: [] }
            }
          ]
        }
        mirror.onConversationTurnSettled({
          conversationId: 'conv-1',
          runId: 'turn-run-1',
          conversation: fakeConversation,
          delivery: { status: 'accepted', nativeSessionId: 'ext-1', outcome: 'completed', nativeItems: [] }
        })
        expect(mirror.sink!.getTurn('conv-1', 1)?.delivery).toBe('accepted')
      } finally {
        mirror.close()
      }
    })
  })

  it('fails open on injected shadow write failure, counts failure, and does not affect the run', () => {
    withTempDir((userData) => {
      let injectFail = false
      const mirror = ShadowMirror.open({
        userDataDir: userData,
        beforeCommitHook: () => {
          if (injectFail) {
            throw Object.assign(new Error('SQLITE_IOERR_WRITE'), { code: 'SQLITE_IOERR_WRITE' })
          }
        }
      })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          onEvent: (event) => mirror.onLedgerEvent(event)
        })

        const runId = SessionLedger.newRunId()
        ledger.recordIntent({
          intentId: SessionLedger.newIntentId(),
          runId,
          detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: 'hi' })
        })

        // Inject shadow write failure on dispatch; H1 ledger must still complete cleanly
        injectFail = true
        expect(() => ledger.markDispatched(runId)).not.toThrow()
        expect(() => ledger.markSettled(runId)).not.toThrow()
        expect(ledger.runState(runId)).toBe('settled')

        expect(mirror.stats().failures).toBeGreaterThanOrEqual(1)
        expect(mirror.stats().failedOpen).toBe(true)
      } finally {
        mirror.close()
      }
    })
  })
})
