import { describe, expect, it } from 'vitest'
import { resultTokenTotal, tokenCacheAccounting } from './format-usage'

describe('format-usage Antigravity separate accounting', () => {
  it('treats antigravity / antigravity_acp as separate and does not double-count thoughtTokens', () => {
    const event = {
      id: 'r1',
      runId: 'r1',
      ts: new Date().toISOString(),
      kind: 'harness' as const,
      stage: 'result' as const,
      providerId: 'antigravity' as const,
      runtimeProvider: 'antigravity_acp' as const,
      tokensIn: 100,
      tokensOut: 50,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
      reasoningTokens: 20
    }
    expect(tokenCacheAccounting(event)).toBe('separate')
    expect(resultTokenTotal(event)).toBe(200)
  })
})
