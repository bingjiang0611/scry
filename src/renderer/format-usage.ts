// 用量口径：cache token 是否计入输入由 Provider 决定；缺字段的轮次不能被算成 0。
import type { TraceEvent } from '@shared/trace'

export type TokenCacheAccounting = 'separate' | 'input_includes_cache'

export function tokenCacheAccounting(e: Pick<TraceEvent, 'providerId' | 'runtimeProvider' | 'billingProvider'> | undefined): TokenCacheAccounting {
  if (e?.providerId === 'opencode' || e?.runtimeProvider === 'opencode_server') return 'separate'
  if (
    e?.providerId === 'codex' ||
    e?.runtimeProvider === 'codex_cli' ||
    e?.billingProvider === 'codex' ||
    e?.billingProvider === 'openai'
  ) {
    return 'input_includes_cache'
  }
  return 'separate'
}

export function usageTokenTotal(
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheCreation = 0,
  accounting: TokenCacheAccounting = 'separate'
): number {
  return input + output + (accounting === 'separate' ? cacheRead + cacheCreation : 0)
}

export function resultTokenTotal(e: TraceEvent | undefined): number {
  return usageTokenTotal(
    e?.tokensIn ?? 0,
    e?.tokensOut ?? 0,
    e?.cacheReadTokens ?? 0,
    e?.cacheCreationTokens ?? 0,
    tokenCacheAccounting(e)
  )
}

export function hasTokenUsage(e: TraceEvent | undefined): boolean {
  return !!e && (e.tokensIn != null || e.tokensOut != null || e.cacheReadTokens != null || e.cacheCreationTokens != null)
}

export interface CacheHitEvidence {
  rate: number | null
  knownResults: number
  missingResults: number
}

export function cacheHitEvidence(results: TraceEvent[]): CacheHitEvidence {
  let cacheRead = 0
  let eligibleInput = 0
  let knownResults = 0
  for (const result of results) {
    const accounting = tokenCacheAccounting(result)
    const complete = result.tokensIn != null && result.cacheReadTokens != null &&
      (accounting === 'input_includes_cache' || result.cacheCreationTokens != null)
    if (!complete) continue
    const denominator = accounting === 'input_includes_cache'
      ? result.tokensIn!
      : result.tokensIn! + result.cacheReadTokens! + result.cacheCreationTokens!
    if (denominator <= 0) continue
    cacheRead += result.cacheReadTokens!
    eligibleInput += denominator
    knownResults++
  }
  return {
    rate: eligibleInput > 0 ? Math.min(100, (cacheRead / eligibleInput) * 100) : null,
    knownResults,
    missingResults: Math.max(0, results.length - knownResults)
  }
}
