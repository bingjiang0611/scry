import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunError, DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'

// B4-V sigkill: the daemon is frozen and then SIGKILLed while the window follows one of
// its runs. A read that was on the wire dies with it (a watch is not replayable, so it
// fails as an unknown outcome) and the run's pump ends. The relaunched daemon records
// the run as failed (host_restarted), and the App's event feed comes back with a reset,
// which means "notices may have been lost: every run re-reads" (wakeAll). A pump that
// already ended on the outage was not re-read, so the window listed the run as running
// for as long as it stayed open - while the ledger said failed.

const RUN = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CANONICAL = 'remote-run-mw6osn9o-0'
const CONTEXT = { cwd: '/w', providerId: 'codex' }
const text: TraceEvent = { id: 'e-1', ts: '2024-01-01T00:00:00.000Z', runId: CANONICAL, kind: 'model', stage: 'text', text: 'holding' }
const liveRun: ActiveRun = { runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [text], done: false, providerSettled: false }
const bound = JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: CANONICAL, providerId: 'codex', cwd: '/w' })
const admitted = JSON.stringify({ event: 'admitted', ledgerRunId: RUN })

function daemon() {
  // `up`: the first daemon; once `frozen`, its next watch is held (a frozen daemon
  // answers nothing).
  // `restarted`: the relaunched daemon; its ledger holds the run as failed, and it never
  // registered the run, so the trace has none.
  const state = { phase: 'up' as 'up' | 'restarted', frozen: false, held: 0, watches: 0, kill: (_error: Error) => {} }
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded', seq: 1 }
    if (payload.op === 'questions') return { questions: [] }
    if (payload.op === 'watch') {
      state.watches += 1
      if (state.phase === 'restarted') {
        return { watch: { state: 'failed', poll: { cursor: 9, events: [{ runId: RUN, kind: 'run_failed', detail: 'host_restarted' }] } } }
      }
      if (!state.frozen) {
        return { watch: { state: 'dispatched', poll: { cursor: 2, events: [
          { runId: RUN, kind: 'run_progress', detail: bound }, { runId: RUN, kind: 'run_progress', detail: admitted }
        ] } } }
      }
      state.held += 1
      return await new Promise((_resolve, reject) => { state.kill = reject })
    }
    if (payload.op === 'desktop') {
      return state.phase === 'up'
        ? { desktop: { kind: 'trace', run: liveRun, cursor: { revision: 'r1', count: 1 } } }
        : { desktop: { kind: 'trace', run: null } }
    }
    return { error: 'unknown_op' }
  }
  return { state, request }
}

function runtimeOver(request: (payload: Record<string, unknown>) => Promise<unknown>, onWarn = vi.fn()) {
  return new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: () => {},
    bridge: new TraceOutputBridge({ canSend: () => true, send: () => {}, schedule: (fn) => { fn(); return () => {} } }),
    waitMs: 0,
    onWarn
  })
}

describe('daemon run outage (the window converges on the relaunched daemon\'s ledger)', () => {
  it('re-reads a run whose pump ended on the outage once notices resume', async () => {
    const { state, request } = daemon()
    const onWarn = vi.fn()
    const runtime = runtimeOver(request, onWarn)
    try {
      await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
      state.frozen = true
      await vi.waitFor(() => expect(state.held).toBe(1))
      // SIGKILL: the held read fails as an unknown outcome and the pump ends.
      state.kill(new DaemonRunError('daemon_outcome_unknown'))
      await vi.waitFor(() => expect(onWarn).toHaveBeenCalledWith('daemon run pump stopped', expect.any(DaemonRunError)))
      expect(runtime.activeRuns()).toEqual([expect.objectContaining({ runId: CANONICAL, done: false })])

      // The relaunched daemon answers; the event feed's reset wakes every run.
      state.phase = 'restarted'
      runtime.wakeAll()
      await vi.waitFor(() => expect(runtime.runView(CANONICAL)).toMatchObject({ runId: CANONICAL, done: true }))
      expect(runtime.activeRuns()).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('does not bring back a run the window released', async () => {
    const { state, request } = daemon()
    const runtime = runtimeOver(request)
    try {
      await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
      state.frozen = true
      await vi.waitFor(() => expect(state.held).toBe(1))
      state.kill(new DaemonRunError('daemon_outcome_unknown'))
      runtime.release(RUN)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const before = state.watches
      state.phase = 'restarted'
      runtime.wakeAll()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(state.watches).toBe(before)
    } finally {
      runtime.dispose()
    }
  })
})
