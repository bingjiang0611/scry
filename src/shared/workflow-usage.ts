export type WorkflowUsageProvenance = 'exact' | 'estimated' | 'unavailable'
export type WorkflowUsage = Readonly<{
  provenance: WorkflowUsageProvenance
  source: 'recorder' | 'workflow_ledger' | 'none'
  inputTokens?: number
  outputTokens?: number
  cost?: number
  costUnit?: string
  reason?: string
}>

export function workflowUsageFromRecorder(evidence: unknown): WorkflowUsage {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { provenance: 'unavailable', source: 'none', reason: 'Recorder evidence is absent' }
  const value = evidence as Record<string, unknown>
  const inputTokens = typeof value.inputTokens === 'number' && Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 ? value.inputTokens : undefined
  const outputTokens = typeof value.outputTokens === 'number' && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0 ? value.outputTokens : undefined
  const cost = typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : undefined
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return { provenance: 'unavailable', source: 'recorder', reason: 'Recorder evidence has no usable usage fields' }
  const exact = value.quality === 'exact' || value.status === 'available'
  return { provenance: exact ? 'exact' : 'estimated', source: 'recorder', ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(cost === undefined ? {} : { cost }), ...(typeof value.costUnit === 'string' ? { costUnit: value.costUnit } : {}) }
}
