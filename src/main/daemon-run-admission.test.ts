import { describe, expect, it, vi } from 'vitest'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { DaemonRunRefusedError } from './daemon-run-admission'
import { announceRun, runEvent } from './daemon-run-subscription.fixtures'

const RUN = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const CANONICAL = 'remote-run-mw6osn9o-4'
const CONTEXT = { cwd: '/w', providerId: 'codex' }
const REASON = 'MCP 配置无法安全执行：MCP server b4v_probe 使用可改变执行目标的 env：NODE_OPTIONS'

async function startRun(admitBudgetMs = 2_000) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const transport = new DaemonRunTransport(async (payload) => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded', seq: 1 }
    if (payload.op === 'desktop') return { desktop: { kind: 'trace', run: null } }
    return { error: 'unknown_op' }
  })
  const runtime = new DaemonRunRuntime({
    transport, send: (channel, payload) => sent.push({ channel, payload }),
    bindBudgetMs: 500, admitBudgetMs
  })
  const receipt = runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT, userText: 'hi' })
  await vi.waitFor(() => expect(runtime.isTracking(RUN)).toBe(true), { interval: 1 })
  await announceRun(runtime, RUN, { scryRunId: CANONICAL, admitted: false })
  const fail = (detail?: string) => runtime.applySubscribeEvent(runEvent('run.failed', RUN, detail ? { detail } : {}))
  return { runtime, sent, receipt, fail }
}

describe('daemon start waits for subscribed admission', () => {
  it('rejects a start the daemon refused before admission, with its message and no active view', async () => {
    const { runtime, sent, receipt, fail } = await startRun()
    const rejected = expect(receipt).rejects.toBeInstanceOf(DaemonRunRefusedError)
    await fail(REASON)
    await rejected
    await expect(receipt).rejects.toThrow(REASON)
    await receipt.catch((error: Error) => expect(error.name).toBe('Error'))
    expect(runtime.runView(CANONICAL)).toBeNull()
    expect(runtime.activeRuns()).toEqual([])
    expect(sent.filter((entry) => entry.channel === 'agent:error')).toEqual([])
    runtime.dispose()
  })

  it('answers once the daemon admitted the run', async () => {
    const { runtime, receipt } = await startRun()
    const received = vi.fn()
    void receipt.then(received)
    expect(received).not.toHaveBeenCalled()
    await announceRun(runtime, RUN, { scryRunId: CANONICAL })
    await expect(receipt).resolves.toMatchObject({ runId: CANONICAL, bound: true })
    runtime.dispose()
  })

  it('does not take another run’s admission as this one', async () => {
    const { runtime, receipt, fail } = await startRun()
    const rejected = expect(receipt).rejects.toThrow(REASON)
    await announceRun(runtime, 'ffffffff-4a5b-4c6d-8e7f-0a1b2c3d4e5f', { scryRunId: 'remote-run-mw6osn9o-9' })
    await fail(REASON)
    await rejected
    runtime.dispose()
  })

  it('ends a run refused after it was handed out and tells the window why', async () => {
    const { runtime, sent, receipt, fail } = await startRun(50)
    await expect(receipt).resolves.toMatchObject({ runId: CANONICAL, bound: true })
    await fail(REASON)
    expect(runtime.runView(CANONICAL)).toMatchObject({
      runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [], done: true, error: REASON
    })
    expect(runtime.activeRuns()).toEqual([])
    expect(sent.filter((entry) => entry.channel === 'agent:error').map((entry) => entry.payload))
      .toEqual([{ runId: CANONICAL, message: REASON }])
    runtime.dispose()
  })

  it('treats a terminal failure without an admission or a reason as refused', async () => {
    const { runtime, receipt, fail } = await startRun()
    const rejected = expect(receipt).rejects.toThrow('run_failed')
    await fail()
    await rejected
    runtime.dispose()
  })
})
