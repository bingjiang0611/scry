import { providerUsageResultEvents } from './result-timing'
import type { ModelUsageRow, TraceEvent } from './trace'

export type WorkflowUsageProvenance = 'exact' | 'partial' | 'estimated' | 'unavailable'
export type WorkflowUsageSource = 'recorder' | 'workflow_ledger' | 'provider_result' | 'classifier_result' | 'none'
export type WorkflowUsage = Readonly<{
  provenance: WorkflowUsageProvenance
  source: WorkflowUsageSource
  inputTokens?: number
  outputTokens?: number
  cost?: number
  costUnit?: string
  reason?: string
}>

const validInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function normalizeWorkflowUsage(value: unknown): WorkflowUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (!['exact', 'partial', 'estimated', 'unavailable'].includes(String(input.provenance)) ||
      !['recorder', 'workflow_ledger', 'provider_result', 'classifier_result', 'none'].includes(String(input.source))) return undefined
  const provenance = input.provenance as WorkflowUsageProvenance
  const source = input.source as WorkflowUsageSource
  const inputTokens = validInteger(input.inputTokens) ? input.inputTokens : undefined
  const outputTokens = validInteger(input.outputTokens) ? input.outputTokens : undefined
  const cost = validNumber(input.cost) ? input.cost : undefined
  const costUnit = typeof input.costUnit === 'string' && input.costUnit.length > 0 ? input.costUnit : undefined
  const hasEvidence = inputTokens !== undefined || outputTokens !== undefined || cost !== undefined
  if (provenance === 'unavailable') {
    if (hasEvidence || costUnit !== undefined) return undefined
  } else if (!hasEvidence || source === 'none' || cost === undefined && costUnit !== undefined) return undefined
  return { provenance, source, ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cost === undefined ? {} : { cost }), ...(costUnit === undefined ? {} : { costUnit }),
    ...(typeof input.reason === 'string' ? { reason: input.reason } : {}) }
}

function completeSum(values: readonly (number | undefined)[]): number | undefined {
  return values.length > 0 && values.every(value => value !== undefined) ? values.reduce<number>((sum, value) => sum + value!, 0) : undefined
}

function modelSum(rows: readonly ModelUsageRow[] | undefined, field: 'inputTokens' | 'outputTokens' | 'costUsd'): number | undefined {
  return rows?.length ? completeSum(rows.map(row => row[field])) : undefined
}

function modelCostUnit(rows: readonly ModelUsageRow[] | undefined): string | undefined {
  const billed = rows?.filter(row => row.costUsd !== undefined) ?? []
  return billed.length > 0 && billed.every(row => row.costUnit !== undefined && row.costUnit === billed[0].costUnit) ? billed[0].costUnit : undefined
}

export function workflowUsageFromProviderResults(items: readonly TraceEvent[]): WorkflowUsage {
  const results = providerUsageResultEvents(items)
  if (!results.length) return { provenance: 'unavailable', source: 'none', reason: 'Provider result usage is absent' }
  const inputTokens = completeSum(results.map(result => result.tokensIn ?? modelSum(result.modelUsage, 'inputTokens')))
  const outputTokens = completeSum(results.map(result => result.tokensOut ?? modelSum(result.modelUsage, 'outputTokens')))
  const costs = results.map(result => result.costUsd ?? modelSum(result.modelUsage, 'costUsd'))
  const costUnits = results.map(result => result.costUnit ?? modelCostUnit(result.modelUsage))
  const costUnit = costUnits.length > 0 && costUnits.every(unit => unit !== undefined && unit === costUnits[0]) ? costUnits[0] : undefined
  const cost = costUnit === undefined ? undefined : completeSum(costs)
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return { provenance: 'unavailable', source: 'provider_result', reason: 'Provider result has no complete usage fields' }
  const estimated = cost !== undefined && results.some(result => {
    if (result.costUsd !== undefined) return result.costConfidence === 'estimated' || result.costConfidence === 'inferred' || result.costSource === 'sdk_estimate' || result.costSource === 'price_table'
    return result.modelUsage?.some(row => row.costUsd !== undefined && (row.costConfidence === 'estimated' || row.costConfidence === 'inferred' || row.costSource === 'sdk_estimate' || row.costSource === 'price_table'))
  })
  const missing = [inputTokens === undefined ? 'input tokens' : '', outputTokens === undefined ? 'output tokens' : '', cost === undefined ? 'cost' : ''].filter(Boolean)
  return { provenance: estimated ? 'estimated' : missing.length ? 'partial' : 'exact', source: 'provider_result',
    ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cost === undefined ? {} : { cost, costUnit }), ...(missing.length ? { reason: `Provider result omitted complete ${missing.join(', ')} evidence` } : {}) }
}

export function workflowUsageFromClassifier(inputTokens: number, outputTokens: number): WorkflowUsage {
  return { provenance: 'partial', source: 'classifier_result', inputTokens, outputTokens, reason: 'Classifier response omitted authoritative cost evidence' }
}

export function workflowUsageFromRecorder(evidence: unknown): WorkflowUsage {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { provenance: 'unavailable', source: 'none', reason: 'Recorder evidence is absent' }
  const value = evidence as Record<string, unknown>
  const inputTokens = validInteger(value.inputTokens) ? value.inputTokens : undefined
  const outputTokens = validInteger(value.outputTokens) ? value.outputTokens : undefined
  const cost = validNumber(value.cost) ? value.cost : undefined
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return { provenance: 'unavailable', source: 'recorder', reason: 'Recorder evidence has no usable usage fields' }
  const exact = value.quality === 'exact' || value.status === 'available'
  return { provenance: exact ? 'exact' : 'estimated', source: 'recorder', ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(cost === undefined ? {} : { cost }), ...(typeof value.costUnit === 'string' ? { costUnit: value.costUnit } : {}) }
}
