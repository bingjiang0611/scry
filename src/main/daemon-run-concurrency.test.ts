import { describe, expect, it } from 'vitest'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge, type TraceBatch } from './trace-output'
import { laneForRequest } from './remote/desktop-lane'
import { startDaemonRunEvents } from './daemon-run-events'

// P3f E0: two runs on one daemon connection.
//
// Each lane carries one outstanding request (desktop-lane.ts), and every run's long
// poll goes to the same `watch` lane. The daemon answers a watch on that run's own
// output or on any ledger event, so while run A thinks quietly, run B's poll waits
// behind A's - B's bind and B's text arrive only when A's poll ends. Worse, B's start
// outlives its own bind budget: the budget is checked between watches, and the watch
// it is waiting for is A's.

const RUN_A = '1a2b3c4d-1111-4a3f-9a2e-2f2c1a4b5d6e'
const RUN_B = '1a2b3c4d-2222-4a3f-9a2e-2f2c1a4b5d6e'
// Started by a phone: this window never submitted it.
const RUN_PHONE = '1a2b3c4d-3333-4a3f-9a2e-2f2c1a4b5d6e'
const CANONICAL: Record<string, string> = { [RUN_A]: 'remote-run-aaaa-0', [RUN_B]: 'remote-run-bbbb-0', [RUN_PHONE]: 'remote-run-cccc-0' }

function daemon() {
  const lanes = new Map<string, Promise<unknown>>()
  const quietA: Array<() => void> = []
  let submits = 0
  const bound = new Set<string>()
  const output = new Map<string, number>()
  const text = new Map<string, string>()
  const settled = new Set<string>()
  // The daemon's App event feed: run notices, answered at once or on the next one.
  const notices: Array<{ kind: 'run'; runId: string; intentSeq?: number } | { kind: 'window'; channel: string; payload: unknown }> = []
  const live = new Set<string>()
  const liveRequests: number[] = []
  const noticeWaiters: Array<() => void> = []
  const notice = (runId: string, intentSeq?: number) => {
    notices.push({ kind: 'run', runId, ...(intentSeq !== undefined ? { intentSeq } : {}) })
    for (const wake of noticeWaiters.splice(0)) wake()
  }
  const answer = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') {
      const runId = submits++ === 0 ? RUN_A : RUN_B
      return { runId, status: 'recorded', seq: 1 }
    }
    if (payload.op === 'watch') {
      const runId = String(payload.runId)
      if (!bound.has(runId)) {
        bound.add(runId)
        const detail = JSON.stringify({ event: 'bound', ledgerRunId: runId, scryRunId: CANONICAL[runId], cwd: '/w', providerId: 'codex' })
        return { watch: { state: 'dispatched', poll: { cursor: 1, events: [{ runId, kind: 'run_progress', detail }] }, output: { chunks: [], cursor: 0, count: 0 } } }
      }
      // A is thinking: like the real daemon, its poll stays open for the wait it was
      // given (the pump asks for 15 s), or until the test ends it.
      if (runId === RUN_A) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Number(payload.waitMs))
          quietA.push(() => { clearTimeout(timer); resolve() })
        })
      }
      const count = output.get(runId) ?? 0
      output.set(runId, 0)
      return { watch: { state: settled.has(runId) ? 'settled' : 'dispatched', poll: { cursor: 1, events: [] }, output: { chunks: [], cursor: count, count } } }
    }
    if (payload.op === 'desktop') {
      const query = payload.query as { runId: string }
      const runId = Object.keys(CANONICAL).find((key) => CANONICAL[key] === query.runId)!
      const value = text.get(runId)
      const items = value ? [{ id: `${runId}-t`, ts: '2024-01-01T00:00:00.000Z', runId: query.runId, kind: 'model', stage: 'text', messageId: 'm', text: value }] : []
      return { desktop: { kind: 'trace', run: { runId: query.runId, providerId: 'codex', cwd: '/w', userText: 'hi', items, done: false }, cursor: { revision: `r${items.length}`, count: items.length } } }
    }
    if (payload.op === 'questions') return { questions: [] }
    if (payload.op === 'liveRuns') {
      liveRequests.push(Date.now())
      return { liveRuns: { revision: String(live.size), runs: [...live].map((runId) => ({ runId, state: 'running' })) } }
    }
    if (payload.op === 'appEvents') {
      if (payload.epoch === undefined) return { events: { epoch: 'e1', cursor: notices.length, items: [] } }
      const cursor = Number(payload.cursor)
      if (notices.length <= cursor) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Number(payload.waitMs))
          noticeWaiters.push(() => { clearTimeout(timer); resolve() })
        })
      }
      return { events: { epoch: 'e1', cursor: notices.length, items: notices.slice(cursor) } }
    }
    return { error: 'unknown_op' }
  }
  // The production rule: one request at a time per lane, the lane chosen from the op.
  const request = (payload: Record<string, unknown>): Promise<unknown> => {
    const lane = laneForRequest(payload)
    const previous = lanes.get(lane) ?? Promise.resolve()
    const next = previous.then(() => answer(payload))
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
    send: () => {},
    bridge: new TraceOutputBridge({
      canSend: () => true,
      send: (batch: TraceBatch) => { for (const event of batch.events ?? []) if (event.text) delivered.push(`${event.runId}:${event.text}`) },
      schedule: (fn) => { fn(); return () => {} }
    }),
    waitMs: 15_000,
    bindBudgetMs: 300
  })
  // The App's event wiring, exactly as daemon mode starts it (daemon-run-mode.ts).
  let isLive = false
  const setWakesLive = runtime.setWakesLive.bind(runtime)
  runtime.setWakesLive = (value: boolean) => { isLive = value; setWakesLive(value) }
  const start = () => startDaemonRunEvents({
    transport, waitMs: 5_000,
    send: (channel, payload) => delivered.push(`notice:${channel}:${(payload as { runId?: string }).runId}`),
    runtime
  })
  return {
    runtime, delivered, start, isLive: () => isLive, liveRequests, subscription,
    settle: (runId: string) => { settled.add(runId); notice(runId) },
    write: (runId: string, value: string) => { text.set(runId, value); output.set(runId, (output.get(runId) ?? 0) + 1); notice(runId) },
    phone: (runId: string) => { live.add(runId); notice(runId, 1) },
    // The daemon's text grew and its pipeline said the turn is done, with no run notice
    // in between: what a window must not do is show "done" before that text.
    finish: (runId: string, value: string) => {
      text.set(runId, value)
      output.set(runId, (output.get(runId) ?? 0) + 1)
      notices.push({ kind: 'window', channel: 'agent:turnDone', payload: { runId: CANONICAL[runId] } })
      for (const wake of noticeWaiters.splice(0)) wake()
    },
    endQuietPoll: () => { for (const resolve of quietA.splice(0)) resolve(); for (const wake of noticeWaiters.splice(0)) wake() }
  }
}

