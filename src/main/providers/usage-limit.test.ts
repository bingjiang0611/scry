import { describe, expect, it } from 'vitest'
import { parseUsageLimit } from './usage-limit'

// C4: a usage limit needs a reset time, so the host can offer an automatic recovery at a known
// moment instead of matching the error string again. Fixed `now` keeps the arithmetic checkable.
// A wall clock in the message means the reader's clock, so `now` is built the same way.
const now = new Date(2026, 2, 5, 10, 0, 0, 0).getTime()
const local = (day: number, hour: number, minute: number): number => new Date(2026, 2, day, hour, minute, 0, 0).getTime()

describe('parseUsageLimit', () => {
  it('reads a retry-after delay', () => {
    expect(parseUsageLimit('429 Too Many Requests: retry after 90', { provider: 'claude', now }))
      .toMatchObject({ resetAt: now + 90_000, source: 'retry_after' })
  })

  it('reads a relative reset in each unit and language', () => {
    expect(parseUsageLimit('Limit reached. Resets in 2 hours', { provider: 'claude', now })?.resetAt)
      .toBe(now + 7_200_000)
    expect(parseUsageLimit('rate limit — resets in 30 minutes', { provider: 'codex', now })?.resetAt)
      .toBe(now + 1_800_000)
    expect(parseUsageLimit('配额用完，5 小时后恢复', { provider: 'antigravity', now })?.resetAt)
      .toBe(now + 18_000_000)
  })

  it('reads an ISO timestamp', () => {
    expect(parseUsageLimit('usage limit reached, resets at 2026-03-05T12:30:00Z', { provider: 'claude', now }))
      .toMatchObject({ resetAt: Date.parse('2026-03-05T12:30:00Z'), source: 'iso' })
  })

  it('reads a wall clock and rolls to the next day when it already passed', () => {
    expect(parseUsageLimit('quota exceeded, resets at 2:30 pm', { provider: 'claude', now })?.resetAt)
      .toBe(local(5, 14, 30))
    // 09:30 is before `now`, so the reset is tomorrow.
    expect(parseUsageLimit('quota exceeded, resets at 9:30 am', { provider: 'claude', now })?.resetAt)
      .toBe(local(6, 9, 30))
    expect(parseUsageLimit('额度用完，明天 08:15 重置', { provider: 'claude', now })?.resetAt)
      .toBe(local(6, 8, 15))
  })

  it('keeps the window when the provider named one', () => {
    expect(parseUsageLimit('5-hour limit reached, resets in 1 hour', { provider: 'claude', now }))
      .toMatchObject({ window: '5-hour', resetAt: now + 3_600_000 })
  })

  it('reports a quota without a reset time instead of inventing one', () => {
    expect(parseUsageLimit('usage limit reached', { provider: 'codex', now }))
      .toEqual({ provider: 'codex', resetAt: null, source: null })
  })

  it('ignores messages that are not about quota', () => {
    expect(parseUsageLimit('MCP connection failed', { provider: 'claude', now })).toBeUndefined()
    expect(parseUsageLimit('', { provider: 'claude', now })).toBeUndefined()
  })
})
