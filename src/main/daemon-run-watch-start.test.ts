import { describe, expect, it } from 'vitest'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'

// E1: where a new run starts watching.
//
// The ledger answers `since(cursor)` with one page of its GLOBAL sequence, so a new run
// that starts at 0 walks every page the session has ever written before it reaches its
// own bind - one socket round trip and one page transfer each, and past a few hundred
// pages it misses the bind budget again. Nothing a run needs predates its own submit, so
// the receipt's sequence number is where its watch belongs.

const PAGE = 256
const HISTORY = 12_000

interface LedgerEvent { seq: number; runId: string; kind: string; detail?: string }

function daemon(options: { receiptSeq: boolean }) {
  const events: LedgerEvent[] = []
  const states = new Map<string, string>()
  const watches: number[] = []
  const append = (event: Omit<LedgerEvent, 'seq'>): LedgerEvent => {
    const stored = { seq: events.length + 1, ...event }
    events.push(stored)
    return stored
  }
  // A session that has been running all afternoon.
  for (let index = 0; index < HISTORY; index++) {
    append({ runId: `run-old-${index}`, kind: 'run_progress', detail: JSON.stringify({ event: 'started' }) })
  }
  let bound = 0

  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') {
      const runId = 'run-new-1'
      const intent = append({ runId, kind: 'intent_recorded' })
      append({ runId, kind: 'run_dispatched' })
      states.set(runId, 'dispatched')
      // The daemon's bind, a few events after the intent.
      append({ runId, kind: 'run_progress', detail: JSON.stringify({ event: 'started' }) })
      append({
        runId, kind: 'run_progress',
        detail: JSON.stringify({ event: 'bound', ledgerRunId: runId, scryRunId: `remote-${runId}`, cwd: '/w', providerId: 'codex' })
      })
      bound++
      return { runId, status: 'recorded', ...(options.receiptSeq ? { seq: intent.seq } : {}) }
    }
    if (payload.op === 'watch') {
      const runId = String(payload.runId)
      watches.push(Number(payload.cursor))
      // A real long poll ends on content, never on an idle tick: keep the fixture from
      // spinning once the page that holds the bind has been read.
      const page = events.filter((event) => event.seq > Number(payload.cursor)).slice(0, PAGE)
      if (page.some((event) => event.runId === runId && (event.detail ?? '').includes('bound'))) states.set(runId, 'settled')
      return { watch: { state: states.get(runId) ?? null, poll: { cursor: page.length > 0 ? page[page.length - 1]!.seq : Number(payload.cursor), events: page } } }
    }
    if (payload.op === 'desktop') {
      const query = payload.query as { runId?: string }
      return { desktop: { kind: 'trace', run: { runId: query.runId, providerId: 'codex', cwd: '/w', userText: 'hi', items: [], done: false }, cursor: { revision: 'r1', count: 0 } } }
    }
    if (payload.op === 'questions') return { questions: [] }
    return { error: 'unknown_op' }
  }
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: () => {},
    bridge: new TraceOutputBridge({ canSend: () => true, send: () => {}, schedule: (fn) => { fn(); return () => {} } }),
    waitMs: 0,
    bindBudgetMs: 200
  })
  return { runtime, watches, session: () => ({ bound: bound === 1, events: events.length }) }
}

const start = (runtime: DaemonRunRuntime) => runtime.start({
  intentId: 'intent-1', detail: JSON.stringify({ cwd: '/w', providerId: 'codex' }), context: { cwd: '/w', providerId: 'codex' }
})

describe('new run watch start (E1: a long session must not cost a page walk)', () => {
  it('reaches its bind within two watches of a twelve thousand event session', async () => {
    const { runtime, watches, session } = daemon({ receiptSeq: true })
    const receipt = await start(runtime)
    runtime.dispose()
    expect(session().bound).toBe(true)
    expect(receipt.bound).toBe(true)
    expect(watches.length).toBeLessThanOrEqual(2)
    // The first ask already sits at the end of the session, not at its beginning.
    expect(watches[0]).toBeGreaterThan(HISTORY - PAGE)
  })

  it('control: without a starting point the same run walks the session', async () => {
    // The receipt without a sequence number is the behaviour this replaced: no starting
    // point but the ledger's beginning. Same fixture, same run - only the start differs,
    // and it spends a watch and a page transfer per 256 events of history.
    const { runtime, watches } = daemon({ receiptSeq: false })
    const receipt = await start(runtime)
    runtime.dispose()
    expect(receipt.bound).toBe(true)
    expect(watches.length).toBeGreaterThan(2)
    expect(watches[0]).toBe(0)
  })
})
