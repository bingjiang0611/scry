import { describe, expect, it, vi } from 'vitest'
import { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import type { RecorderTerminalEvidence } from '../host-runtime/orchestration/recovery'
import { createAuthorityRunTerminalHandler, settleRunTerminal } from './orchestration-run-terminal'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function evidence(overrides: Partial<RecorderTerminalEvidence> = {}): RecorderTerminalEvidence {
  return {
    outcome: 'settled',
    settledAt: 1_700_000_002_000,
    contentRef: 'trace-archive-turns-v1/claude/cwd-x/sess/turn-abc.json',
    evidence: ['trace-archive:turn-abc.json'],
    ...overrides
  }
}

function collect(order: string[]): {
  writes: {
    providerSettled: () => void
    finalized: (e: RecorderTerminalEvidence) => void
    terminal: (e?: RecorderTerminalEvidence) => void
  }
} {
  return {
    writes: {
      providerSettled: () => order.push('provider_settled'),
      finalized: (e) => order.push(`finalized:${e.outcome}`),
      terminal: () => order.push('terminal')
    }
  }
}

describe('A3: live runs settle with ordered recorder evidence', () => {
  it('writes provider_settled, terminal, then finalized when the archive is already durable', () => {
    const order: string[] = []
    settleRunTerminal({
      ...collect(order),
      findEvidence: () => evidence(),
      deadlineMs: 1_000,
      intervalMs: 10,
      schedule: () => {
        throw new Error('must not schedule when evidence exists')
      }
    })
    expect(order).toEqual(['provider_settled', 'terminal', 'finalized:settled'])
  })

  it('writes one terminal event immediately and keeps looking for the archive in the background', () => {
    const order: string[] = []
    let attempts = 0
    const timers: Array<() => void> = []
    settleRunTerminal({
      ...collect(order),
      findEvidence: () => {
        attempts += 1
        return attempts >= 3 ? evidence({ outcome: 'failed', reason: 'tool_error' }) : undefined
      },
      deadlineMs: 60_000,
      intervalMs: 5,
      schedule: (fn) => timers.push(fn)
    })
    expect(order).toEqual(['provider_settled', 'terminal'])
    while (timers.length) timers.shift()!()
    expect(order).toEqual(['provider_settled', 'terminal', 'finalized:failed'])
    expect(attempts).toBe(3)
  })

  it('writes the terminal event without finalized when the archive never appears', () => {
    const order: string[] = []
    const timers: Array<() => void> = []
    let now = 1_000
    const realNow = Date.now
    Date.now = () => now
    try {
      settleRunTerminal({
        ...collect(order),
        findEvidence: () => undefined,
        deadlineMs: 100,
        intervalMs: 50,
        schedule: (fn) => timers.push(fn)
      })
      now += 200
      timers.shift()!()
      expect(order).toEqual(['provider_settled', 'terminal'])
    } finally {
      Date.now = realNow
    }
  })
})

describe('A3: daemon hook records the live-run sequence against the orchestration store', () => {
  it('records provider_settled, a terminal lifecycle, then finalized evidence for the session outcome', () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-a3-'))
    const sink = EventSink.open({ userDataDir: userData })
    try {
      const engine = new AuthorityEngine({ sink, leaseOwner: 'daemon:test' })
      const handler = createAuthorityRunTerminalHandler({
        engine,
        liveRunMeta: () => ({ admitted: true, scryRunId: 'app-run-1' }),
        resolveCanonical: (runId) => runId,
        findRecorderEvidence: () => evidence(),
        schedule: vi.fn(),
        evidenceFor: (step) => [step === 'cancelled' ? 'host.run_completion' : 'provider'],
        releaseRun: () => undefined
      })

      const runId = insertDispatchedRun(sink)
      handler(runId, 'settled')

      const events = sink.listEvents().filter((row) => row.runId === runId).map((row) => row.type)
      expect(events).toEqual([
        'run.intent_recorded',
        'turn.began',
        'run.admitted',
        'run.dispatched',
        'run.provider_settled',
        'run.settled',
        'turn.delivery',
        'run.finalized'
      ])
      const run = sink.getRun(runId)!
      // The Provider exit proves the lifecycle; the archive promotes the session outcome to exact.
      expect(run.outcome).toMatchObject({ status: 'available', quality: 'inferred', value: 'settled' })
      expect(sink.getSession('sess-a3')?.lastRunOutcome).toMatchObject({
        status: 'available',
        quality: 'exact',
        value: 'settled',
        source: ['trace-archive:turn-abc.json']
      })
      expect(sink.getTurnByRunId(runId)?.evidence).toContain('trace-archive:turn-abc.json')
      expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
    } finally {
      sink.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

function insertDispatchedRun(sink: EventSink): string {
  const runId = 'run-a3-1'
  const submitPayload = {
    runId,
    sessionKey: 'sess-a3',
    ordinal: 1,
    provider: 'claude',
    profile: 'default',
    cwd: '/tmp/ws',
    claimMode: 'immediate' as const,
    dispatchImmediately: true,
    leaseOwner: 'daemon:test'
  }
  sink.execute({
    type: 'session.create',
    commandId: 'a3-session',
    actor: 'system',
    scope: 'system',
    at: 1_700_000_000_000,
    payload: { sessionKey: 'sess-a3', provider: 'claude', profile: 'default', cwd: '/tmp/ws', title: 'A3' },
    payloadSha256: sha('a3-session')
  })
  sink.execute({
    type: 'run.submit',
    commandId: 'a3-submit',
    actor: 'system',
    scope: 'system',
    at: 1_700_000_001_000,
    payload: submitPayload,
    payloadSha256: sha(JSON.stringify(submitPayload))
  })
  return runId
}

function sha(seed: string): string {
  // Deterministic 64-hex digest without importing crypto helpers under test.
  let out = ''
  for (let i = 0; i < 64; i += 1) {
    out += '0123456789abcdef'[(seed.charCodeAt(i % seed.length) + i) % 16]
  }
  return out
}
