import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import { TraceOutputBridge } from './trace-output'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { announceRun, runEvent } from './daemon-run-subscription.fixtures'

const RUN = '7b0b4f2c-1c4d-4a3f-9a2e-2f2c1a4b5d6e'
const event = (text: string): TraceEvent => ({ id: `e-${text}`, ts: '2024-01-01T00:00:00.000Z', runId: RUN, kind: 'model', stage: 'text', text })
const run = (items: TraceEvent[], done = false): ActiveRun => ({ runId: RUN, providerId: 'claude', cwd: '/w', userText: 'hi', items, done, providerSettled: false })

function fixture(input?: { holdTrace?: Promise<void>; onTerminalRead?: () => void }) {
  let traceCalls = 0
  const delivered: string[] = []
  const beforeFlush: boolean[] = []
  const transport = new DaemonRunTransport(async (payload) => {
    if (payload.op !== 'desktop') return { error: 'unknown_op' }
    if (traceCalls++ === 0) {
      return { desktop: { kind: 'trace', run: run([event('one')]), cursor: { revision: 'r1', count: 1 } } }
    }
    input?.onTerminalRead?.()
    await input?.holdTrace
    return { desktop: { kind: 'trace_delta', run: run([], true), base: 'r1', revision: 'r2', count: 2, changes: [{ index: 1, item: event('two') }] } }
  })
  const bridge = new TraceOutputBridge({
    canSend: () => true,
    send: (batch) => delivered.push(...batch.events.flatMap((entry) => entry.text ? [entry.text] : [])),
    schedule: () => {
      if (traceCalls > 1) beforeFlush.push(runtime.runView(RUN)?.done === true && !delivered.includes('two'))
      return () => undefined
    }
  })
  const runtime = new DaemonRunRuntime({ transport, send: () => undefined, bridge })
  return { runtime, delivered, beforeFlush }
}

describe('daemon run done follows its subscribed final trace', () => {
  it('does not report done while the settled event is still fetching the last text', async () => {
    let release!: () => void
    let requested!: () => void
    const holdTrace = new Promise<void>((resolve) => { release = resolve })
    const terminalRead = new Promise<void>((resolve) => { requested = resolve })
    const { runtime, delivered } = fixture({ holdTrace, onTerminalRead: requested })
    await announceRun(runtime, RUN)
    expect(runtime.runView(RUN)?.done).toBe(false)
    expect(delivered).toEqual(['one'])

    const finish = runtime.applySubscribeEvent(runEvent('run.settled', RUN))
    await terminalRead
    expect(delivered).toEqual(['one'])
    expect(runtime.runView(RUN)?.done).toBe(false)
    release()
    await finish
    await runtime.terminalDelivered(RUN)
    expect(delivered).toEqual(['one', 'two'])
    expect(runtime.runView(RUN)?.done).toBe(true)
  })

  it('does not expose a done view before the pending trace batch is sent', async () => {
    const { runtime, delivered, beforeFlush } = fixture()
    await announceRun(runtime, RUN)
    await runtime.applySubscribeEvent(runEvent('run.settled', RUN))
    await runtime.terminalDelivered(RUN)
    expect(beforeFlush).toEqual([false])
    expect(delivered).toEqual(['one', 'two'])
    expect(runtime.runView(RUN)?.done).toBe(true)
  })
})
