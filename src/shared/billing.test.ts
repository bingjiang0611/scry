import { describe, expect, it } from 'vitest'
import { billingProviderForUpstream } from './billing'

describe('billingProviderForUpstream', () => {
  it('recognizes Qoder without changing known mappings or guessing custom aliases', () => {
    expect(billingProviderForUpstream('qoder')).toBe('qoder')
    expect(billingProviderForUpstream('openai-codex')).toBe('codex')
    expect(billingProviderForUpstream('google')).toBe('gemini')
    expect(billingProviderForUpstream('anthropic')).toBe('anthropic')
    expect(billingProviderForUpstream('custom-qoder')).toBeUndefined()
    expect(billingProviderForUpstream(undefined)).toBeUndefined()
  })
})
