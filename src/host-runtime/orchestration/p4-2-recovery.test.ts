import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../../main/conversation-store'
import { SessionLedger } from '../../main/remote/session-ledger'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { reconcileTwoLedgersOnStartup, recoverOrchestrationOnStartup } from './recovery'

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p4-2-recovery-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('P4-2 startup recovery and two-ledger reconciliation', () => {
  it('reconciles every core §2.4 restart state, closes open questions in same tx, and uses recorder evidence when present', async () => {
    await withTempDir(async (userData) => {
      const ws = join(userData, 'ws')
      mkdirSync(ws, { recursive: true })
      const realWs = realpathSync(ws)
      const t0 = 1_700_000_000_000

      const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
      try {
        const submit = (
          runId: string,
          opts: { claimMode: 'immediate' | 'queued'; at?: number; isConversationRun?: boolean; sessionKey?: string }
        ) => {
          const payload = {
            runId,
            sessionKey: opts.sessionKey ?? null,
            ...(opts.sessionKey ? { ordinal: 1 } : {}),
            provider: 'codex',
            profile: null,
            cwd: realWs,
            claimMode: opts.claimMode,
            pendingTtlMs: 30_000,
            origin: 'remote' as const,
            ...(opts.isConversationRun ? { isConversationRun: true } : {})
          }
          expect(
            sink.execute({
              type: 'run.submit',
              commandId: `cmd-${runId}`,
              actor: 'system',
              scope: 'remote',
              at: opts.at ?? t0,
              payload,
              payloadSha256: sha256Hex(canonicalJson(payload))
            }).kind
          ).toBe('accepted')
        }

        submit('r-pending-ok', { claimMode: 'queued', at: t0 })
        submit('r-pending-exp', { claimMode: 'queued', at: t0 - 100_000 })
        submit('r-pending-rollback', { claimMode: 'queued', at: t0 + 50_000 })
        submit('r-pending-conv', { claimMode: 'queued', at: t0, isConversationRun: true, sessionKey: 'conv-p1' })
        submit('r-claimed-nodisp', { claimMode: 'immediate', at: t0 })
        submit('r-disp-unknown', { claimMode: 'immediate', at: t0 })
        sink.execute({
          type: 'run.effect_result',
          commandId: 'eff-disp-unknown',
          actor: 'effect:r-disp-unknown',
          scope: 'system',
          at: t0 + 1,
          payload: { runId: 'r-disp-unknown', step: 'admitted_and_dispatched' },
          payloadSha256: sha256Hex(canonicalJson({ runId: 'r-disp-unknown', step: 'admitted_and_dispatched' }))
        })
        sink.execute({
          type: 'run.effect_result',
          commandId: 'eff-q-open',
          actor: 'effect:r-disp-unknown',
          scope: 'system',
          at: t0 + 2,
          payload: { runId: 'r-disp-unknown', step: 'question_opened', questionId: 'q-1' },
          payloadSha256: sha256Hex(canonicalJson({ runId: 'r-disp-unknown', step: 'question_opened', questionId: 'q-1' }))
        })
        submit('r-disp-proven', { claimMode: 'immediate', at: t0 })
        sink.execute({
          type: 'run.effect_result',
          commandId: 'eff-disp-proven',
          actor: 'effect:r-disp-proven',
          scope: 'system',
          at: t0 + 1,
          payload: { runId: 'r-disp-proven', step: 'admitted_and_dispatched' },
          payloadSha256: sha256Hex(canonicalJson({ runId: 'r-disp-proven', step: 'admitted_and_dispatched' }))
        })

        const recovery = recoverOrchestrationOnStartup({
          sink,
          leaseOwner: 'daemon:restarted',
          now: t0 + 5_000,
          findRecorderEvidence: (runId) =>
            runId === 'r-disp-proven'
              ? {
                  outcome: 'settled',
                  settledAt: t0 + 2_000,
                  evidence: ['managed-turn-commit:r-disp-proven']
                }
              : undefined
        })

        expect(recovery.dispatchablePendingRunIds).toEqual(['r-pending-ok'])
        expect(sink.getRun('r-pending-exp')?.lifecycle).toBe('cancelled')
        expect(sink.getRun('r-pending-rollback')?.lifecycle).toBe('cancelled')
        expect(sink.getRun('r-pending-conv')?.lifecycle).toBe('cancelled')
        expect(sink.getRun('r-claimed-nodisp')?.lifecycle).toBe('cancelled')
        expect(sink.getRun('r-disp-unknown')?.lifecycle).toBe('interrupted')
        expect(sink.getRun('r-disp-unknown')?.settledAt).toBeNull()
        expect(sink.getRun('r-disp-unknown')?.recoveredAt).toBe(t0 + 5_000)
        expect(sink.getInteraction('r-disp-unknown', 'q-1')?.state).toBe('closed')
        expect(sink.getRun('r-disp-proven')?.lifecycle).toBe('settled')
        expect(sink.getRun('r-disp-proven')?.settledAt).toBe(t0 + 2_000)
        expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        sink.close()
      }
    })
  })

  it('reconciles two-ledger boundary (not_sent when no turn.began, writeback when event settled, binding conflict)', async () => {
    await withTempDir(async (userData) => {
      const ws = join(userData, 'ws')
      mkdirSync(ws, { recursive: true })
      const realWs = realpathSync(ws)
      const store = new ConversationStore(userData)
      const conv1 = await store.create(realWs)
      const rNoEvent = SessionLedger.newRunId()
      await store.begin(conv1.id, {
        runId: rNoEvent,
        commandId: SessionLedger.newIntentId(),
        payloadHash: '1'.repeat(64),
        expectedRevision: conv1.revision,
        target: { providerId: 'codex', continuationKey: 'codex:default' },
        items: [],
        selectedItems: []
      })

      const conv2 = await store.create(realWs)
      const rSettledInEvent = SessionLedger.newRunId()
      await store.begin(conv2.id, {
        runId: rSettledInEvent,
        commandId: SessionLedger.newIntentId(),
        payloadHash: '2'.repeat(64),
        expectedRevision: conv2.revision,
        target: { providerId: 'codex', continuationKey: 'codex:default' },
        items: [],
        selectedItems: []
      })

      const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
      try {
        const p2 = {
          runId: rSettledInEvent,
          sessionKey: conv2.id,
          ordinal: 1,
          provider: 'codex',
          profile: null,
          cwd: realWs,
          claimMode: 'immediate' as const,
          origin: 'local' as const,
          isConversationRun: true
        }
        sink.execute({
          type: 'run.submit',
          commandId: 'cmd-c2',
          actor: 'system',
          scope: 'local',
          at: 1_700_000_000_000,
          payload: p2,
          payloadSha256: sha256Hex(canonicalJson(p2))
        })
        sink.execute({
          type: 'run.effect_result',
          commandId: 'eff-c2-disp',
          actor: 'effect:c2',
          scope: 'system',
          at: 1_700_000_000_001,
          payload: { runId: rSettledInEvent, step: 'admitted_and_dispatched' },
          payloadSha256: sha256Hex(canonicalJson({ runId: rSettledInEvent, step: 'admitted_and_dispatched' }))
        })
        sink.execute({
          type: 'run.effect_result',
          commandId: 'eff-c2-bound',
          actor: 'effect:c2',
          scope: 'system',
          at: 1_700_000_000_002,
          payload: { runId: rSettledInEvent, step: 'session_bound', nativeSessionId: 'native-c2-ok' },
          payloadSha256: sha256Hex(
            canonicalJson({ runId: rSettledInEvent, step: 'session_bound', nativeSessionId: 'native-c2-ok' })
          )
        })
        sink.execute({
          type: 'run.effect_result',
          commandId: 'eff-c2-settled',
          actor: 'effect:c2',
          scope: 'system',
          at: 1_700_000_000_003,
          payload: {
            runId: rSettledInEvent,
            step: 'settled',
            outcome: { status: 'available', quality: 'exact', source: ['provider:codex'], value: 'settled' }
          },
          payloadSha256: sha256Hex(
            canonicalJson({
              runId: rSettledInEvent,
              step: 'settled',
              outcome: { status: 'available', quality: 'exact', source: ['provider:codex'], value: 'settled' }
            })
          )
        })

        const report = await reconcileTwoLedgersOnStartup({ sink, conversationStore: store })
        expect(report.markedNotSent).toBe(1)
        expect(report.writtenBack).toBe(1)

        const after1 = await store.required(conv1.id)
        expect(after1.turns[0]?.origin === 'dispatch' ? after1.turns[0].delivery.status : null).toBe('not_sent')
        const after2 = await store.required(conv2.id)
        expect(after2.turns[0]?.origin === 'dispatch' ? after2.turns[0].delivery.status : null).toBe('accepted')
      } finally {
        sink.close()
      }
    })
  })


})
