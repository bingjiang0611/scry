import { describe, expect, it } from 'vitest'
import { billingRowsFromItems } from './billing-ledger'
import { USAGE_LEDGER_COLS } from './span-ledger'
import { creditUsageEvidence } from '../shared/credit-usage'
import type { TraceEvent } from '../shared/trace'

const credits: TraceEvent = { id: 'credits:run', runId: 'run', ts: '2026-09-09T00:00:00Z', kind: 'harness', stage: 'credit_usage',
  creditUsage: creditUsageEvidence([{ id: 'r', runId: 'run', credits: 2.5 }], 'qoder_sdk') }
const rows = (items: TraceEvent[]) => billingRowsFromItems({ runId: 'run', sessionId: 'session', items, nowMs: 1, billingProvider: 'qoder', runtimeProvider: 'qoder_cli' })
  .usageLedger.map((row) => Object.fromEntries(USAGE_LEDGER_COLS.map((key, index) => [key, row[index]])))

describe('independent credits ledger projection', () => {
  it('stores one snapshot separately from token/USD rows, including result-less interruption', () => {
    const onlyCredits = rows([credits, credits])
    expect(onlyCredits).toHaveLength(1)
    expect(onlyCredits[0]).toMatchObject({ id: 'qoder:credits:run', usage_kind: 'credits', cost: 2.5, cost_unit: 'credits', input_tokens: null, output_tokens: null })
    const combined = rows([{ id: 'result', runId: 'run', ts: credits.ts, kind: 'harness', stage: 'result', tokensIn: 100, tokensOut: 10 }, credits])
    expect(combined).toHaveLength(2)
    expect(combined[0]).toMatchObject({ cost: null, cost_unit: 'usd', input_tokens: 100 })
    expect(combined[1]).toMatchObject({ cost: 2.5, cost_unit: 'credits', input_tokens: null })
  })
})
