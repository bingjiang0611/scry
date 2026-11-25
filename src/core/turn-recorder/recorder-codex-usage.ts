import type { TraceEvent } from '../../shared/trace.js'

/** Cumulative usage the session had reached before the window a caller hands to the parser. */
export interface CodexUsageBaseline {
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
}

export type CodexUsageCounters = Required<
  Pick<TraceEvent, 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'cacheCreationTokens' | 'reasoningTokens'>
>

/** Codex field names for the counters above, in one place so every reader agrees. */
const USAGE_FIELDS = [
  ['tokensIn', 'input_tokens'],
  ['tokensOut', 'output_tokens'],
  ['cacheReadTokens', 'cached_input_tokens'],
  ['cacheCreationTokens', 'cache_write_input_tokens'],
  ['reasoningTokens', 'reasoning_output_tokens']
] as const

function counterAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Reads one `total_token_usage` or `last_token_usage` frame; absent counters read as 0. */
export function codexUsageCounters(record: Record<string, unknown>): CodexUsageCounters {
  const counters = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 }
  for (const [field, key] of USAGE_FIELDS) counters[field] = counterAt(record, key) ?? 0
  return counters
}

/**
 * Codex's `token_count` frame carries the session counters *after* the request that produced it plus
 * that request's own usage, so `total - last_token_usage` proves the cumulative the session had
 * reached before the frame's request. That is the only baseline available when the frame closing the
 * previous turn sits outside the parsed window, or before the file starts in a resumed thread.
 *
 * Returns undefined when the proof does not hold: no `last_token_usage`, a counter the frame does not
 * carry, or a `last` count above its own total. A caller must then report the turn as unknown rather
 * than subtract from zero, which would claim the whole session as one turn.
 *
 * Known limit: if the turn's first request left no usage frame, the derived value stands for the
 * counters *before the first frame's request*, so that earlier request lands outside the turn. The
 * error is at most one request short of the truth, never above it.
 */
export function codexBaselineFromLastFrame(
  total: Record<string, unknown> | undefined,
  last: Record<string, unknown> | undefined
): CodexUsageCounters | undefined {
  if (!total || !last) return undefined
  const baseline = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 }
  for (const [field, key] of USAGE_FIELDS) {
    const latest = counterAt(total, key) ?? 0
    const step = counterAt(last, key)
    if (step === undefined) {
      if (latest !== 0) return undefined
      continue
    }
    if (step > latest) return undefined
    baseline[field] = latest - step
  }
  return baseline
}

/**
 * Codex reports cumulative frames, so one turn's usage is the difference from the frame that closed
 * the previous turn. A negative step (a resumed thread rewriting the frame) reports 0 instead of a
 * negative count; that is a degraded reading of this turn, never a claim about the session total.
 */
export function codexTurnUsageDelta(latest: CodexUsageCounters, baseline: CodexUsageCounters): CodexUsageCounters {
  return {
    tokensIn: Math.max(0, latest.tokensIn - baseline.tokensIn),
    tokensOut: Math.max(0, latest.tokensOut - baseline.tokensOut),
    cacheReadTokens: Math.max(0, latest.cacheReadTokens - baseline.cacheReadTokens),
    cacheCreationTokens: Math.max(0, latest.cacheCreationTokens - baseline.cacheCreationTokens),
    reasoningTokens: Math.max(0, latest.reasoningTokens - baseline.reasoningTokens)
  }
}
