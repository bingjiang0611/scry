import { describe, expect, it } from 'vitest'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport, type DaemonRequest } from './daemon-run-transport'
import { TraceOutputBridge, type TraceBatch } from './trace-output'
import { laneForRequest } from './remote/desktop-lane'
import { startDaemonRunEvents } from './daemon-run-events'
import type { SubscribeEventItem, SubscribeHint, SubscribeKnownCursor, SubscribeReply } from '../shared/orchestration-subscribe'

// P3f E0: two runs share one status lane. A quiet run does not get its own
// blocking watch, so a second run must still bind and stream within its budget.

const RUN_A = '1a2b3c4d-1111-4a3f-9a2e-2f2c1a4b5d6e'
const RUN_B = '1a2b3c4d-2222-4a3f-9a2e-2f2c1a4b5d6e'
// Started by a phone: this window never submitted it.
const RUN_PHONE = '1a2b3c4d-3333-4a3f-9a2e-2f2c1a4b5d6e'
const CANONICAL: Record<string, string> = { [RUN_A]: 'remote-run-aaaa-0', [RUN_B]: 'remote-run-bbbb-0', [RUN_PHONE]: 'remote-run-cccc-0' }

function daemon() {
  const lanes = new Map<string, Promise<unknown>>()
  const text = new Map<string, string>()
  const updates: Array<{ hint: SubscribeHint } | { event: SubscribeEventItem }> = []
  const statusOpens: number[] = []
  let notify = () => {}
  let submits = 0
  let isLive = false
  const ids = { hostId: 'fixture-host', logId: 'fixture-log' }

  const publish = (update: typeof updates[number]) => { updates.push(update); notify() }
  const hint = (runId: string, outputSeq = 0) => publish({
    hint: { kind: 'run', runId, scryRunId: CANONICAL[runId], providerId: 'codex', cwd: '/w', admitted: true, outputSeq }
  })
  const settle = (runId: string) => publish({
    event: { seq: updates.length + 1, type: 'run.settled', stream: 'run', at: 0, runId, payload: {} }
  })

  async function subscribe(known: SubscribeKnownCursor | undefined, signal?: AbortSignal): Promise<SubscribeReply> {
    if (!known) {
      statusOpens.push(Date.now())
      return { ...ids, seq: updates.length, mode: 'snapshot', snapshot: { activeRuns: { rows: [] } } }
    }
    isLive = true
    if (known.seq === updates.length && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener('abort', done)
          notify = () => {}
          resolve()
        }
        notify = done
        signal?.addEventListener('abort', done, { once: true })
      })
    }
    if (known.seq === updates.length) return { ...ids, seq: known.seq, mode: 'idle' }
    const batch = updates.slice(known.seq)
    return {
      ...ids, seq: updates.length, mode: 'events',
      events: batch.flatMap((update) => 'event' in update ? [update.event] : []),
      hints: batch.flatMap((update) => 'hint' in update ? [update.hint] : [])
    }
  }

  const answer: DaemonRequest = async (payload, options) => {
    if (payload.op === 'submit') {
      const runId = submits++ === 0 ? RUN_A : RUN_B
      hint(runId)
      return { runId, status: 'recorded', seq: updates.length }
    }
    if (payload.op === 'subscribe') {
      return { subscribe: await subscribe(payload.known as SubscribeKnownCursor | undefined, options?.signal) }
    }
    if (payload.op === 'desktop') {
      const query = payload.query as { runId: string }
      const runId = Object.keys(CANONICAL).find((key) => CANONICAL[key] === query.runId)!
      const value = text.get(runId)
      const items = value ? [{ id: `${runId}-t`, ts: '2024-01-01T00:00:00.000Z', runId: query.runId, kind: 'model', stage: 'text', messageId: 'm', text: value }] : []
      return { desktop: { kind: 'trace', run: { runId: query.runId, providerId: 'codex', cwd: '/w', userText: 'hi', items, done: false }, cursor: { revision: `r${items.length}`, count: items.length } } }
    }
    throw new Error(`unexpected daemon operation ${String(payload.op)}`)
  }
  // Use the production lane routing and keep one outstanding request per lane.
  const request: DaemonRequest = (payload, options) => {
    const lane = laneForRequest(payload)
    const previous = lanes.get(lane) ?? Promise.resolve()
    const next = previous.then(() => answer(payload, options))
    lanes.set(lane, next.then(() => undefined, () => undefined))
    return next
  }
  const delivered: string[] = []
  const transport = new DaemonRunTransport(request)
  // Not wrapped: the event wiring receives the runtime itself, as daemon mode passes it.
  // What a run-level subscription receives (W2), in order.
  const subscription: string[] = []
  const runTraces = {
    route: (event: { runId: string; text?: string }) => { if (event.text) subscription.push(`${event.runId}:${event.text}`) },
    settle: (runId: string) => { subscription.push(`settled:${runId}`) },
    publishQuestion: () => {}, publishQuestionClosed: () => {}
  }
  const runtime = new DaemonRunRuntime({
    transport,
    runTraces,
    send: (channel, payload) => {
      if (channel === 'agent:turnDone') delivered.push(`notice:${channel}:${(payload as { runId: string }).runId}`)
    },
    bridge: new TraceOutputBridge({
      canSend: () => true,
      send: (batch: TraceBatch) => { for (const event of batch.events ?? []) if (event.text) delivered.push(`${event.runId}:${event.text}`) },
      schedule: (fn) => { fn(); return () => {} }
    }),
    bindBudgetMs: 300
  })
  // The App's event wiring, exactly as daemon mode starts it (daemon-run-mode.ts).
  const start = () => startDaemonRunEvents({ transport, waitMs: 5_000, send: () => {}, runtime })
  return {
    runtime, delivered, start, isLive: () => isLive, statusOpens, subscription, settle,
    write: (runId: string, value: string) => { text.set(runId, value); hint(runId, 1) },
    phone: (runId: string) => hint(runId),
    // With no live output hint, the terminal event must still deliver the final text first.
    finish: (runId: string, value: string) => { text.set(runId, value); settle(runId) }
  }
}

