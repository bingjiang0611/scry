import { describe, expect, it } from 'vitest'
import {
  callDelta,
  LIVE_ROUNDS,
  LiveVisitLedger,
  MAX_KEPT_VIEWS,
  REQUIRED_ROUND_CALLS,
  roundViolations,
  type LiveRoundSample
} from './fixtures/concurrency-trace-live-visits'

const ACCEPTED_CALLS = { intents: 1, liveRun: 1, traceDelta: 1 }
const MARKER = { visible: true, reason: 'visible', width: 120, height: 18 }

const sample = (round: number, calls: Record<string, number> = ACCEPTED_CALLS, failed: Record<string, number> = {}): LiveRoundSample => ({
  round, pollMs: 2, settleMs: 3, markerCheckMs: 1, marker: MARKER, commits: 1, commitMs: 1.5, autoPolls: 0,
  calls, failed, violations: roundViolations({ calls, failed })
})

describe('controlled round read contract', () => {
  it('accepts exactly one intents/liveRun/traceDelta read and no failures', () => {
    expect(REQUIRED_ROUND_CALLS).toEqual(ACCEPTED_CALLS)
    expect(roundViolations({ calls: ACCEPTED_CALLS, failed: {} })).toEqual([])
  })

  it('rejects a round that reads nothing, so seven idle rounds cannot look green', () => {
    expect(roundViolations({ calls: {}, failed: {} })).toEqual([
      'intents:0!=1', 'liveRun:0!=1', 'traceDelta:0!=1'
    ])
  })

  it('rejects a round that skips a required read', () => {
    expect(roundViolations({ calls: { intents: 1, liveRun: 1 }, failed: {} })).toEqual(['traceDelta:0!=1'])
    expect(roundViolations({ calls: { liveRun: 1, traceDelta: 1 }, failed: {} })).toEqual(['intents:0!=1'])
  })

  it('rejects a gap re-read, a snapshot fallback and any other read in the same round', () => {
    expect(roundViolations({ calls: { ...ACCEPTED_CALLS, traceDelta: 2 }, failed: {} })).toEqual(['traceDelta:2!=1'])
    expect(roundViolations({ calls: { ...ACCEPTED_CALLS, trace: 1 }, failed: {} })).toEqual(['unexpected:trace:1'])
    expect(roundViolations({ calls: { ...ACCEPTED_CALLS, catalog: 1 }, failed: {} })).toEqual(['unexpected:catalog:1'])
    expect(roundViolations({ calls: { ...ACCEPTED_CALLS, trace: 1, history: 1 }, failed: { history: 1 } })).toEqual([
      'failed:history:1', 'unexpected:history:1', 'unexpected:trace:1'
    ])
  })

  it('rejects a round whose read failed, even when the counts look right', () => {
    expect(roundViolations({ calls: { intents: 1, liveRun: 1 }, failed: { traceDelta: 1 } })).toEqual([
      'failed:traceDelta:1', 'traceDelta:0!=1'
    ])
  })
})

