import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { RunTraceEvent } from '../shared/run-traces'
import { RunRegistry } from './run-registry'
import { RunTraceRouter } from './run-trace-router'
import type { RunControl } from './bootstrap/run-control'

// P3f W2: in daemon mode the conversation view subscribes to runs this window follows
// from its daemon, which its own registry never holds.

const runState = (runId: string, extra: Partial<ActiveRun> = {}): ActiveRun =>
  ({ runId, providerId: 'claude', cwd: '/workspace', userText: runId, items: [], done: false, providerSettled: false, ...extra })
const event = (runId: string, id: string): TraceEvent => ({ id, ts: new Date().toISOString(), runId, kind: 'model', stage: 'text' })

function harness() {
  const runs = new RunRegistry<ActiveRun, RunControl>()
  const sent: RunTraceEvent[] = []
  const timers: Array<() => void> = []
  const router = new RunTraceRouter({
    runs, boundedLiveRun: (run) => run, canSend: () => true, send: (value) => sent.push(value),
    schedule: (fn) => { timers.push(fn); return () => { const index = timers.indexOf(fn); if (index >= 0) timers.splice(index, 1) } }
  })
  return {
    router, sent,
    add: (runId: string) => { runs.register(runState(runId), { runId } as unknown as RunControl) },
    runTimers: () => { for (const timer of timers.splice(0)) timer() },
    traceEvents: (subscriptionId: string) => sent.flatMap((value) =>
      value.kind === 'trace' && value.subscriptionId === subscriptionId ? value.batch.events : [])
  }
}

describe('a second run source (daemon mode, P3f W2)', () => {
  it('subscribes to a run only that source knows, streams it, and ends it like its own', () => {
    const h = harness()
    let daemonRun: ActiveRun | undefined = runState('3f2b8c1d-5e6a-4b7c-8d9e-0f1a2b3c4d5e')
    const detach = h.router.attachRuns({ get: (runId) => daemonRun && runId === daemonRun.runId ? { state: daemonRun } : undefined })
    const result = h.router.subscribe({ runId: '3f2b8c1d-5e6a-4b7c-8d9e-0f1a2b3c4d5e', subscriptionId: 'sub-daemon' })
    expect(result).toMatchObject({ status: 'subscribed', run: { runId: '3f2b8c1d-5e6a-4b7c-8d9e-0f1a2b3c4d5e' } })
    h.router.route(event('3f2b8c1d-5e6a-4b7c-8d9e-0f1a2b3c4d5e', 'e-1'))
    h.runTimers()
    expect(h.traceEvents('sub-daemon').map((item) => item.id)).toEqual(['e-1'])
    daemonRun = { ...daemonRun!, done: true }
    h.router.settle('3f2b8c1d-5e6a-4b7c-8d9e-0f1a2b3c4d5e')
    expect(h.sent.at(-1)).toMatchObject({ kind: 'terminal', subscriptionId: 'sub-daemon', run: { done: true } })
    // Detached (the daemon connection went away): a new subscription finds nothing.
    h.router.unsubscribe('sub-daemon')
    detach()
    expect(h.router.subscribe({ runId: '3f2b8c1d-5e6a-4b7c-8d9e-0f1a2b3c4d5e', subscriptionId: 'sub-later' })).toEqual({ status: 'unavailable' })
  })

  it('still prefers its own registry', () => {
    const h = harness()
    h.add('run-main')
    h.router.attachRuns({ get: () => ({ state: runState('run-main', { userText: 'from the daemon' }) }) })
    expect(h.router.subscribe({ runId: 'run-main', subscriptionId: 'sub-main' })).toMatchObject({ run: { userText: 'run-main' } })
  })
})
