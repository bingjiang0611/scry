import { describe, expect, it } from 'vitest'
import { creditUsageEvidence, isCreditUsageEvidence, QoderCreditCollector } from './credit-usage'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { qoderCreditRequests } from './qoder-credit-requests'
import type { TraceEvent } from './trace'

const assistant = (messageId: string, usage: Record<string, unknown>, extra = {}) => ({
  type: 'assistant', message: { id: messageId, usage }, ...extra
})

describe('Qoder credit usage contract', () => {
  it('deduplicates progress/final/replay, ignores totals and subagents, and keeps the discounted amount', () => {
    const collector = new QoderCreditCollector()
    collector.observe(assistant('m1', {}))
    collector.observe(assistant('m1', { request_id: 'r1', credits: 1.25, original_credits: 99, billable: true }))
    collector.observe(assistant('m1', { request_id: 'r1', credits: 1.25, billable: true }))
    collector.observe({ type: 'result', total_credits: 1000, total_cost_usd: 1000, modelUsage: { ultimate: { credits: 1000 } } })
    collector.observe(assistant('replay', { credits: 10, billable: true }, { isReplay: true }))
    collector.observe(assistant('child', { credits: 10, billable: true }, { parent_tool_use_id: 'agent' }))
    collector.observe(assistant('free', { credits: 5, billable: false }))
    expect(collector.evidence()).toMatchObject({ status: 'partial', quality: 'exact', source: ['qoder_sdk'], value: {
      provider: 'qoder', unit: 'credits', amount: 1.25, knownRequests: 2, missingRequests: 0
    } })
    expect(isCreditUsageEvidence(collector.evidence())).toBe(true)
    expect(new QoderCreditCollector().evidence()).toMatchObject({ status: 'unavailable', value: { knownRequests: 0 } })
  })

  it('rejects invalid units, amounts, counts, source, complete claims and conflicting amounts', () => {
    const collector = new QoderCreditCollector()
    collector.observe(assistant('m1', { credits: 1, billable: true }))
    collector.observe(assistant('m1', { credits: 2, billable: true }))
    collector.observe(assistant('m1', { credits: 1, billable: true }))
    collector.observe(assistant('unknown', { original_credits: 5, billable: true }))
    collector.observe(assistant('negative', { credits: -1, billable: true }))
    collector.observe(assistant('billability-unknown', { credits: 1 }))
    expect(collector.evidence()).toMatchObject({ status: 'unavailable', value: { knownRequests: 0, missingRequests: 4 } })
    const valid = creditUsageEvidence([{ id: 'r', runId: 'run', credits: 0 }], 'qoder_native_transcript')
    expect(isCreditUsageEvidence(valid)).toBe(true)
    for (const value of [{ unit: 'usd' }, { amount: -1 }, { amount: Infinity }, { knownRequests: -1 }, { missingRequests: 0.5 }, { provider: 'codex' }]) {
      expect(isCreditUsageEvidence({ ...valid, value: { ...valid.value, ...value } })).toBe(false)
    }
    expect(isCreditUsageEvidence({ ...valid, status: 'available' })).toBe(false)
    expect(isCreditUsageEvidence({ ...valid, source: ['guessed'] })).toBe(false)
  })

  it('never charges an ambiguous message alias in addition to its known requests, in either arrival order', () => {
    const messages = [
      assistant('shared', { request_id: 'r1', credits: 1, billable: true }),
      assistant('shared', { credits: 10, billable: true }),
      assistant('shared', { request_id: 'r2', credits: 2, billable: true })
    ]
    for (const ordered of [messages, [...messages].reverse()]) {
      const collector = new QoderCreditCollector()
      ordered.forEach((row) => collector.observe(row))
      const native = [{ type: 'user', uuid: 'u', promptId: 'p', message: { content: 'prompt' } },
        ...ordered.map((row, index) => ({ ...row, uuid: `a${index}`, parentUuid: 'u' }))]
      const parsed = qoderCreditRequests(native.map((row) => JSON.stringify(row)).join('\n'), [{ runId: 'run', providerTurnId: 'p' }])
      for (const evidence of [collector.evidence(), creditUsageEvidence(parsed.requests, 'qoder_native_transcript')]) {
        expect(evidence.value).toMatchObject({ amount: 3, knownRequests: 2, missingRequests: 1 })
      }
    }
  })

  it('persists one run snapshot through recorder aggregation without changing USD/tokens', () => {
    const creditUsage = creditUsageEvidence([{ id: 'r', runId: 'run', credits: 2 }], 'qoder_sdk')
    const credit: TraceEvent = { id: 'credits:run', runId: 'run', ts: '2026-09-09T00:00:01Z', kind: 'harness', stage: 'credit_usage', creditUsage }
    const result: TraceEvent = { id: 'result', runId: 'run', ts: credit.ts, kind: 'harness', stage: 'result', tokensIn: 4, costUsd: 1.25 }
    const evidence = aggregateTurnEvidence({ events: [result, credit, credit] })
    expect(evidence.usage.value).toMatchObject({ inputTokens: 4, costUsd: 1.25, credits: { value: { amount: 2, knownRequests: 1 } } })
    expect(aggregateTurnEvidence({ events: [credit] }).usage.value).toMatchObject({ credits: creditUsage, costUsd: undefined })
  })
})
