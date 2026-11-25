import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { sessionQueueBlocksDispatch } from '../../daemon/orchestration-dispatch-queue'
import { EventSink } from './event-sink'
import { findEffectPolicy } from './effect-policy'
import { recoverOrchestrationOnStartup } from './recovery'

describe('A4: an unknown outbox effect kind is failed, not fatal', () => {
  it('resolves an unregistered kind to undefined instead of throwing', () => {
    expect(findEffectPolicy('provider.run.start')?.policy).toBe('process_bound')
    expect(findEffectPolicy('future.unknown_effect')).toBeUndefined()
  })

  it('marks the unknown row failed during recovery and still completes startup', () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-a4-'))
    const sink = EventSink.open({ userDataDir: userData })
    try {
      insertOutboxRow(sink, 'effect-unknown-1', 'future.unknown_effect')
      insertOutboxRow(sink, 'effect-unknown-2', 'future.unknown_effect')

      const summary = recoverOrchestrationOnStartup({ sink, leaseOwner: 'daemon:a4' })
      expect(summary.failedUnknownEffects).toBe(2)

      const rows = sink.listOutbox().filter((row) => row.effectId.startsWith('effect-unknown-'))
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.state).toBe('failed')
        expect(row.lastError).toContain('future.unknown_effect')
      }
      // Startup kept going: the host-start event was committed.
      expect(sink.listEvents().some((event) => event.type === 'host.started')).toBe(true)
    } finally {
      sink.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('cancels the run an unknown effect belonged to, so the session is not wedged', () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-a4-run-'))
    const sink = EventSink.open({ userDataDir: userData })
    try {
      // A run that was accepted but whose dispatch effect this build cannot name. It is not terminal, so
      // the session would stay "busy" forever and every later send would queue behind a run nobody runs.
      const submit = {
        runId: 'run-a4-wedged', sessionKey: 'sess-a4', provider: 'codex' as const, profile: null,
        cwd: '/tmp/ws', claimMode: 'immediate' as const, pendingTtlMs: 30_000, origin: 'remote' as const
      }
      sink.execute({
        type: 'run.submit', commandId: 'c-a4-submit', actor: 'system', scope: 'remote', at: 1,
        payload: submit, payloadSha256: sha256Hex(canonicalJson(submit))
      })
      insertOutboxRow(sink, 'effect-unknown-run', 'future.unknown_effect', 'pending', 'run-a4-wedged')

      recoverOrchestrationOnStartup({ sink, leaseOwner: 'daemon:a4c' })

      expect(sink.getRun('run-a4-wedged')?.lifecycle).toBe('cancelled')
      // And the session can move again: nothing live is left behind.
      expect(sessionQueueBlocksDispatch(sink, 'run-a4-wedged')).toBe(false)
    } finally {
      sink.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('fails an unknown row on the second startup even when the first already failed it', () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-a4-repeat-'))
    const sink = EventSink.open({ userDataDir: userData })
    try {
      insertOutboxRow(sink, 'effect-unknown-3', 'future.unknown_effect')
      insertOutboxRow(sink, 'effect-unknown-4', 'future.unknown_effect', 'failed')
      const summary = recoverOrchestrationOnStartup({ sink, leaseOwner: 'daemon:a4b' })
      // Only non-terminal rows are examined; an already-failed row stays failed and is not recounted.
      expect(summary.failedUnknownEffects).toBe(1)
      expect(sink.listOutbox().filter((row) => row.state === 'failed')).toHaveLength(2)
    } finally {
      sink.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

function insertOutboxRow(sink: EventSink, effectId: string, kind: string, state = 'pending', runId: string | null = null): void {
  const payload = { runId }
  sink.handle.db
    .prepare(
      `INSERT INTO orch_outbox (
        effect_id, kind, policy, run_id, causation_seq, payload, state,
        expires_at, attempts, lease_owner, claimed_at, completed_at, result_seq, last_error
      ) VALUES (?, ?, 'replayable', ?, 1, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL)`
    )
    .run(effectId, kind, runId, canonicalJson(payload), state)
}
