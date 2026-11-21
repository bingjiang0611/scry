import { describe, expect, it, vi } from 'vitest'
import { DaemonRunTransport, type DaemonRequest } from '../daemon-run-transport'
import { DaemonRunRuntime } from '../daemon-run-runtime'
import { createDaemonRunSurface } from './daemon-run-surface'
import type { ActiveRun } from '../../shared/trace'
import type { AgentStartRequest } from '../../shared/runtime'

// The App's run controls in daemon mode. The registry is in the daemon, so these must
// become frames - and an answer the App cannot read must be reported, never shown as
// "sent".

const run = (runId: string): ActiveRun => ({ runId, state: 'running', providerId: 'claude', cwd: '/w', items: [] } as unknown as ActiveRun)

function surface(overrides: Partial<DaemonRunTransport> & { live?: ActiveRun[] } = {}) {
  const frames: Array<Record<string, unknown>> = []
  const transport = {
    runControl: vi.fn(async (request: Record<string, unknown>) => {
      frames.push(request)
      if (request.method === 'steer') return { steer: { status: 'accepted', messageId: 'm-1' } }
      if (request.method === 'stopBackgroundTask') return { backgroundTask: { status: 'requested', message: '' } }
      if (request.runId === 'run-abc-1') return { run: run('run-abc-1') }
      return { run: null }
    }),
    liveRuns: vi.fn(async () => ({ runs: overrides.live ?? [] }))
  } as unknown as DaemonRunTransport
  const runtime = {
    activeRuns: () => (overrides.live ?? []),
    runView: (runId: string) => (overrides.live ?? []).find((entry) => entry.runId === runId) ?? null,
    isTracking: () => true,
    adopt: vi.fn(async () => undefined)
  } as unknown as DaemonRunRuntime
  return { value: createDaemonRunSurface({ transport, runtime, currentCwd: () => '/w' }), frames }
}

