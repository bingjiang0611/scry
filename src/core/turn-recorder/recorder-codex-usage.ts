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
