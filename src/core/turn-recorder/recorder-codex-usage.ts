import type { TraceEvent } from '../../shared/trace.js'

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

export function codexTurnUsageDelta(latest: CodexUsageCounters, baseline: CodexUsageCounters): CodexUsageCounters {
  return {
    tokensIn: Math.max(0, latest.tokensIn - baseline.tokensIn),
    tokensOut: Math.max(0, latest.tokensOut - baseline.tokensOut),
    cacheReadTokens: Math.max(0, latest.cacheReadTokens - baseline.cacheReadTokens),
    cacheCreationTokens: Math.max(0, latest.cacheCreationTokens - baseline.cacheCreationTokens),
    reasoningTokens: Math.max(0, latest.reasoningTokens - baseline.reasoningTokens)
  }
}