describe('daemon run surface start reconciliation', () => {
  const ledgerId = 'run-ledger-1'
  const canonicalId = 'remote-run-start-1'
  const payload: AgentStartRequest = { prompt: 'go', providerId: 'claude', cwd: '/w' }
  const bound = { runId: ledgerId, kind: 'run_progress', detail: JSON.stringify({
    event: 'bound', ledgerRunId: ledgerId, scryRunId: canonicalId, cwd: '/w', providerId: 'claude'
  }) }
  const admitted = { runId: ledgerId, kind: 'run_progress', detail: JSON.stringify({ event: 'admitted' }) }
  const refused = { runId: ledgerId, kind: 'run_failed', detail: 'workspace refused by the daemon' }

  function lostReply(outcome: 'admitted' | 'refused' | 'unbound' | 'unknown', subscribeMode = false) {
    let watches = 0
    const request = vi.fn<DaemonRequest>(async (frame) => {
      if (frame.op === 'submit') throw new Error('lane_lost')
      if (frame.op === 'intentStatus') {
        if (outcome === 'unknown') return { error: 'unknown_intent' }
        return { intent: { runId: ledgerId, state: outcome === 'refused' ? 'failed' : 'dispatched' } }
      }
      if (frame.op === 'watch') {
        const cursor = ++watches
        const events = outcome === 'admitted' && cursor === 1 ? [bound, admitted]
          : outcome === 'refused' && cursor === 1 ? [bound, refused] : []
        const state = outcome === 'refused' ? 'failed' : outcome === 'unbound' || cursor > 1 ? 'settled' : 'dispatched'
        return { watch: { state, poll: { cursor, events } } }
      }
      if (frame.op === 'desktop') return { desktop: { kind: 'trace', run: null } }
      if (frame.op === 'questions') return { questions: [] }
      throw new Error(`unexpected frame: ${frame.op}`)
    })
    const transport = new DaemonRunTransport(request)
    const send = vi.fn()
    const runtime = new DaemonRunRuntime({ transport, send, subscribeMode, waitMs: 100, bindBudgetMs: subscribeMode ? 2_000 : 50 })
    const value = createDaemonRunSurface({ transport, runtime, send, currentCwd: () => '/w' })
    return { value, runtime, request, send }
  }

  it('recovers a lost submit reply without resubmitting and only focuses the canonical Run', async () => {
    const { value, runtime, request, send } = lostReply('admitted')
    try {
      await expect(value.start(payload, 'intent-fixed-1')).resolves.toEqual({ runId: canonicalId })
      expect(request.mock.calls.filter(([frame]) => frame.op === 'submit')).toHaveLength(1)
      const submit = request.mock.calls.find(([frame]) => frame.op === 'submit')?.[0]
      expect(request).toHaveBeenCalledWith({ op: 'intentStatus', intentId: submit?.intentId }, undefined)
      expect(send.mock.calls.filter(([channel]) => channel === 'agent:focusedRun'))
        .toEqual([['agent:focusedRun', expect.objectContaining({ runId: canonicalId })]])
      // Legacy recovery starts the same pump as a fresh start rather than adopting once.
      await vi.waitFor(() => expect(request.mock.calls.some(([frame]) =>
        frame.op === 'watch' && Number(frame.cursor) > 0
      )).toBe(true))
    } finally {
      runtime.dispose()
    }
  })

  it('waits for subscription binding and admission after recovering a receipt', async () => {
    const { value, runtime, request, send } = lostReply('admitted', true)
    try {
      const start = value.start(payload, 'intent-subscribe')
      await vi.waitFor(() => expect(runtime.isTracking(ledgerId)).toBe(true))
      expect(send).not.toHaveBeenCalledWith('agent:focusedRun', expect.anything())
      await runtime.applySubscribeSnapshot([
        {
          runId: ledgerId, scryRunId: canonicalId, lifecycle: 'dispatched', admitted: true,
          cwd: '/w', provider: 'claude', scope: 'local', origin: 'desktop', sessionKey: null, profile: null,
          promptPreview: null, stopState: null, outputSeq: null, intentSeq: 1, settledAt: null,
          recoveredAt: null, outcome: null, revSeq: 2
        }
      ])
      await expect(start).resolves.toEqual({ runId: canonicalId })
      expect(send).toHaveBeenCalledWith('agent:focusedRun', expect.objectContaining({ runId: canonicalId }))
      expect(request.mock.calls.map(([frame]) => frame.op)).toEqual(['submit', 'intentStatus', 'desktop'])
    } finally {
      runtime.dispose()
    }
  })

  it.each([
    ['refused', { message: refused.detail }],
    ['unbound', { message: 'daemon_run_not_bound' }],
    ['unknown', { reason: 'daemon_submit_unknown' }]
  ] as const)('does not focus or resubmit a %s recovered start', async (outcome, error) => {
    const { value, runtime, request, send } = lostReply(outcome)
    try {
      await expect(value.start(payload, 'intent-fixed-2')).rejects.toMatchObject(error)
      expect(request.mock.calls.filter(([frame]) => frame.op === 'submit')).toHaveLength(1)
      expect(send).not.toHaveBeenCalledWith('agent:focusedRun', expect.anything())
    } finally {
      runtime.dispose()
    }
  })

  it('derives the same intent from the caller key on retry', async () => {
    const transport = new DaemonRunTransport(async () => { throw new Error('unexpected request') })
    const start = vi.fn(async (input: { intentId: string }) => ({ intentId: input.intentId, runId: 'run-abc-1', bound: true }))
    const runtime = { start } as unknown as DaemonRunRuntime
    const value = createDaemonRunSurface({ transport, runtime, currentCwd: () => '/w' })
    await value.start(payload, 'fixed-intent')
    await value.start(payload, 'fixed-intent')
    await value.start(payload, 'other-intent')
    expect(start.mock.calls[0]?.[0].intentId).toBe(start.mock.calls[1]?.[0].intentId)
    expect(start.mock.calls[0]?.[0].intentId).not.toBe(start.mock.calls[2]?.[0].intentId)
  })
})

