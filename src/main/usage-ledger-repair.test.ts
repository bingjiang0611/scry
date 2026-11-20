import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { sdkUsageLedgerRowsFromItems } from './billing-ledger'
import { USAGE_LEDGER_COLS } from './span-ledger'
import { repairMissingUsageLedger } from './usage-ledger-repair'

describe('S7 / S9: Antigravity 缺失费用在 billing-ledger 与 usage-ledger-repair 中保持 null 且不伪标 sdk_estimate/inferred', () => {
  it('sdkUsageLedgerRowsFromItems: Antigravity 无费用时 cost=null、currency=null、costUnit=token，且绝不标 sdk_estimate 或 inferred', () => {
    const result: TraceEvent = {
      id: 'agy-res-1',
      ts: '2026-11-20T08:00:00.000Z',
      runId: 'run-agy-1',
      kind: 'harness',
      stage: 'result',
      providerId: 'antigravity',
      runtimeProvider: 'antigravity_acp',
      usageSource: 'antigravity_acp',
      billingProvider: 'antigravity',
      tokensIn: 120,
      tokensOut: 60,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
      reasoningTokens: 15
    } as TraceEvent

    const rows = sdkUsageLedgerRowsFromItems({
      runId: 'run-agy-1',
      sessionId: 'sess-agy-1',
      cwd: '/repo',
      items: [result],
      nowMs: 1_795_000_000_000,
      billingProvider: 'antigravity',
      runtimeProvider: 'antigravity_acp'
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe('antigravity')
    expect(rows[0].cost).toBeNull()
    expect(rows[0].currency).toBeNull()
    expect(rows[0].costUnit).toBe('token')
    expect(rows[0].sourceKind).not.toBe('sdk_estimate')
    expect(rows[0].costSource).not.toBe('sdk_estimate')
    expect(rows[0].confidence).not.toBe('inferred')
    expect(rows[0].metadata?.costStatus).toBe('unavailable')
  })

  it('repairMissingUsageLedger: Antigravity 旧记录 cost=0 或 null 均修复为 cost=null、costUnit=token、currency=null', () => {
    const inserted: unknown[][] = []
    const fakeDb = {
      prepare: (sql: string) => {
        if (sql.includes('SELECT')) {
          return {
            all: () => [
              {
                spanId: 'span-agy-zero',
                sessionId: 'sess-agy',
                runId: 'run-agy',
                cwd: '/repo',
                ts: 1_795_000_000_000,
                providerId: 'antigravity',
                runtimeProvider: 'antigravity_acp',
                model: null,
                upstreamProvider: null,
                hasModel: 0,
                input: 100,
                output: 50,
                cacheRead: 20,
                cacheWrite: 0,
                cost: 0
              },
              {
                spanId: 'span-agy-null',
                sessionId: 'sess-agy',
                runId: 'run-agy-2',
                cwd: '/repo',
                ts: 1_795_000_000_001,
                providerId: 'antigravity',
                runtimeProvider: 'antigravity_acp',
                model: null,
                upstreamProvider: null,
                hasModel: 0,
                input: 80,
                output: 40,
                cacheRead: 10,
                cacheWrite: 0,
                cost: null
              }
            ]
          }
        }
        return {
          run: (...params: unknown[]) => {
            inserted.push(params)
            return { changes: 1 }
          }
        }
      }
    }

    repairMissingUsageLedger(fakeDb as unknown as Parameters<typeof repairMissingUsageLedger>[0])
    expect(inserted).toHaveLength(2)
    for (const row of inserted) {
      const obj = Object.fromEntries(USAGE_LEDGER_COLS.map((c, i) => [c, row[i]]))
      expect(obj.provider).toBe('antigravity')
      expect(obj.cost).toBeNull()
      expect(obj.currency).toBeNull()
      expect(obj.cost_unit).toBe('token')
      expect(obj.cost_source).not.toBe('sdk_estimate')
      expect(obj.confidence).not.toBe('inferred')
    }
  })
})