describe('live concurrency trace visit ledger', () => {
  it('reports mount reads separately from the round reads and keeps both', () => {
    const ledger = new LiveVisitLedger()
    ledger.begin('visit-1', 100)
    expect(() => ledger.recordRound(sample(1), { runId: 'run-1' })).toThrow('concurrency_trace_live_mount_not_recorded')
    ledger.recordMount({ calls: { list: 1, catalog: 2, history: 1 }, failed: {} })
    expect(() => ledger.recordMount({ calls: {}, failed: {} })).toThrow('concurrency_trace_live_mount_recorded')

    for (let round = 1; round <= LIVE_ROUNDS; round++) ledger.recordRound(sample(round), { runId: 'run-1' })
    const summary = ledger.end(250)
    expect(summary.mountCalls).toEqual({ list: 1, catalog: 2, history: 1 })
    expect(summary.mountFailed).toEqual({})
    expect(summary.roundCalls).toEqual({ intents: LIVE_ROUNDS, liveRun: LIVE_ROUNDS, traceDelta: LIVE_ROUNDS })
    expect(summary.calls).toEqual({ list: 1, catalog: 2, history: 1, intents: LIVE_ROUNDS, liveRun: LIVE_ROUNDS, traceDelta: LIVE_ROUNDS })
    // Wall time only: this class never claims to know CPU time.
    expect(summary.visitWallMs).toBe(150)
    expect(summary.violations).toEqual([])
    expect(summary.keptViews).toBe(LIVE_ROUNDS)
  })

  it('keeps mount failures and per-round violations visible in the summary', () => {
    const ledger = new LiveVisitLedger()
    ledger.begin('visit-1', 0)
    ledger.recordMount({ calls: { list: 1, catalog: 1, history: 1 }, failed: { history: 1 } })
    ledger.recordRound(sample(1, {}, {}), null)
    for (let round = 2; round <= LIVE_ROUNDS; round++) ledger.recordRound(sample(round), { runId: 'run-1' })
    const summary = ledger.end(10)
    expect(summary.failed).toEqual({ history: 1 })
    expect(summary.violations).toEqual([
      'intents:0!=1', 'liveRun:0!=1', 'mount_failed:history:1', 'traceDelta:0!=1'
    ])
  })

  it('bounds the visit to seven rounds and hands committed views over once sealed', () => {
    const ledger = new LiveVisitLedger()
    expect(() => ledger.takeViews()).toThrow('concurrency_trace_live_visit_open')
    expect(() => ledger.end(0)).toThrow('concurrency_trace_live_visit_closed')

    ledger.begin('visit-1', 0)
    ledger.recordMount({ calls: { list: 1, catalog: 1, history: 1 }, failed: {} })
    const view = { runId: 'run-1', items: [1, 2, 3] }
    for (let round = 1; round <= LIVE_ROUNDS; round++) ledger.recordRound(sample(round), view)
    expect(MAX_KEPT_VIEWS).toBe(LIVE_ROUNDS)
    expect(() => ledger.recordRound(sample(LIVE_ROUNDS + 1), view)).toThrow('concurrency_trace_live_round_overflow')
    expect(() => ledger.takeViews()).toThrow('concurrency_trace_live_visit_open')

    ledger.end(140)
    const views = ledger.takeViews()
    expect(views).toHaveLength(LIVE_ROUNDS)
    expect(views[0]).toBe(view)
    expect(() => ledger.begin('visit-2', 200)).toThrow('concurrency_trace_live_views_not_released')
    expect(ledger.releaseViews()).toBe(LIVE_ROUNDS)
    expect(ledger.takeViews()).toEqual([])
    expect(ledger.releaseViews()).toBe(0)
    ledger.begin('visit-2', 200)
    expect(ledger.state()).toMatchObject({ open: true, visitId: 'visit-2', rounds: 0 })
  })

  it('refuses to seal a visit that did not run every round', () => {
    const ledger = new LiveVisitLedger()
    ledger.begin('visit-1', 0)
    ledger.recordMount({ calls: {}, failed: {} })
    ledger.recordRound(sample(1), null)
    expect(() => ledger.recordRound(sample(3), null)).toThrow('concurrency_trace_live_round_out_of_order')
    expect(() => ledger.recordMount({ calls: {}, failed: {} })).toThrow('concurrency_trace_live_mount_after_round')
    expect(() => ledger.end(10)).toThrow('concurrency_trace_live_rounds_incomplete')
  })

  it('records a quiet round honestly instead of inventing a render', () => {
    const ledger = new LiveVisitLedger()
    ledger.begin('visit-1', 0)
    ledger.recordMount({ calls: { list: 1, catalog: 1, history: 1 }, failed: {} })
    ledger.recordRound({ ...sample(1), commits: 0, commitMs: 0 }, { runId: 'run-1' })
    for (let round = 2; round <= LIVE_ROUNDS; round++) ledger.recordRound(sample(round), { runId: 'run-1' })
    const summary = ledger.end(1)
    expect(summary.violations).toEqual([])
    expect(ledger.takeViews()[0]).toEqual({ runId: 'run-1' })
  })

  it('computes per-round deltas only for methods that changed', () => {
    expect(callDelta({ intents: 2 }, { intents: 3, liveRun: 1 })).toEqual({ intents: 1, liveRun: 1 })
    expect(callDelta({}, {})).toEqual({})
  })
})
