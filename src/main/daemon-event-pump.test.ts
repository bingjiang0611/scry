import { describe, expect, it, vi } from 'vitest'
import { DaemonEventPump, type DaemonEventSource } from './daemon-event-pump'
import { DaemonRunError } from './daemon-run-transport'

// P3f E1: the App side of the daemon's event feed. One long poll per daemon
// connection; each notice reaches the window as the in-process App would have sent it.

type Reply = Awaited<ReturnType<DaemonEventSource['appEvents']>>

function source(replies: Array<Reply | Error>) {
  const requests: Array<{ epoch?: string; cursor: number; waitMs: number }> = []
  let index = 0
  let release: (() => void) | undefined
  const appEvents = vi.fn(async (input: { epoch?: string; cursor: number; waitMs: number }, signal?: AbortSignal): Promise<Reply> => {
    requests.push(input)
    const next = replies[index++]
    if (next instanceof Error) throw next
    if (next) return next
    // No more scripted replies: park like an idle long poll until disposed.
    return await new Promise<Reply>((_resolve, reject) => {
      release = () => reject(new Error('aborted'))
      signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  })
  return { source: { appEvents }, requests, release: () => release?.() }
}

const sleep = vi.fn(async () => undefined)

describe('daemon event pump', () => {
  it('forwards each data notice to the window in order and follows the cursor', async () => {
    const sent: Array<[string, unknown]> = []
    const { source: events, requests } = source([
      { epoch: 'e1', cursor: 4, items: [], reset: false },
      { epoch: 'e1', cursor: 6, items: [
        { kind: 'data', event: { runId: 'r1', kind: 'turn_recorded' } },
        { kind: 'data', event: { kind: 'conversation_changed', conversationId: 'c1' } }
      ], reset: false }
    ])
    const pump = new DaemonEventPump({ source: events, send: (channel, payload) => sent.push([channel, payload]), sleep })
    pump.start()
    await vi.waitFor(() => expect(requests.length).toBe(3))
    pump.dispose()
    expect(requests.map(({ epoch, cursor }) => ({ epoch, cursor }))).toEqual([
      { epoch: undefined, cursor: 0 }, { epoch: 'e1', cursor: 4 }, { epoch: 'e1', cursor: 6 }
    ])
    expect(sent).toEqual([
      ['agent:dataUpdated', { runId: 'r1', kind: 'turn_recorded' }],
      ['agent:dataUpdated', { kind: 'conversation_changed', conversationId: 'c1' }]
    ])
  })

  it('tells every view to re-read when notices were lost', async () => {
    const sent: Array<[string, unknown]> = []
    const { source: events, requests } = source([
      { epoch: 'e1', cursor: 2, items: [], reset: false },
      { epoch: 'e2', cursor: 0, items: [], reset: true }
    ])
    const pump = new DaemonEventPump({ source: events, send: (channel, payload) => sent.push([channel, payload]), sleep })
    pump.start()
    await vi.waitFor(() => expect(requests.length).toBe(3))
    pump.dispose()
    expect(sent).toEqual([['agent:dataUpdated', { kind: 'resynchronize' }]])
    expect(requests[2]).toMatchObject({ epoch: 'e2', cursor: 0 })
  })

  it('retries a failed poll after a bounded, growing pause, and resynchronizes once it is back', async () => {
    const sent: Array<[string, unknown]> = []
    const pauses: number[] = []
    const { source: events, requests } = source([
      { epoch: 'e1', cursor: 1, items: [], reset: false },
      new DaemonRunError('daemon_not_running'), new DaemonRunError('daemon_not_running'),
      { epoch: 'e1', cursor: 1, items: [], reset: false }
    ])
    const pump = new DaemonEventPump({
      source: events, send: (channel, payload) => sent.push([channel, payload]),
      sleep: async (ms) => { pauses.push(ms) }, retry: { initialMs: 100, maxMs: 150 }
    })
    pump.start()
    await vi.waitFor(() => expect(requests.length).toBe(5))
    pump.dispose()
    expect(pauses).toEqual([100, 150])
    // A failed poll may have lost notices; the window is told so, once.
    expect(sent).toEqual([['agent:dataUpdated', { kind: 'resynchronize' }]])
  })

  it('stops for good against a daemon without the feed, instead of polling it forever', async () => {
    const warn = vi.fn()
    const { source: events, requests } = source([new DaemonRunError('daemon_run_control_unavailable')])
    const pump = new DaemonEventPump({ source: events, send: vi.fn(), sleep, onWarn: warn })
    pump.start()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests.length).toBe(1)
    pump.dispose()
  })

  it('ends its parked poll on dispose and sends nothing after', async () => {
    const send = vi.fn()
    const { source: events, requests } = source([{ epoch: 'e1', cursor: 0, items: [], reset: false }])
    const pump = new DaemonEventPump({ source: events, send, sleep })
    pump.start()
    await vi.waitFor(() => expect(requests.length).toBe(2))
    pump.dispose()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests.length).toBe(2)
    expect(send).not.toHaveBeenCalled()
  })
})
