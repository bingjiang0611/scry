import { describe, expect, it } from 'vitest'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'

// L2: one App window, one daemon, thirty-one runs in a row.
//
// The ledger answers `since(cursor)` with at most one page of events (`DEFAULT_PAGE`
// in session-ledger.ts), taken from the global sequence. A watch that always asks from
// cursor 0 therefore keeps receiving the same oldest page, and once the session holds
// more than one page the run's own bind event is never in it: the run is dispatched,
// the window waits out its bind budget, and `start` fails with
// `daemon_run_not_bound`. Thirty turns in one window is an ordinary afternoon, so the
// client has to ask for what it has not seen yet.

const PAGE = 256
// What one run writes before it is bound: intent, dispatch, progress events, then the
// bind marker itself.
const EVENTS_PER_RUN = 9
const RUNS = 31

interface LedgerEvent { seq: number; runId: string; kind: string; detail?: string }

function ledgerFixture() {
  const events: LedgerEvent[] = []
  const states = new Map<string, string>()
  const asked: Array<{ runId: string; cursor: number }> = []
  const append = (event: Omit<LedgerEvent, 'seq'>): void => {
    const seq = events.length === 0 ? 1 : events[events.length - 1]!.seq + 1
    events.push({ seq, ...event })
  }
  return {
    states,
    asked,
    append,
    // The daemon's answer, page for page.
    since(cursor: number): { events: LedgerEvent[]; cursor: number } {
      const page = events.filter((event) => event.seq > cursor).slice(0, PAGE)
      return { events: page, cursor: page.length > 0 ? page[page.length - 1]!.seq : cursor }
    },
    events: () => events.length
  }
}

// The daemon names runs it created; the shape is checked on every frame.
function indexOf(payload: Record<string, unknown>): number {
  const intent = String(payload.intentId)
  return Number(intent.slice('intent-'.length))
}

function runtimeOverLedger(ledger: ReturnType<typeof ledgerFixture>) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') {
      const runId = `run-ledger-${indexOf(payload)}`
      const detail = JSON.parse(String(payload.detail)) as { cwd: string; providerId: string }
      ledger.append({ runId, kind: 'intent_recorded', detail: String(payload.detail) })
      ledger.append({ runId, kind: 'run_dispatched' })
      ledger.states.set(runId, 'dispatched')
      for (let index = 0; index < EVENTS_PER_RUN - 3; index++) {
        ledger.append({ runId, kind: 'run_progress', detail: JSON.stringify({ event: 'started' }) })
      }
      ledger.append({
        runId, kind: 'run_progress',
        detail: JSON.stringify({
          event: 'bound', ledgerRunId: runId, scryRunId: `remote-${runId}`,
          cwd: detail.cwd, providerId: detail.providerId
        })
      })
      // Delivered and finished: the pump ends instead of polling a fixture forever.
      ledger.states.set(runId, 'settled')
      return { runId, status: 'recorded' }
    }
    if (payload.op === 'watch') {
      const runId = String(payload.runId)
      ledger.asked.push({ runId, cursor: Number(payload.cursor) })
      const page = ledger.since(Number(payload.cursor))
      return { watch: { state: ledger.states.get(runId) ?? null, poll: { cursor: page.cursor, events: page.events } } }
    }
    if (payload.op === 'desktop') {
      const query = payload.query as { runId?: string }
      return {
        desktop: {
          kind: 'trace',
          run: { runId: query.runId, providerId: 'claude', cwd: '/w', userText: 'hi', items: [], done: false },
          cursor: { revision: 'r1', count: 0 }
        }
      }
    }
    if (payload.op === 'questions') return { questions: [] }
    return { error: 'unknown_op' }
  }
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: (channel, payload) => sent.push({ channel, payload }),
    bridge: new TraceOutputBridge({
      canSend: () => true,
      send: (payload) => sent.push({ channel: 'agent:trace', payload }),
      schedule: (fn) => { fn(); return () => {} }
    }),
    waitMs: 0,
    bindBudgetMs: 200
  })
  return { runtime, sent }
}

const start = (runtime: DaemonRunRuntime, index: number) => runtime.start({
  intentId: `intent-${index}`,
  detail: JSON.stringify({ cwd: '/w', providerId: 'claude' }),
  context: { cwd: '/w', providerId: 'claude' }
})

describe('daemon session bounds (L2: a session keeps working past one ledger page)', () => {
  it('binds every run of thirty-one in one session', async () => {
    const ledger = ledgerFixture()
    const { runtime } = runtimeOverLedger(ledger)
    const bound: number[] = []
    for (let index = 0; index < RUNS; index++) {
      const receipt = await start(runtime, index)
      if (receipt.bound) bound.push(index)
    }
    expect(ledger.events()).toBeGreaterThan(PAGE)
    // The failure S1 recorded at run 30: everything before the page boundary binds,
    // then none do.
    expect(bound).toHaveLength(RUNS)
  })

  it('never asks twice for the same page, and starts where the session already is', async () => {
    const ledger = ledgerFixture()
    const { runtime } = runtimeOverLedger(ledger)
    await start(runtime, 0)
    await start(runtime, 1)
    ledger.asked.length = 0
    await start(runtime, 2)
    // Each reply's cursor is where the next ask begins, so pages are walked, never
    // re-read; and a run this connection is following does not restart at the first page.
    const cursors = ledger.asked.map((entry) => entry.cursor)
    expect(cursors[0]).toBeGreaterThan(0)
    for (let index = 1; index < cursors.length; index++) expect(cursors[index]).toBeGreaterThanOrEqual(cursors[index - 1]!)
  })
})
