import { describe, expect, it } from 'vitest'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge, type TraceBatch } from './trace-output'
import { laneForRequest } from './remote/desktop-lane'

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
const CANONICAL: Record<string, string> = { [RUN_A]: 'remote-run-aaaa-0', [RUN_B]: 'remote-run-bbbb-0' }

function daemon() {
  const lanes = new Map<string, Promise<unknown>>()
  const quietA: Array<() => void> = []
  let submits = 0
  const bound = new Set<string>()
  const output = new Map<string, number>()
  const text = new Map<string, string>()
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
      return { watch: { state: 'dispatched', poll: { cursor: 1, events: [] }, output: { chunks: [], cursor: count, count } } }
    }
    if (payload.op === 'desktop') {
      const query = payload.query as { runId: string }
      const runId = Object.keys(CANONICAL).find((key) => CANONICAL[key] === query.runId)!
      const value = text.get(runId)
      const items = value ? [{ id: `${runId}-t`, ts: '2024-01-01T00:00:00.000Z', runId: query.runId, kind: 'model', stage: 'text', messageId: 'm', text: value }] : []
      return { desktop: { kind: 'trace', run: { runId: query.runId, providerId: 'codex', cwd: '/w', userText: 'hi', items, done: false }, cursor: { revision: `r${items.length}`, count: items.length } } }
    }
    if (payload.op === 'questions') return { questions: [] }
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
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: () => {},
    bridge: new TraceOutputBridge({
      canSend: () => true,
      send: (batch: TraceBatch) => { for (const event of batch.events ?? []) if (event.text) delivered.push(`${event.runId}:${event.text}`) },
      schedule: (fn) => { fn(); return () => {} }
    }),
    waitMs: 15_000,
    bindBudgetMs: 300
  })
  return {
    runtime, delivered,
    write: (runId: string, value: string) => { text.set(runId, value); output.set(runId, (output.get(runId) ?? 0) + 1) },
    endQuietPoll: () => { for (const resolve of quietA.splice(0)) resolve() }
  }
}

// Bounded: the failure being shown is a start that waits on another run's poll.
const within = <T>(ms: number, work: Promise<T>): Promise<T | 'still waiting'> =>
  Promise.race([work, new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms))])

const start = (runtime: DaemonRunRuntime, intentId: string) =>
  runtime.start({ intentId, detail: '{}', context: { cwd: '/w', providerId: 'codex' } })

describe('concurrent daemon runs (P3f E0)', () => {
  it.fails('binds and streams a second run while the first one is quiet', async () => {
    const { runtime, delivered, write, endQuietPoll } = daemon()
    try {
      expect((await start(runtime, 'intent-a')).bound).toBe(true)
      // The bind budget is 300 ms; the start must not outlive it waiting on A.
      const second = await within(1_000, start(runtime, 'intent-b'))
      expect(second).toMatchObject({ bound: true })
      write(RUN_B, 'from B')
      await expect.poll(() => delivered, { timeout: 500 }).toContain(`${CANONICAL[RUN_B]}:from B`)
    } finally {
      endQuietPoll()
      runtime.dispose()
      endQuietPoll()
    }
  })
})
