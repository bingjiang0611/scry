import { describe, expect, it } from 'vitest'
import { needsTraceRead, POLL_MS, TRACE_REFRESH_FLOOR_MS } from './RemoteChatShared'

// The renderer no longer ticks: the host long poll reports change, so content
// reads must follow that report instead of a timer.
describe('trace reads follow the long poll', () => {
  it('reads when the poll reports a change', () => {
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-a', changed: true, lastReadAt: 1_000, now: 1_001 })).toBe(true)
  })

  it('reads nothing on a window that expired without change', () => {
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-a', changed: false, lastReadAt: 1_000, now: 1_001 })).toBe(false)
    // An unreported flag is not evidence of "no change", so the floor still applies.
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-a', lastReadAt: 1_000, now: 1_001 })).toBe(false)
  })

  it('reads a run that is not on screen yet, whatever the flag', () => {
    expect(needsTraceRead({ runId: 'run-b', changed: false, lastReadAt: 1_000, now: 1_001 })).toBe(true)
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-b', lastReadAt: 1_000, now: 1_001 })).toBe(true)
  })

  it('refreshes a followed run without ledger events on the floor', () => {
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-a', changed: false, lastReadAt: 1_000, now: 1_000 + TRACE_REFRESH_FLOOR_MS })).toBe(true)
    expect(TRACE_REFRESH_FLOOR_MS).toBeGreaterThan(POLL_MS)
  })
})
