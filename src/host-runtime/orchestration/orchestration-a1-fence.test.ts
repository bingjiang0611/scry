import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { decide } from './orchestrator'
import type { OrchestrationCommand } from './orchestrator-commands'
import type { OrchestratorReadView } from './orchestrator-handlers'

const PEER_A = `peer:${'a'.repeat(64)}`

function withTempSink(run: (sink: EventSink, userData: string) => void): void {
  const userData = mkdtempSync(join(tmpdir(), 'scry-a1-'))
  const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
  try {
    run(sink, userData)
  } finally {
    sink.close()
    rmSync(userData, { recursive: true, force: true })
  }
}

function submit(input: {
  commandId: string
  runId: string
  sessionKey: string
  ordinal?: number
  at?: number
}): OrchestrationCommand {
  const at = input.at ?? 1_700_000_000_000
  const payload = {
    runId: input.runId,
    sessionKey: input.sessionKey,
    ordinal: input.ordinal ?? 1,
    provider: 'claude' as const,
    profile: 'default',
    cwd: '/tmp/ws',
    promptPreview: 'hello',
    userTextPreview: 'hello',
    claimMode: 'immediate' as const,
    dispatchImmediately: true,
    leaseOwner: 'daemon-1'
  }
  return {
    type: 'run.submit',
    commandId: input.commandId,
    actor: PEER_A,
    scope: 'remote',
    at,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  }
}

function recordDelivery(input: {
  commandId: string
  runId: string
  sessionKey: string
  ordinal: number
  at?: number
}): OrchestrationCommand {
  const payload = {
    sessionKey: input.sessionKey,
    runId: input.runId,
    ordinal: input.ordinal,
    delivery: 'accepted' as const,
    settledAt: 1_700_000_000_500
  }
  return {
    type: 'turn.record_delivery',
    commandId: input.commandId,
    actor: `effect:p4-conv-${input.sessionKey}`,
    scope: 'system',
    at: input.at ?? 1_700_000_000_500,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  }
}

