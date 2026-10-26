import { describe, expect, it } from 'vitest'
import { providerCompatibilityNotice } from './useIntegrations'

describe('providerCompatibilityNotice', () => {
  const advisory = (overrides: Record<string, unknown> = {}) => ({
    status: 'unsupported' as const,
    observedVersion: '1.1.60',
    recommendedRange: '>=1.2.0',
    matchedRange: '<1.2.0',
    reason: '这个版本只验证过版本探测',
    source: 'bundled' as const,
    manifestUpdatedAt: '2026-10-15T00:00:00.000Z',
    ...overrides
  })

  it('只在确有判定结论时提示，并带上依据', () => {
    expect(providerCompatibilityNotice({ name: 'Qoder', compatibility: advisory() }))
      .toBe('Qoder 1.1.60：这个版本只验证过版本探测；推荐版本 >=1.2.0')
  })

  it('supported 与 unknown 不提示，缺失 advisory 也不提示', () => {
    expect(providerCompatibilityNotice({ name: 'Codex', compatibility: advisory({ status: 'supported' }) })).toBeNull()
    expect(providerCompatibilityNotice({ name: 'Claude Code', compatibility: advisory({ status: 'unknown', observedVersion: null }) })).toBeNull()
    expect(providerCompatibilityNotice({ name: 'Pi' })).toBeNull()
    expect(providerCompatibilityNotice(null)).toBeNull()
  })

  it('没有版本或推荐范围时不编造字段', () => {
    expect(providerCompatibilityNotice({
      name: 'OpenCode',
      compatibility: advisory({ status: 'broken', observedVersion: null, recommendedRange: null })
    })).toBe('OpenCode：这个版本只验证过版本探测')
  })
})
