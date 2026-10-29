import { describe, expect, it } from 'vitest'
import type { TraceEvent } from './trace'
import { normalizeWorkflowUsage, workflowUsageFromClassifier, workflowUsageFromProviderResults, workflowUsageFromRecorder } from './workflow-usage'

describe('workflow usage provenance', () => {
  it('does not turn absent Recorder evidence into zero', () => {
    expect(workflowUsageFromRecorder(undefined)).toMatchObject({ provenance: 'unavailable', source: 'none' })
    expect(workflowUsageFromRecorder({ inputTokens: 0, outputTokens: 0, quality: 'exact' })).toMatchObject({ provenance: 'exact', inputTokens: 0, outputTokens: 0 })
  })
  it('marks non-exact Recorder observations estimated and rejects contradictory envelopes', () => {
    expect(workflowUsageFromRecorder({ outputTokens: 4, quality: 'inferred' })).toMatchObject({ provenance: 'estimated', source: 'recorder' })
    expect(normalizeWorkflowUsage({ provenance: 'unavailable', source: 'none', cost: 1 })).toBeUndefined()
    expect(normalizeWorkflowUsage({ provenance: 'exact', source: 'none', inputTokens: 1 })).toBeUndefined()
    expect(normalizeWorkflowUsage({ provenance: 'partial', source: 'provider_result', inputTokens: 1, costUnit: 'usd' })).toBeUndefined()
  })

  it('keeps canonical Provider token and cost evidence without filling omitted fields with zero', () => {
    const base = { id: 'result', runId: 'run', ts: new Date().toISOString(), kind: 'harness' as const, stage: 'result' as const }
    expect(workflowUsageFromProviderResults([{ ...base, tokensIn: 12, tokensOut: 3, costUsd: 0.25, costUnit: 'usd', costConfidence: 'provider_reported' } satisfies TraceEvent]))
      .toEqual({ provenance: 'exact', source: 'provider_result', inputTokens: 12, outputTokens: 3, cost: 0.25, costUnit: 'usd' })
    expect(workflowUsageFromProviderResults([{ ...base, tokensIn: 12, tokensOut: 3 } satisfies TraceEvent]))
      .toMatchObject({ provenance: 'partial', source: 'provider_result', inputTokens: 12, outputTokens: 3, reason: expect.stringContaining('cost') })
    expect(workflowUsageFromProviderResults([{ ...base, modelUsage: [{ model: 'fixture', inputTokens: 5, outputTokens: 2, costUsd: 0.1,
      costUnit: 'usd', costSource: 'price_table', costConfidence: 'estimated' }] } satisfies TraceEvent]))
      .toEqual({ provenance: 'estimated', source: 'provider_result', inputTokens: 5, outputTokens: 2, cost: 0.1, costUnit: 'usd' })
    expect(workflowUsageFromProviderResults([{ ...base, tokensIn: 5, tokensOut: 2, costUsd: 0.1, costUnit: 'usd', costSource: 'provider_reported', costConfidence: 'provider_reported',
      modelUsage: [{ model: 'fixture', inputTokens: 5, outputTokens: 2, costUsd: 0.1, costUnit: 'usd', costSource: 'price_table', costConfidence: 'estimated' }] } satisfies TraceEvent]))
      .toEqual({ provenance: 'exact', source: 'provider_result', inputTokens: 5, outputTokens: 2, cost: 0.1, costUnit: 'usd' })
  })

  it('does not add incomplete multi-result usage or invent classifier cost', () => {
    const base = { runId: 'run', ts: new Date().toISOString(), kind: 'harness' as const, stage: 'result' as const, runtimeProvider: 'pi_rpc' as const }
    expect(workflowUsageFromProviderResults([
      { ...base, id: 'first', tokensIn: 4, tokensOut: 1 },
      { ...base, id: 'second', tokensOut: 2 }
    ] satisfies TraceEvent[])).toEqual({ provenance: 'partial', source: 'provider_result', outputTokens: 3,
      reason: 'Provider result omitted complete input tokens, cost evidence' })
    expect(workflowUsageFromClassifier(7, 2)).toEqual({ provenance: 'partial', source: 'classifier_result', inputTokens: 7, outputTokens: 2,
      reason: 'Classifier response omitted authoritative cost evidence' })
  })
})
