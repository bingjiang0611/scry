import { describe, expect, it } from 'vitest'
import { errorText, followedLiveRunId, needsTraceRead, POLL_MS, TRACE_REFRESH_FLOOR_MS } from './RemoteChatShared'

describe('trace reads coalesce on the floor', () => {
  it('reads nothing inside the floor, even right after a change report', () => {
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-a', lastReadAt: 1_000, now: 1_001 })).toBe(false)
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-a', lastReadAt: 1_000, now: 1_000 + TRACE_REFRESH_FLOOR_MS - 1 })).toBe(false)
  })

  it('reads a run that is not on screen at once', () => {
    expect(needsTraceRead({ runId: 'run-b', lastReadAt: 1_000, now: 1_001 })).toBe(true)
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-b', lastReadAt: 1_000, now: 1_001 })).toBe(true)
  })

  it('refreshes a followed run on the floor', () => {
    expect(needsTraceRead({ shownRunId: 'run-a', runId: 'run-a', lastReadAt: 1_000, now: 1_000 + TRACE_REFRESH_FLOOR_MS })).toBe(true)
  })

  it('bounds one followed run to at most one read per floor per second', () => {
    let lastReadAt = Number.NEGATIVE_INFINITY
    let reads = 0
    for (let now = 0; now < 1_000; now += POLL_MS) {
      if (needsTraceRead({ shownRunId: 'run-a', runId: 'run-a', lastReadAt, now })) { reads += 1; lastReadAt = now }
    }
    expect(reads).toBeLessThanOrEqual(Math.ceil(1_000 / TRACE_REFRESH_FLOOR_MS))
  })
})

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

describe('followed run selection', () => {
  it('follows a live external run even before it was followed previously', () => {
    expect(followedLiveRunId({ scryRunId: 'run-mac' })).toBe('run-mac')
    expect(followedLiveRunId({ scryRunId: 'run-mac' })).toBe('run-mac')
  })

  it('follows nothing when no external run is live', () => {
    expect(followedLiveRunId(null)).toBeUndefined()
    expect(followedLiveRunId({})).toBeUndefined()
  })
})
