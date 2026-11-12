import { describe, expect, it } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { DaemonRunRefusedError } from './daemon-run-admission'
import { TraceOutputBridge } from './trace-output'

// A daemon start answers after admission, as the in-process start does (B4-V
// trust-gate). The daemon binds a run id before its admission (trust re-verification,
// session conflicts); answering at the bind handed out a run that admission then
// refused, which had no trace and never reached `done`.

const RUN = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const CANONICAL = 'remote-run-mw6osn9o-4'
const CONTEXT = { cwd: '/w', providerId: 'codex' }
const REASON = 'MCP 配置无法安全执行：MCP server b4v_probe 使用可改变执行目标的 env：NODE_OPTIONS'

const bound = { runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: CANONICAL, providerId: 'codex', cwd: '/w' }) }
const admitted = { runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'admitted', ledgerRunId: RUN, scryRunId: CANONICAL }) }
const failed = { runId: RUN, kind: 'run_failed', detail: REASON }
const liveRun: ActiveRun = { runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [], done: false, providerSettled: false }

type Frame = { state: string; events?: unknown[] }

// `frames` are the watch replies in order; the last one repeats. `trace` answers the
// run view: null while the daemon has not registered the run.
function runtimeFor(frames: Frame[], options: { trace?: ActiveRun | null; admitBudgetMs?: number } = {}) {
  let served = 0
  const sent: Array<{ channel: string; payload: unknown }> = []
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded', seq: 1 }
    if (payload.op === 'watch') {
      const index = Math.min(served, frames.length - 1)
      const frame = frames[index]!
      // A frame's entries are read once; a read past the ledger's end carries none.
      const events = index === served ? frame.events ?? [] : []
      if (index === served) served += 1
      return { watch: { state: frame.state, poll: { cursor: index + 1, events } } }
    }
    if (payload.op === 'desktop') return { desktop: { kind: 'trace', run: options.trace ?? null } }
    if (payload.op === 'questions') return { questions: [] }
    return { error: 'unknown_op' }
  }
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: (channel, payload) => sent.push({ channel, payload }),
    bridge: new TraceOutputBridge({ canSend: () => true, send: () => {}, schedule: (fn) => { fn(); return () => {} } }),
    waitMs: 0,
    bindBudgetMs: 500,
    admitBudgetMs: options.admitBudgetMs ?? 2_000
  })
  return { runtime, sent }
}

describe('daemon start waits for admission', () => {
  it('rejects a start the daemon refused before admitting it, with the daemon message, and keeps no run', async () => {
    const { runtime, sent } = runtimeFor([
      { state: 'dispatched', events: [bound] },
      { state: 'failed', events: [failed] }
    ])
    const start = runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT, userText: 'hi' })
    await expect(start).rejects.toBeInstanceOf(DaemonRunRefusedError)
    await expect(start).rejects.toThrow(REASON)
    // The rejection reads like the in-process start's plain Error over IPC.
    await start.catch((error: Error) => expect(error.name).toBe('Error'))
    expect(runtime.runView(CANONICAL)).toBeNull()
    expect(runtime.activeRuns()).toEqual([])
    // Nothing was handed out, so the window gets no failure notice for it either.
    expect(sent.filter((entry) => entry.channel === 'agent:error')).toEqual([])
    runtime.dispose()
  })

  it('answers once the daemon admitted the run', async () => {
    const { runtime } = runtimeFor([
      { state: 'dispatched', events: [bound] },
      { state: 'dispatched', events: [admitted] }
    ], { trace: liveRun })
    await expect(runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })).resolves.toMatchObject({ runId: CANONICAL, bound: true })
    runtime.dispose()
  })

  it('does not take an earlier admission of another run as this one', async () => {
    const other = { runId: 'ffffffff-4a5b-4c6d-8e7f-0a1b2c3d4e5f', kind: 'run_progress', detail: JSON.stringify({ event: 'admitted', scryRunId: 'remote-run-mw6osn9o-9' }) }
    const { runtime } = runtimeFor([
      { state: 'dispatched', events: [other, bound] },
      { state: 'failed', events: [failed] }
    ])
    await expect(runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })).rejects.toThrow(REASON)
    runtime.dispose()
  })

  it('ends a run refused after it was handed out: the view is done with the reason and the window is told', async () => {
    // Admission outlasted the budget (a previous turn of the session still settling),
    // so the start answered bound; the refusal arrives afterwards.
    const frames: Frame[] = [{ state: 'dispatched', events: [bound] }]
    const { runtime, sent } = runtimeFor(frames, { admitBudgetMs: 50 })
    const receipt = await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT, userText: 'hi' })
    expect(receipt).toMatchObject({ runId: CANONICAL, bound: true })
    frames.push({ state: 'failed', events: [failed] })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !runtime.runView(CANONICAL)?.done) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runtime.runView(CANONICAL)).toMatchObject({ runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [], done: true, error: REASON })
    expect(runtime.activeRuns()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent.filter((entry) => entry.channel === 'agent:error').map((entry) => entry.payload)).toEqual([{ runId: CANONICAL, message: REASON }])
    runtime.dispose()
  })

  it('treats a run that ended with no reason and no admission as refused, without spinning', async () => {
    const { runtime } = runtimeFor([
      { state: 'dispatched', events: [bound] },
      { state: 'failed' }
    ])
    await expect(runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })).rejects.toThrow('run_failed')
    runtime.dispose()
  })
})