describe('daemon run surface controls', () => {
  it('forwards a steer to the daemon that owns the run', async () => {
    const { value, frames } = surface()
    await expect(value.steer({ runId: 'run-abc-1', messageId: 'm-1', prompt: 'go' }))
      .resolves.toEqual({ status: 'accepted', messageId: 'm-1' })
    expect(frames[0]).toEqual({ method: 'steer', payload: { runId: 'run-abc-1', messageId: 'm-1', prompt: 'go' } })
  })

  it('forwards a background-task stop and keeps the daemon wording', async () => {
    const { value, frames } = surface()
    await expect(value.stopBackgroundTask({ runId: 'run-abc-1', taskId: 't-1' }))
      .resolves.toEqual({ status: 'requested', message: '' })
    expect(frames[0]).toEqual({ method: 'stopBackgroundTask', payload: { runId: 'run-abc-1', taskId: 't-1' } })
  })

  it('adopts a live run and shows it afterwards', async () => {
    const { value, frames } = surface({ live: [run('run-abc-1'), run('run-def-2')] })
    await expect(value.adopt('run-abc-1')).resolves.toMatchObject({ runId: 'run-abc-1' })
    expect(frames[0]).toEqual({ method: 'adopt', runId: 'run-abc-1' })
    // Adopting is a view decision: the focused read now answers with that run.
    await expect(value.focusedRunSnapshot()).resolves.toMatchObject({ runId: 'run-abc-1' })
  })

  it('keeps the focused run readable after it finished', async () => {
    // `agent:activeRun` answers null for a finished run; `agent:focusedRunSnapshot`
    // exists precisely to still hand back the whole event list afterwards, so the
    // renderer can re-align when it skipped the terminal event.
    const finished = { ...run('remote-run-abc-1'), done: true }
    const transport = {} as unknown as DaemonRunTransport
    const runtime = {
      activeRuns: () => [],
      runView: (runId: string) => runId === 'remote-run-abc-1' ? finished : null
    } as unknown as DaemonRunRuntime
    const value = createDaemonRunSurface({ transport, runtime, currentCwd: () => '/w' })
    await value.focusRun('remote-run-abc-1')
    await expect(value.activeRun()).resolves.toBeNull()
    await expect(value.focusedRunSnapshot()).resolves.toMatchObject({ runId: 'remote-run-abc-1', done: true })
  })

  it('reports a run the daemon no longer knows as absent, not as adopted', async () => {
    const { value } = surface()
    await expect(value.adopt('run-def-2')).resolves.toBeNull()
  })

  it('refuses an answer it cannot read instead of inventing a control result', async () => {
    const transport = { runControl: vi.fn(async () => ({ steer: { nothing: true } })) } as unknown as DaemonRunTransport
    const runtime = { activeRuns: () => [] } as unknown as DaemonRunRuntime
    const value = createDaemonRunSurface({ transport, runtime, currentCwd: () => undefined })
    await expect(value.steer({ runId: 'run-abc-1' })).rejects.toThrow('daemon_run_control_unavailable')
  })

  it('announces a started run to the window as agent:focusedRun, like the in-process App', async () => {
    const transport = {} as unknown as DaemonRunTransport
    const runtime = {
      start: vi.fn(async (input: { intentId: string }) => ({ intentId: input.intentId, runId: 'run-focus-1', bound: true })),
      runView: (runId: string) => run(runId),
      adopt: vi.fn(), activeRuns: () => [], isTracking: () => true
    } as unknown as DaemonRunRuntime
    const send = vi.fn()
    const value = createDaemonRunSurface({ transport, runtime, currentCwd: () => '/w', send })
    await value.start({ prompt: 'go', providerId: 'claude', cwd: '/w' }, 'intent-focus-1')
    expect(send).toHaveBeenCalledWith('agent:focusedRun', expect.objectContaining({ runId: 'run-focus-1', cwd: '/w' }))
  })

  it('announces from the start context when the window has not read the run yet', async () => {
    const runtime = {
      start: vi.fn(async (input: { intentId: string }) => ({ intentId: input.intentId, runId: 'run-focus-2', bound: true })),
      runView: () => null,
      adopt: vi.fn(), activeRuns: () => [], isTracking: () => true
    } as unknown as DaemonRunRuntime
    const send = vi.fn()
    const value = createDaemonRunSurface({ transport: {} as unknown as DaemonRunTransport, runtime, currentCwd: () => '/w', send })
    await value.start({ prompt: 'hello', providerId: 'codex', cwd: '/w' }, 'intent-focus-2')
    expect(send).toHaveBeenCalledWith('agent:focusedRun', {
      runId: 'run-focus-2', cwd: '/w', providerId: 'codex', userText: 'hello', items: [], done: false
    })
  })
})
