import { describe, expect, it, vi } from 'vitest'
import { DaemonRunTransport, type DaemonRequest } from '../daemon-run-transport'
import { DaemonRunRuntime } from '../daemon-run-runtime'
import { createDaemonRunSurface } from './daemon-run-surface'
import type { ActiveRun } from '../../shared/trace'
import type { AgentStartRequest } from '../../shared/runtime'
import type { SubscribeActiveRunRow } from '../../shared/orchestration-subscribe'

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
    }),
    adopt: vi.fn(async (runId: string) => {
      frames.push({ method: 'adopt', runId })
      if (runId === 'run-managed-3') throw new Error('统一对话不能由旧会话入口接管，请打开其稳定对话条目')
      return runId === 'run-abc-1' ? run(runId) : null
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
  const refusal = 'workspace refused by the daemon'
  const row = (fields: Partial<SubscribeActiveRunRow>): SubscribeActiveRunRow => ({
    runId: ledgerId, lifecycle: 'dispatched', cwd: '/w', provider: 'claude', scope: 'local', origin: 'desktop',
    sessionKey: null, profile: null, promptPreview: null, stopState: null, outputSeq: null, intentSeq: 1,
    settledAt: null, recoveredAt: null, outcome: null, revSeq: 2, ...fields
  })

  // The submit reply is lost. The receipt is read back with the read-only intent query,
  // and binding and admission come from the run's projection row and its subscription
  // events (v3 has no watch op), exactly as for a duplicate submit.
  function lostReply(outcome: 'admitted' | 'refused' | 'unbound' | 'unknown', bindBudgetMs = 50) {
    const request = vi.fn<DaemonRequest>(async (frame) => {
      if (frame.op === 'submit') throw new Error('lane_lost')
      if (frame.op === 'intentStatusAtLog') {
        if (outcome === 'unknown') return { error: 'unknown_intent' }
        return { intent: { runId: ledgerId, state: outcome === 'refused' ? 'failed' : 'dispatched' } }
      }
      if (frame.op === 'subscribe') {
        const rows = outcome === 'admitted' ? [row({ scryRunId: canonicalId, admitted: true })]
          : outcome === 'refused' ? [row({ scryRunId: canonicalId })] : []
        if (outcome === 'refused') {
          // The refusal reaches the window as the run's terminal subscription event.
          setTimeout(() => {
            void runtime.applySubscribeEvent({ seq: 3, type: 'run.failed', stream: `run:${ledgerId}`, runId: ledgerId, at: 0, payload: { detail: refusal } })
          }, 0)
        }
        return { subscribe: { hostId: 'h', logId: 'l', seq: 2, mode: 'snapshot', snapshot: { activeRuns: { rows } } } }
      }
      if (frame.op === 'desktop') return { desktop: { kind: 'trace', run: null } }
      throw new Error(`unexpected frame: ${frame.op}`)
    })
    const transport = new DaemonRunTransport(request)
    const send = vi.fn()
    const runtime: DaemonRunRuntime = new DaemonRunRuntime({ transport, send, bindBudgetMs, admitBudgetMs: 2_000 })
    const value = createDaemonRunSurface({ transport, runtime, send, currentCwd: () => '/w' })
    return { value, runtime, request, send }
  }

  it('recovers a lost submit reply without resubmitting and only focuses the canonical Run', async () => {
    const { value, runtime, request, send } = lostReply('admitted')
    try {
      await expect(value.start(payload, 'intent-fixed-1')).resolves.toEqual({ runId: canonicalId, commandStatus: 'executed' })
      expect(request.mock.calls.filter(([frame]) => frame.op === 'submit')).toHaveLength(1)
      const submit = request.mock.calls.find(([frame]) => frame.op === 'submit')?.[0]
      expect(request).toHaveBeenCalledWith({ op: 'intentStatusAtLog', intentId: submit?.intentId }, undefined)
      expect(send.mock.calls.filter(([channel]) => channel === 'agent:focusedRun'))
        .toEqual([['agent:focusedRun', expect.objectContaining({ runId: canonicalId })]])
      // Recovery follows the same run as a fresh start: its live trace is read, not adopted once.
      await vi.waitFor(() => expect(request.mock.calls.some(([frame]) => frame.op === 'desktop')).toBe(true))
    } finally {
      runtime.dispose()
    }
  })

  it('waits for subscription binding and admission after recovering a receipt', async () => {
    const { value, runtime, request, send } = lostReply('unbound', 2_000)
    try {
      const start = value.start(payload, 'intent-subscribe')
      await vi.waitFor(() => expect(request.mock.calls.some(([frame]) => frame.op === 'subscribe')).toBe(true))
      await vi.waitFor(() => expect(runtime.isTracking(ledgerId)).toBe(true))
      expect(send).not.toHaveBeenCalledWith('agent:focusedRun', expect.anything())
      await runtime.applySubscribeSnapshot([row({ scryRunId: canonicalId, admitted: true })])
      await expect(start).resolves.toEqual({ runId: canonicalId, commandStatus: 'executed' })
      expect(send).toHaveBeenCalledWith('agent:focusedRun', expect.objectContaining({ runId: canonicalId }))
      await vi.waitFor(() => expect(request.mock.calls.map(([frame]) => frame.op)).toEqual(['submit', 'intentStatusAtLog', 'subscribe', 'desktop']))
    } finally {
      runtime.dispose()
    }
  })

  it.each([
    ['refused', { message: refusal }],
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
    const start = vi.fn(async (input: { intentId: string }) => ({ intentId: input.intentId, runId: 'run-abc-1', bound: true, status: 'duplicate', seq: 243 }))
    const runtime = { start } as unknown as DaemonRunRuntime
    const value = createDaemonRunSurface({ transport, runtime, currentCwd: () => '/w' })
    await expect(value.start(payload, 'fixed-intent'))
      .resolves.toEqual({ runId: 'run-abc-1', commandStatus: 'duplicate', commandSequence: 243 })
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

  it('raises the daemon refusal to adopt a unified conversation run, and does not show it', async () => {
    const { value } = surface({ live: [run('run-managed-3')] })
    await expect(value.adopt('run-managed-3')).rejects.toThrow('统一对话不能由旧会话入口接管')
    await expect(value.focusedRunSnapshot()).resolves.toBeNull()
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
