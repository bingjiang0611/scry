import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunError, DaemonRunTransport } from './daemon-run-transport'
import { announceRun, subscribedRun } from './daemon-run-subscription.fixtures'

const RUN = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CANONICAL = 'remote-run-mw6osn9o-0'
const liveRun: ActiveRun = { runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [], done: false }

function daemon() {
  const probes: unknown[] = []
  let phase: 'up' | 'outage' | 'restarted' = 'up'
  const onWarn = vi.fn()
  const transport = new DaemonRunTransport(async (payload) => {
    if (payload.op === 'subscribe') {
      probes.push(payload.trackedRunIds)
      return { subscribe: {
        hostId: 'host', logId: 'same-log', seq: 9, mode: 'snapshot',
        snapshot: { activeRuns: { rows: [subscribedRun(RUN, { lifecycle: 'interrupted' })] } }
      } }
    }
    if (payload.op === 'desktop') {
      if (phase === 'outage') throw new DaemonRunError('daemon_outcome_unknown')
      return { desktop: { kind: 'trace', run: phase === 'up' ? liveRun : null } }
    }
    return { error: 'unknown_op' }
  })
  const runtime = new DaemonRunRuntime({ transport, send: () => undefined, onWarn })
  return { runtime, probes, onWarn, outage: () => { phase = 'outage' }, restart: () => { phase = 'restarted' } }
}

describe('daemon run outage and subscription reset', () => {
  it('keeps a failed read visible and finalizes once the restarted daemon reports interruption', async () => {
    const { runtime, outage, restart, probes, onWarn } = daemon()
    try {
      await announceRun(runtime, RUN, { scryRunId: CANONICAL })
      outage()
      await announceRun(runtime, RUN, { scryRunId: CANONICAL, outputSeq: 2 })
      expect(onWarn).toHaveBeenCalledWith('daemon subscribe trace read failed', expect.any(DaemonRunError))
      expect(runtime.activeRuns()).toEqual([expect.objectContaining({ runId: CANONICAL, done: false })])

      restart()
      await runtime.applySubscribeSnapshot([])
      expect(probes).toEqual([[RUN]])
      expect(runtime.runView(CANONICAL)).toMatchObject({ runId: CANONICAL, done: true })
      expect(runtime.activeRuns()).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('does not probe a cursor the window released', async () => {
    const { runtime, outage, restart, probes } = daemon()
    try {
      await announceRun(runtime, RUN, { scryRunId: CANONICAL })
      outage()
      await announceRun(runtime, RUN, { scryRunId: CANONICAL, outputSeq: 2 })
      runtime.release(RUN)
      restart()
      await runtime.applySubscribeSnapshot([])
      expect(probes).toEqual([])
    } finally {
      runtime.dispose()
    }
  })
})
