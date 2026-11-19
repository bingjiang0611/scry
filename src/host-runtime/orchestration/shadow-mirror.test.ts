import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLedger, type LedgerEvent, type LedgerStore } from '../../main/remote/session-ledger'
import type { Conversation } from '../../shared/conversation'
import {
  parseOrchestrationFullfsync,
  parseOrchestrationMode
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
  it('defaults to off and parses shadow/on and fullfsync flags', () => {
    expect(parseOrchestrationMode({})).toEqual({ requested: 'off', effective: 'off' })
    expect(parseOrchestrationMode({ SCRY_ORCHESTRATION: 'off' })).toEqual({ requested: 'off', effective: 'off' })
    expect(parseOrchestrationMode({ SCRY_ORCHESTRATION: 'shadow' })).toEqual({ requested: 'shadow', effective: 'shadow' })
    expect(parseOrchestrationMode({ SCRY_ORCHESTRATION: 'on' })).toEqual({ requested: 'on', effective: 'shadow' })
    expect(parseOrchestrationMode({ SCRY_ORCHESTRATION: 'bogus' })).toEqual({ requested: 'off', effective: 'off' })

    expect(parseOrchestrationFullfsync({})).toBeUndefined()
    expect(parseOrchestrationFullfsync({ SCRY_ORCHESTRATION_FULLFSYNC: '1' })).toBe(true)
    expect(parseOrchestrationFullfsync({ SCRY_ORCHESTRATION_FULLFSYNC: '0' })).toBe(false)
  })
})

describe('P4-1 ShadowMirror H1 #emit and H3 settle parity + fail-open', () => {
  it('mirrors H1 send, question, answer, settle, stop/cancel, and failure field-for-field', () => {
    withTempDir((userData) => {
      const mirror = ShadowMirror.open({ userDataDir: userData })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          onEvent: (event) => mirror.onLedgerEvent(event)
        })

        // 1. Full send -> dispatch -> session -> question -> answer -> close -> settle
        const run1 = SessionLedger.newRunId()
        const intent1 = SessionLedger.newIntentId()
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
        ledger.markProgress(
          run1,
          JSON.stringify({ event: 'question_answered', questionId: 'q-1', answerId: 'ans-1' })
        )
        ledger.markProgress(
          run1,
          JSON.stringify({ event: 'question_closed', questionId: 'q-1', resolution: 'answered' })
        )
        ledger.markSettled(run1)

        // 2. Cancelled run
        const run2 = SessionLedger.newRunId()
        ledger.recordIntent({
          intentId: SessionLedger.newIntentId(),
          runId: run2,
          detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-1', prompt: 'stop me' })
        })
        ledger.markDispatched(run2)
        ledger.markCancelled(run2)

        // 3. Failed run
        const run3 = SessionLedger.newRunId()
        ledger.recordIntent({
          intentId: SessionLedger.newIntentId(),
          runId: run3,
          detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-1', prompt: 'fail me' })
        })
        ledger.markDispatched(run3)
        ledger.markFailed(run3, 'provider_crashed')

        // Verify field-for-field parity against H1 SessionLedger
        expect(mirror.stats().failures).toBe(0)
        expect(mirror.stats().failedOpen).toBe(false)
        expect(mirror.stats().preFirstTokenCommitsByRun.get('turn-run-1')).toBe(2)

        const shadowRun1 = mirror.sink!.getRun('turn-run-1')
        expect(shadowRun1?.lifecycle).toBe(ledger.runState(run1))
        expect(shadowRun1?.provider).toBe('codex')
        expect(shadowRun1?.cwd).toBe('/tmp/ws-1')
        expect(shadowRun1?.sessionKey).toBe('conv-1')

        const interaction = mirror.sink!.getInteraction('turn-run-1', 'q-1')
        expect(interaction?.state).toBe('closed')
        expect(interaction?.answerId).toBe('ans-1')

        expect(mirror.sink!.getRun(run2)?.lifecycle).toBe(ledger.runState(run2))
        expect(mirror.sink!.getRun(run3)?.lifecycle).toBe(ledger.runState(run3))
        expect(mirror.sink!.getMeta('legacy_ledger_seq')).toBe(String(ledger.describe().lastSeq))

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

  it('B1: mirrors multi-turn conversations and resumed native sessions without ordinal PK collision', () => {
    withTempDir((userData) => {
      const mirror = ShadowMirror.open({ userDataDir: userData })
      try {
        const ledger = new SessionLedger({
          store: memoryLedgerStore(),
          onEvent: (event) => mirror.onLedgerEvent(event)
        })

        // 3 turns in the same conversation
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

        // 2 turns in a resumed native session
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
        // Trigger a sticky invalid_target rejection (unknown run) -> must NOT count as accepted or timing sample
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

        // Mark failed open explicitly (e.g. startup import fence) -> further events are skipped without silent commits
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
        // Replay from empty MUST match online projection after H3 settle!
        expect(mirror.sink!.verifyReplayConsistency()).toEqual({ matches: true })
        expect(mirror.stats().deviations).toBe(0)
      } finally {
        mirror.close()
      }
    })
  })
})