// Bounded: the failure being shown is a start that waits on another run's poll.
const within = <T>(ms: number, work: Promise<T>): Promise<T | 'still waiting'> =>
  Promise.race([work, new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms))])

const start = (runtime: DaemonRunRuntime, intentId: string) =>
  runtime.start({ intentId, detail: '{}', context: { cwd: '/w', providerId: 'codex' } })

describe('concurrent daemon runs (P3f E0)', () => {
  it('binds and streams a second run while the first one is quiet', async () => {
    const { runtime, delivered, start: startEvents, isLive, write } = daemon()
    const events = startEvents()
    try {
      await expect.poll(isLive).toBe(true)
      expect((await start(runtime, 'intent-a')).bound).toBe(true)
      // The bind budget is 300 ms; the start must not outlive it waiting on A.
      const second = await within(1_000, start(runtime, 'intent-b'))
      expect(second).toMatchObject({ bound: true })
      write(RUN_B, 'from B')
      await expect.poll(() => delivered, { timeout: 500 }).toContain(`${CANONICAL[RUN_B]}:from B`)
    } finally {
      events.dispose()
      runtime.dispose()
    }
  })

  it('shows a run another client started without the renderer asking (E3)', async () => {
    const { runtime, delivered, start: startEvents, isLive, write, phone, statusOpens } = daemon()
    const events = startEvents()
    try {
      await expect.poll(isLive).toBe(true)
      phone(RUN_PHONE)
      await expect.poll(() => runtime.isTracking(RUN_PHONE)).toBe(true)
      write(RUN_PHONE, 'from the phone')
      await expect.poll(() => delivered, { timeout: 1_000 }).toContain(`${CANONICAL[RUN_PHONE]}:from the phone`)
      expect(statusOpens).toHaveLength(1)
    } finally {
      events.dispose()
      runtime.dispose()
    }
  })

  it('delivers turn completion only after the text the daemon had when it settled (W1)', async () => {
    const { runtime, delivered, start: startEvents, isLive, finish } = daemon()
    const events = startEvents()
    try {
      await expect.poll(isLive).toBe(true)
      expect((await start(runtime, 'intent-a')).bound).toBe(true)
      finish(RUN_A, 'last words')
      await expect.poll(() => delivered).toContain(`notice:agent:turnDone:${CANONICAL[RUN_A]}`)
      const text = delivered.indexOf(`${CANONICAL[RUN_A]}:last words`)
      expect(text).toBeGreaterThanOrEqual(0)
      expect(text).toBeLessThan(delivered.indexOf(`notice:agent:turnDone:${CANONICAL[RUN_A]}`))
    } finally {
      events.dispose()
      runtime.dispose()
    }
  })

  it('feeds a run-level subscription the run text, then its end (W2)', async () => {
    const { runtime, subscription, start: startEvents, isLive, write, settle } = daemon()
    const events = startEvents()
    try {
      await expect.poll(isLive).toBe(true)
      expect((await start(runtime, 'intent-a')).bound).toBe(true)
      write(RUN_A, 'for the conversation view')
      await expect.poll(() => subscription).toContain(`${CANONICAL[RUN_A]}:for the conversation view`)
      settle(RUN_A)
      await expect.poll(() => subscription).toContain(`settled:${CANONICAL[RUN_A]}`)
      // The end comes after the text, once, under the id the view subscribed with.
      expect(subscription.filter((item) => item.startsWith('settled:'))).toHaveLength(1)
      expect(subscription.indexOf(`settled:${CANONICAL[RUN_A]}`)).toBe(subscription.length - 1)
    } finally {
      events.dispose()
      runtime.dispose()
    }
  })
})
