import { join } from 'node:path'
import { expect } from 'vitest'
import { canonicalJson, sha256Hex } from '../src/host-runtime/orchestration/canonical-json'
import { EventSink } from '../src/host-runtime/orchestration/event-sink'
import type { Fixture, Scenario } from './performance-baseline-fixture'

/** P4-2 pre-first-token orchestration commit budget scenario (P95 <= 8 ms absolute). */
export function createOrchestrationPreFirstTokenScenario(fixture: Fixture): Scenario {
  let seq = 0
  let sink: EventSink | undefined
  const getSink = (): EventSink => {
    if (!sink) {
      sink = EventSink.open({
        userDataDir: join(fixture.root, 'orch-bench'),
        fullfsync: false,
        checkpointFullfsync: true,
        checkpointIntervalMs: 0,
        maxActiveRuns: 10_000
      })
    }
    return sink
  }
  return {
    lane: 'disk',
    workload: 'orchestration-pre-first-token=2-commits;fullfsync=false',
    iterations: 2,
    warmups: 1,
    samples: 20,
    run: () => {
      const s = getSink()
      const id = ++seq
      const runId = `orch-bench-run-${id}`
      const now = 1_700_000_000_000 + id
      const submitPayload = {
        runId,
        sessionKey: `orch-bench-sess-${id}`,
        ordinal: 1,
        provider: 'codex',
        profile: null,
        cwd: fixture.workspace,
        promptPreview: 'fixed orchestration pre-first-token prompt',
        claimMode: 'immediate' as const,
        leaseOwner: 'bench',
        origin: 'remote' as const
      }
      const s1 = s.execute({
        type: 'run.submit',
        commandId: `bench-cmd-${id}`,
        actor: 'system',
        scope: 'remote',
        at: now,
        payload: submitPayload,
        payloadSha256: sha256Hex(canonicalJson(submitPayload))
      })
      expect(s1.kind).toBe('accepted')
      const dispPayload = { runId, step: 'admitted_and_dispatched' as const }
      const s2 = s.execute({
        type: 'run.effect_result',
        commandId: `bench-disp-${id}`,
        actor: `effect:${runId}`,
        scope: 'system',
        at: now + 1,
        payload: dispPayload,
        payloadSha256: sha256Hex(canonicalJson(dispPayload))
      })
      expect(s2.kind).toBe('accepted')
      return { commits: 2, events: 3, outboxRows: 1 }
    }
  }
}
