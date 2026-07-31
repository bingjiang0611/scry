import { describe, expect, it } from 'vitest'
import { scanMcp } from '../cli/mcpguard-core'
import { isMcpGuardReport } from './mcpguard-report'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('mcpguard report boundary', () => {
  it('accepts a complete report and rejects inconsistent or non-finite summaries', () => {
    const valid = scanMcp({ configPaths: [], now: '2026-08-01T00:00:00.000Z' })
    expect(isMcpGuardReport(valid)).toBe(true)

    const nan = clone(valid) as unknown as { summary: { high: number } }
    nan.summary.high = Number.NaN
    expect(isMcpGuardReport(nan)).toBe(false)

    const inconsistent = clone(valid)
    inconsistent.summary.high = 1
    inconsistent.summary.status = 'pass'
    expect(isMcpGuardReport(inconsistent)).toBe(false)
  })

  it('rejects invalid nested target and finding evidence instead of rendering a green pass', () => {
    const valid = scanMcp({ configPaths: [], now: '2026-08-01T00:00:00.000Z' })
    const malformed = clone(valid) as unknown as { scan: { analyzers: unknown[] } }
    malformed.scan.analyzers = [{ name: 'config-static' }]
    expect(isMcpGuardReport(malformed)).toBe(false)
  })
})
