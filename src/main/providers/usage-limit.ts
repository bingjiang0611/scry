import type { ProviderId } from '../../shared/provider'

/**
 * C4: a usage limit is a typed fact with a reset time, not a string a user has to read. The
 * providers say the same thing in different ways (`resets at 3pm`, `reset in 2h`, `retry after
 * 60`, an ISO timestamp, a Chinese 「14:30 重置」), so the parser normalises them into one shape.
 *
 * A parsed limit without a reset time is still useful: the caller knows the run failed on quota
 * and must not offer an automatic retry that would fail the same way immediately.
 */
export interface UsageLimit {
  provider: ProviderId
  /** Epoch milliseconds, or null when the message does not say. */
  resetAt: number | null
  /** How the reset time was read; kept so a wrong guess is traceable. */
  source: 'retry_after' | 'relative' | 'clock' | 'iso' | null
  /** Provider's own words for the window, when it named one (e.g. `5-hour`, `weekly`). */
  window?: string
}

const RETRY_AFTER = /\bretry[\s-]*after[\s:]*(\d{1,5})\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hours?)?\b/i
const RELATIVE = /\breset(?:s)?\s+in\s+(\d{1,4})\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hours?)\b/i
const RELATIVE_ZH = /(\d{1,4})\s*(秒|分钟|分|小时)\s*后(?:重置|恢复)/
const CLOCK = /\breset(?:s)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
const CLOCK_ZH = /(\d{1,2})[:：](\d{2})\s*(?:重置|恢复)/
const ISO = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)\b/
const WINDOW = /\b(\d+[- ]?hour|\d+[- ]?minute|weekly|daily|monthly)\b/i

function unitMs(unit: string | undefined): number {
  const u = (unit ?? '').toLowerCase()
  if (u.startsWith('h')) return 3_600_000
  if (u.startsWith('m') || u === '分' || u === '分钟') return 60_000
  if (u === '小时') return 3_600_000
  return 1_000
}

function clockToEpoch(hour: number, minute: number, meridiem: string | undefined, now: number): number | undefined {
  if (hour > 23 || minute > 59) return undefined
  let h = hour
  if (meridiem?.toLowerCase() === 'pm' && h < 12) h += 12
  if (meridiem?.toLowerCase() === 'am' && h === 12) h = 0
  const base = new Date(now)
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, minute, 0, 0).getTime()
  // A reset time already past today means the next one, not a time in the past.
  return at > now ? at : at + 86_400_000
}

const QUOTA = [
  /\b429\b/, /rate[\s-]*limit/, /\bquota\b/, /resource_exhausted/, /overloaded/,
  /usage[\s-]*limit/, /too many requests/, /限流/, /配额/, /额度/, /用量/,
  // A provider may only say when the limit lifts, which is itself an admission of a limit.
  /\bresets?\s+(in|at)\b/, /重置/, /恢复/
]

export function parseUsageLimit(
  message: string,
  options: { provider: ProviderId; now: number }
): UsageLimit | undefined {
  const text = message ?? ''
  if (!QUOTA.some((pattern) => pattern.test(text.toLowerCase())) && !QUOTA.some((pattern) => pattern.test(text))) {
    return undefined
  }
  const window = WINDOW.exec(text)?.[1]
  const base = { provider: options.provider, ...(window ? { window } : {}) }

  const retry = RETRY_AFTER.exec(text)
  if (retry) {
    return { ...base, resetAt: options.now + Number(retry[1]) * unitMs(retry[2]), source: 'retry_after' }
  }
  const relative = RELATIVE.exec(text)
  if (relative) {
    return { ...base, resetAt: options.now + Number(relative[1]) * unitMs(relative[2]), source: 'relative' }
  }
  const relativeZh = RELATIVE_ZH.exec(text)
  if (relativeZh) {
    return { ...base, resetAt: options.now + Number(relativeZh[1]) * unitMs(relativeZh[2]), source: 'relative' }
  }
  const iso = ISO.exec(text)
  if (iso) {
    const at = Date.parse(iso[1]!)
    if (Number.isFinite(at)) return { ...base, resetAt: at, source: 'iso' }
  }
  const clock = CLOCK.exec(text)
  if (clock) {
    const at = clockToEpoch(Number(clock[1]), Number(clock[2] ?? 0), clock[3], options.now)
    if (at !== undefined) return { ...base, resetAt: at, source: 'clock' }
  }
  const clockZh = CLOCK_ZH.exec(text)
  if (clockZh) {
    const at = clockToEpoch(Number(clockZh[1]), Number(clockZh[2]), undefined, options.now)
    if (at !== undefined) return { ...base, resetAt: at, source: 'clock' }
  }
  return { ...base, resetAt: null, source: null }
}
