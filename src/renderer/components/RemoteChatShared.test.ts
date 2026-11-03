import { describe, expect, it } from 'vitest'
import { errorText, needsTraceRead, POLL_MS, TRACE_REFRESH_FLOOR_MS } from './RemoteChatShared'

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

// A version refusal must name the end that is behind; a bare code reads as a bug.
describe('protocol refusal copy', () => {
  it('separates the host and client cases', () => {
    expect(errorText(new Error('desktop_protocol_host_older'), 'mac-mini')).toContain('mac-mini')
    expect(errorText(new Error('desktop_protocol_host_older'), 'mac-mini')).toContain('升级')
    expect(errorText(new Error('desktop_protocol_client_older'))).toContain('本机')
    expect(errorText(new Error('desktop_protocol_mismatch'))).toContain('协议版本')
    expect(errorText(new Error('desktop_protocol_missing'))).toContain('协议版本')
  })

  it('leaves unrelated errors alone', () => {
    expect(errorText(new Error('desktop_not_connected'))).toBe('desktop_not_connected')
  })
})
