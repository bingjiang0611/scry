import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../../main/conversation-store'
import { SessionLedger, type LedgerEvent, type LedgerStore } from '../../main/remote/session-ledger'
import type { Conversation } from '../../shared/conversation'
import { ShadowMirror } from './shadow-mirror'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-shadow-parity-test-'))
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

describe('P4-1 ShadowMirror B1/B2/B3 parity, ordinal fallback, and settle verification', () => {
  it('B1: mirrors multi-turn conversations and resumed native sessions without ordinal PK collision', () => {
    withTempDir((userData) => {
      const mirror = ShadowMirror.open({ userDataDir: userData })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          onEvent: (event) => mirror.onLedgerEvent(event)
        })

        for (let turn = 1; turn <= 3; turn++) {
          const ledgerRunId = SessionLedger.newRunId()
          const canonicalRunId = `conv-turn-${turn}`
          ledger.recordIntent({
            intentId: SessionLedger.newIntentId(),
            runId: ledgerRunId,
            detail: JSON.stringify({
              providerId: 'codex',
              cwd: '/tmp/ws-multi',
              prompt: `turn ${turn}`,
              conversation: { conversationId: 'conv-multi', runId: canonicalRunId }
            })
          })
          ledger.markDispatched(ledgerRunId)
          ledger.markSettled(ledgerRunId)
        }

        for (let turn = 1; turn <= 2; turn++) {
          const ledgerRunId = SessionLedger.newRunId()
          ledger.recordIntent({
            intentId: SessionLedger.newIntentId(),
            runId: ledgerRunId,
            detail: JSON.stringify({
              providerId: 'codex',
              cwd: '/tmp/ws-multi',
              prompt: `resume turn ${turn}`,
              resume: 'native-sess-42'
            })
          })
          ledger.markDispatched(ledgerRunId)
          ledger.markSettled(ledgerRunId)
        }

        const st = mirror.stats()
        expect(st.failures).toBe(0)
        expect(st.failedOpen).toBe(false)
        expect(st.deviations).toBe(0)
        expect(mirror.sink!.getTurn('conv-multi', 1)?.runId).toBe('conv-turn-1')
        expect(mirror.sink!.getTurn('conv-multi', 2)?.runId).toBe('conv-turn-2')
        expect(mirror.sink!.getTurn('conv-multi', 3)?.runId).toBe('conv-turn-3')
        expect(mirror.sink!.getTurn('native-sess-42', 1)).toBeDefined()
        expect(mirror.sink!.getTurn('native-sess-42', 2)).toBeDefined()
      } finally {
        mirror.close()
      }
    })
  })

  it('B2: classifies rejected/duplicate decisions, excludes rejections from timing samples, and trips failedOpen on fence', () => {
    withTempDir((userData) => {
      const timingSamples: Array<{ commitKind: string; durationMs: number }> = []
      const mirror = ShadowMirror.open({
        userDataDir: userData,
        onCommitTiming: (sample) => timingSamples.push({ commitKind: sample.commitKind, durationMs: sample.durationMs })
      })
      try {
        mirror.onLedgerEvent({
          seq: 1,
          at: 1_700_000_000_000,
          runId: SessionLedger.newRunId(),
          kind: 'run_dispatched'
        })
        const st = mirror.stats()
        expect(st.acceptedCommits).toBe(0)
        expect(st.rejectedSticky).toBe(1)
        expect(st.deviations).toBe(1)
        expect(timingSamples).toHaveLength(0)

        mirror.markFailedOpen(new Error('import_fence'))
        expect(mirror.stats().failedOpen).toBe(true)
        expect(mirror.stats().failures).toBe(1)
      } finally {
        mirror.close()
      }
    })
  })

  it('B3: routes H3 onConversationTurnSettled through EventSink and preserves replay consistency', () => {
    withTempDir((userData) => {
      const fixedAt = 1_700_000_123_456
      const mirror = ShadowMirror.open({
        userDataDir: userData,
        clock: () => fixedAt
      })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          clock: () => fixedAt,
          onEvent: (event) => mirror.onLedgerEvent(event)
        })
        const run1 = SessionLedger.newRunId()
        ledger.recordIntent({
          intentId: SessionLedger.newIntentId(),
          runId: run1,
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: '/tmp/ws-b3',
            prompt: 'first',
            conversation: { conversationId: 'conv-b3', runId: 'run-b3-1' }
          })
        })
        ledger.markDispatched(run1)
        ledger.markSettled(run1)

        const fakeConversation: Conversation = {
          version: 1,
          id: 'conv-b3',
          cwd: '/tmp/ws-b3',
          revision: 2,
          bindings: [{ id: 'b-1', providerId: 'codex', continuationKey: 'k', nativeSessionId: 'ext-b3' }],
          turns: [
            {
              origin: 'dispatch',
              ordinal: 1,
              runId: 'run-b3-1',
              bindingId: 'b-1',
              commandId: 'c-1',
              intentHash: 'h-1',
              resumeSessionId: null,
              items: [],
              importedItems: [],
              omittedItems: [],
              delivery: { status: 'accepted', nativeSessionId: 'ext-b3', outcome: 'completed', nativeItems: [] }
            }
          ]
        }
        mirror.onConversationTurnSettled({
          conversationId: 'conv-b3',
          runId: 'run-b3-1',
          conversation: fakeConversation,
          delivery: { status: 'accepted', nativeSessionId: 'ext-b3', outcome: 'completed', nativeItems: [] }
        })

        const turn = mirror.sink!.getTurn('conv-b3', 1)
        expect(turn?.delivery).toBe('accepted')
        expect(turn?.revSeq).toBeGreaterThan(0)
        expect(mirror.sink!.verifyReplayConsistency()).toEqual({ matches: true })
        expect(mirror.stats().deviations).toBe(0)
      } finally {
        mirror.close()
      }
    })
  })

  it('B1 settle check: counts deviation when H3 settle ordinal disagrees with shadow turn ordinal without fencing', () => {
    withTempDir((userData) => {
      const fixedAt = 1_700_000_200_000
      const mirror = ShadowMirror.open({ userDataDir: userData, clock: () => fixedAt })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          clock: () => fixedAt,
          onEvent: (event) => mirror.onLedgerEvent(event)
        })
        const ledgerRun = SessionLedger.newRunId()
        ledger.recordIntent({
          intentId: SessionLedger.newIntentId(),
          runId: ledgerRun,
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: '/tmp/ws-mismatch',
            prompt: 'stale detail without ordinal',
            conversation: { conversationId: 'conv-mismatch', runId: 'run-mismatch-3' }
          })
        })
        ledger.markDispatched(ledgerRun)
        ledger.markSettled(ledgerRun)
        expect(mirror.sink!.getTurnByRunId('run-mismatch-3')?.ordinal).toBe(1)

        const fakeConversation: Conversation = {
          version: 1,
          id: 'conv-mismatch',
          cwd: '/tmp/ws-mismatch',
          revision: 3,
          bindings: [{ id: 'b-1', providerId: 'codex', continuationKey: 'k', nativeSessionId: 'ext-m' }],
          turns: [
            {
              origin: 'dispatch',
              ordinal: 3,
              runId: 'run-mismatch-3',
              bindingId: 'b-1',
              commandId: 'c-3',
              intentHash: 'h-3',
              resumeSessionId: null,
              items: [],
              importedItems: [],
              omittedItems: [],
              delivery: { status: 'accepted', nativeSessionId: 'ext-m', outcome: 'completed', nativeItems: [] }
            }
          ]
        }
        mirror.onConversationTurnSettled({
          conversationId: 'conv-mismatch',
          runId: 'run-mismatch-3',
          conversation: fakeConversation,
          delivery: { status: 'accepted', nativeSessionId: 'ext-m', outcome: 'completed', nativeItems: [] }
        })

        expect(mirror.stats().failedOpen).toBe(false)
        expect(mirror.stats().ordinalMismatches).toBe(1)
        expect(mirror.stats().deviations).toBe(1)
      } finally {
        mirror.close()
      }
    })
  })

  it('B1 live fallback: resolves true H3 ordinal from ConversationStore on disk when routing.ordinal is omitted', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-shadow-h3-fallback-'))
    try {
      const wsDir = join(userData, 'ws')
      mkdirSync(wsDir, { recursive: true })
      const store = new ConversationStore(userData)
      const adopted = await store.create(wsDir, {
        target: { providerId: 'codex', continuationKey: 'codex:default' },
        nativeSessionId: 'native-fb',
        turns: [
          { runId: 'imp-1', items: [], nativeItems: [] },
          { runId: 'imp-2', items: [], nativeItems: [] }
        ]
      })
      const turn3RunId = SessionLedger.newRunId()
      const begun = await store.begin(adopted.id, {
        runId: turn3RunId,
        commandId: SessionLedger.newIntentId(),
        payloadHash: 'c'.repeat(64),
        expectedRevision: adopted.revision,
        target: { providerId: 'codex', continuationKey: 'codex:default' },
        items: [],
        selectedItems: []
      })
      expect(begun.turn.ordinal).toBe(3)

      const mirror = ShadowMirror.open({ userDataDir: userData })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          onEvent: (event) => mirror.onLedgerEvent(event)
        })
        const ledgerRun = SessionLedger.newRunId()
        ledger.recordIntent({
          intentId: SessionLedger.newIntentId(),
          runId: ledgerRun,
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: wsDir,
            prompt: 'omitted ordinal in live intent',
            conversation: { conversationId: adopted.id, runId: turn3RunId }
          })
        })
        ledger.markDispatched(ledgerRun)
        ledger.markSettled(ledgerRun)

        expect(mirror.sink!.getTurn(adopted.id, 1)).toBeUndefined()
        expect(mirror.sink!.getTurn(adopted.id, 3)?.runId).toBe(turn3RunId)
        expect(mirror.stats().deviations).toBe(0)
        expect(mirror.sink!.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        mirror.close()
      }
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('R3: records answered_by as unavailable (never system) when answering peer is unknown, and skips orphan body writes on rejected submit', () => {
    withTempDir((userData) => {
      const mirror = ShadowMirror.open({ userDataDir: userData })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          onEvent: (event) => mirror.onLedgerEvent(event)
        })
        const runId = SessionLedger.newRunId()
        ledger.recordIntent({
          intentId: SessionLedger.newIntentId(),
          runId,
          detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-r3', prompt: 'ask without peer' })
        })
        ledger.markDispatched(runId)
        ledger.markProgress(runId, JSON.stringify({ event: 'question_opened', questionId: 'q-u', kind: 'approval', source: 'provider' }))
        // No meta.answeredByPeer passed (simulating unknown peer after restart)
        ledger.markProgress(runId, JSON.stringify({ event: 'question_answered', questionId: 'q-u', answerId: 'ans-u' }))

        const interaction = mirror.sink!.getInteraction(runId, 'q-u')
        expect(interaction?.answeredBy).toBe('unavailable')

        // Rejected submit with >16 KiB body (duplicate runId collision -> invalid_target) must NOT leave an orphan file
        const rejectedDetail = JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-r3', prompt: 'dup', blob: 'Z'.repeat(24_000) })
        mirror.onLedgerEvent({
          seq: 99,
          at: Date.now(),
          runId,
          kind: 'intent_recorded',
          intentId: SessionLedger.newIntentId(),
          detail: rejectedDetail
        })
        mirror.flushPendingBodies()
        const bodyDir = join(userData, 'orchestration', 'bodies')
        expect(mirror.sink!.bodyStore.hasExternalBody(require('node:crypto').createHash('sha256').update(rejectedDetail).digest('hex'))).toBe(false)
        expect(bodyDir).toBeTruthy()
      } finally {
        mirror.close()
      }
    })
  })
})