describe('A1: ordinal conflicts reject one command instead of fencing the orchestration store', () => {
  it('rejects a turn.record_delivery whose ordinal is taken by another run and keeps committing', () => {
    withTempSink((sink) => {
      expect(sink.execute(submit({ commandId: 'c1', runId: 'run-1', sessionKey: 'sess-1' })).kind).toBe(
        'accepted'
      )
      const eventsBefore = sink.listEvents().length

      // Finish the first run so the session accepts another one.
      const settledAt = 1_700_000_000_100
      const settlePayload = { runId: 'run-1', step: 'settled' as const }
      expect(
        sink.execute({
          type: 'run.effect_result',
          commandId: 'c-settle',
          actor: 'effect:provider.run.start',
          scope: 'system',
          at: settledAt,
          payload: settlePayload,
          payloadSha256: sha256Hex(canonicalJson(settlePayload))
        }).kind
      ).toBe('accepted')

      // Live runs record intent without a turn row; the conversation effect supplies the ordinal.
      const skipTurn = submit({ commandId: 'c2', runId: 'run-2', sessionKey: 'sess-1', ordinal: 1 })
      if (skipTurn.type === 'run.submit') skipTurn.payload.skipTurnProjection = true
      expect(sink.execute(skipTurn).kind).toBe('accepted')
      const beforeConflict = sink.listEvents().length

      const rejected = sink.execute(
        recordDelivery({ commandId: 'c3', runId: 'run-2', sessionKey: 'sess-1', ordinal: 1 })
      )

      expect(rejected).toMatchObject({ kind: 'rejected', reason: 'illegal_transition', sticky: true })
      expect(sink.isWriteIndeterminate()).toBe(false)
      expect(sink.listEvents().length).toBe(beforeConflict)
      expect(eventsBefore).toBeLessThan(beforeConflict)

      // The store keeps accepting unrelated commands after the conflict.
      expect(
        sink.execute(submit({ commandId: 'c4', runId: 'run-3', sessionKey: 'sess-2', ordinal: 1 })).kind
      ).toBe('accepted')
      expect(sink.getRun('run-3')?.runId).toBe('run-3')
      expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
    })
  })

  it('rejects a run.submit at the decision layer when its explicit ordinal is taken by another run', () => {
    const view: OrchestratorReadView = {
      isActorAuthorized: () => true,
      getReceipt: () => undefined,
      getRun: () => undefined,
      getSession: () => ({ sessionKey: 'sess-1', cwd: '/tmp/ws' }) as never,
      getTurnByRunId: () => undefined,
      getTurnByOrdinal: (sessionKey, ordinal) =>
        sessionKey === 'sess-1' && ordinal === 1 ? ({ runId: 'run-1', ordinal: 1 } as never) : undefined,
      getNextTurnOrdinal: () => 2,
      getInteraction: () => undefined,
      listNonTerminalChildRuns: () => [],
      listNonTerminalChildRunsBySession: () => [],
      hasActiveRunForSession: () => false,
      activeRunCount: () => 0,
      maxActiveRuns: () => 8,
      isProviderAuthenticating: () => false
    }
    const rejected = decide(
      submit({
        commandId: 's2',
        runId: 'run-2',
        sessionKey: 'sess-1',
        ordinal: 1
      }),
      view
    )
    expect(rejected).toMatchObject({ kind: 'rejected', reason: 'illegal_transition', sticky: true })

    const accepted = decide(
      submit({
        commandId: 's3',
        runId: 'run-3',
        sessionKey: 'sess-1',
        ordinal: 2
      }),
      view
    )
    expect(accepted.kind).toBe('accepted')
  })

  it('re-records delivery for the same run without creating a second turn row', () => {
    withTempSink((sink) => {
      expect(sink.execute(submit({ commandId: 'd1', runId: 'run-1', sessionKey: 'sess-1' })).kind).toBe(
        'accepted'
      )
      // A stale ordinal from the effect is ignored because the turn is located by run_id.
      expect(
        sink.execute(recordDelivery({ commandId: 'd2', runId: 'run-1', sessionKey: 'sess-1', ordinal: 9 })).kind
      ).toBe('accepted')
      expect(sink.isWriteIndeterminate()).toBe(false)
      const turnRows = sink.handle.db
        .prepare('SELECT run_id, ordinal FROM orch_p_turn WHERE session_key = ?')
        .all('sess-1') as Array<{ run_id: string; ordinal: number }>
      expect(turnRows).toEqual([{ run_id: 'run-1', ordinal: 1 }])
    })
  })

  it('turns an injected SQLite constraint failure into one sticky rejection and keeps committing', () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-a1-constraint-'))
    let failNext = false
    const sink = EventSink.open({
      userDataDir: userData,
      authorizedActors: [PEER_A],
      beforeCommitHook: () => {
        if (!failNext) return
        failNext = false
        throw Object.assign(new Error('UNIQUE constraint failed: orch_p_turn.session_key, orch_p_turn.ordinal'), {
          code: 'SQLITE_CONSTRAINT_PRIMARYKEY'
        })
      }
    })
    try {
      failNext = true
      const rejected = sink.execute(submit({ commandId: 'k1', runId: 'run-1', sessionKey: 'sess-1', ordinal: 5 }))
      expect(rejected).toMatchObject({ kind: 'rejected', reason: 'illegal_transition', sticky: true })
      expect(sink.isWriteIndeterminate()).toBe(false)
      expect(sink.getRun('run-1')).toBeUndefined()

      // The rejection receipt is durable, so replaying the same command is a duplicate.
      const replay = sink.execute(submit({ commandId: 'k1', runId: 'run-1', sessionKey: 'sess-1', ordinal: 5 }))
      expect(replay.kind).toBe('duplicate')

      expect(sink.execute(submit({ commandId: 'k2', runId: 'run-2', sessionKey: 'sess-1', ordinal: 1 })).kind).toBe(
        'accepted'
      )
      expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
    } finally {
      sink.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