// Bounded: the failure being shown is a start that waits on another run's poll.
const within = <T>(ms: number, work: Promise<T>): Promise<T | 'still waiting'> =>
  Promise.race([work, new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms))])

const start = (runtime: DaemonRunRuntime, intentId: string) =>
  runtime.start({ intentId, detail: '{}', context: { cwd: '/w', providerId: 'codex' } })

describe('concurrent daemon runs (P3f E0)', () => {
  it('binds and streams a second run while the first one is quiet', async () => {
    const { runtime, delivered, start: startEvents, isLive, write, endQuietPoll } = daemon()
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
      endQuietPoll()
      runtime.dispose()
      endQuietPoll()
    }
  })

  it('shows a run another client started without the renderer asking (E3)', async () => {
    const { runtime, delivered, start: startEvents, isLive, write, phone, liveRequests, endQuietPoll } = daemon()
    const events = startEvents()
    try {
      await expect.poll(isLive).toBe(true)
      phone(RUN_PHONE)
      await expect.poll(() => runtime.isTracking(RUN_PHONE)).toBe(true)
      write(RUN_PHONE, 'from the phone')
      await expect.poll(() => delivered, { timeout: 1_000 }).toContain(`${CANONICAL[RUN_PHONE]}:from the phone`)
      expect(liveRequests).toHaveLength(1)
    } finally {
      events.dispose()
      endQuietPoll()
      runtime.dispose()
    }
  })

  it('delivers a run notice only after the text the daemon had when it sent it (W1)', async () => {
    const { runtime, delivered, start: startEvents, isLive, finish, endQuietPoll } = daemon()
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
      endQuietPoll()
      runtime.dispose()
    }
  })

  it('feeds a run-level subscription the run text, then its end (W2)', async () => {
    const { runtime, subscription, start: startEvents, isLive, write, settle, endQuietPoll } = daemon()
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
      endQuietPoll()
      runtime.dispose()
    }
  })
})
