import type { WorkflowEvaluation, WorkflowFrameReference, WorkflowOutputRef, WorkflowValueReference } from './workflow'
import { normalizeWorkflowUsage, type WorkflowUsage } from './workflow-usage'

export type WorkflowClassifierKind = 'bool' | 'choice' | 'score'

export interface WorkflowClassifierBlock {
  kind: 'classifier'
  blockId: string
  classifierId: string
  classifier: WorkflowClassifierKind
  prompt: string
  criteria: string
  model?: string
  threshold?: WorkflowClassifierThreshold
  choices?: string[]
  score?: { min: number; max: number }
  inputRefs?: WorkflowOutputRef[]
}
export type WorkflowClassifierThreshold = Readonly<{ min?: number; max?: number }>
export type WorkflowClassifierValue = boolean | string | number
export type WorkflowClassifierProbability = Readonly<Record<string, number>>

/** A classifier request is data only. The runner owns its slot, frame and
 * checkpoint identities; an adapter cannot use this object to bypass recovery. */
export type WorkflowClassifierIntent = Readonly<{
  classifierId: string
  workflowId: string
  programRevision: string
  nodeId: string
  frame: WorkflowFrameReference
  checkpointKey: string
  recoveryGeneration: string
  createdAt: number
  kind: WorkflowClassifierKind
  prompt: string
  criteria: string
  model?: string
  threshold?: WorkflowClassifierThreshold
  choices?: readonly string[]
  score?: { min: number; max: number }
  /** Declared inputs and their immutable materializations are part of the intent. */
  inputRefs: readonly WorkflowOutputRef[]
  inputs: readonly WorkflowClassifierInput[]
}>

export type WorkflowClassifierInput = Readonly<{
  nodeId: string
  path: readonly string[]
  valueRef: WorkflowValueReference
  value: WorkflowEvaluation
}>

export type WorkflowClassifierOutcome = Readonly<{
  classifierId: string
  state: 'completed' | 'failed' | 'blocked' | 'unknown' | 'unavailable'
  settled: boolean
  value?: WorkflowClassifierValue
  probability?: WorkflowClassifierProbability
  confidence?: number
  provenance: 'provider' | 'recorded' | 'unavailable'
  source?: string
  reason?: string
  usage?: WorkflowUsage
  resultRef?: WorkflowValueReference
}>

export type WorkflowClassifierAdapter = (intent: WorkflowClassifierIntent, signal?: AbortSignal) => Promise<WorkflowClassifierOutcome>

export function unavailableWorkflowClassifierOutcome(intent: WorkflowClassifierIntent): WorkflowClassifierOutcome {
  return { classifierId: intent.classifierId, state: 'unavailable', settled: true, provenance: 'unavailable', reason: 'no production classifier adapter is registered' }
}
export const unavailableWorkflowClassifier: WorkflowClassifierAdapter = async intent => unavailableWorkflowClassifierOutcome(intent)

function validProbabilityMap(value: unknown): value is WorkflowClassifierProbability {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1)
}

/** Normalizes an adapter result without inventing confidence or probabilities. */
export function normalizeWorkflowClassifierOutcome(intent: WorkflowClassifierIntent, value: unknown): WorkflowClassifierOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailableWorkflowClassifierOutcome(intent)
  const input = value as Record<string, unknown>
  const state = input.state
  if (!['completed', 'failed', 'blocked', 'unknown', 'unavailable'].includes(state as string)) return unavailableWorkflowClassifierOutcome(intent)
  const probability = input.probability === undefined ? undefined : validProbabilityMap(input.probability) ? input.probability : undefined
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence) && input.confidence >= 0 && input.confidence <= 1 ? input.confidence : undefined
  const usage = normalizeWorkflowUsage(input.usage)
  const outcome: WorkflowClassifierOutcome = {
    classifierId: intent.classifierId, state: state as WorkflowClassifierOutcome['state'], settled: input.settled === true,
    provenance: input.provenance === 'provider' || input.provenance === 'recorded' ? input.provenance : 'unavailable',
    ...(typeof input.value === 'boolean' || typeof input.value === 'string' || typeof input.value === 'number' ? { value: input.value } : {}),
    ...(probability ? { probability } : {}), ...(confidence === undefined ? {} : { confidence }),
    ...(typeof input.source === 'string' ? { source: input.source } : {}), ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
    ...(usage ? { usage } : {}),
    ...(input.resultRef && typeof input.resultRef === 'object' && !Array.isArray(input.resultRef) ? { resultRef: input.resultRef as WorkflowValueReference } : {})
  }
  return outcome
}

export function applyWorkflowClassifierThreshold(intent: WorkflowClassifierIntent, outcome: WorkflowClassifierOutcome): WorkflowClassifierOutcome {
  const threshold = intent.threshold
  if (outcome.state !== 'completed' || outcome.confidence === undefined || !threshold) return outcome
  if ((threshold.min !== undefined && outcome.confidence < threshold.min) || (threshold.max !== undefined && outcome.confidence > threshold.max)) {
    return { classifierId: intent.classifierId, state: 'blocked', settled: true, provenance: outcome.provenance, confidence: outcome.confidence,
      ...(outcome.source ? { source: outcome.source } : {}), ...(outcome.usage ? { usage: outcome.usage } : {}),
      reason: 'classifier confidence is outside the frozen threshold' }
  }
  return outcome
}

export function validateWorkflowClassifierOutcome(intent: WorkflowClassifierIntent, outcome: WorkflowClassifierOutcome): WorkflowClassifierOutcome {
  if (outcome.classifierId !== intent.classifierId) throw new Error('classifier outcome identity mismatch')
  if (outcome.state === 'completed') {
    if (!outcome.settled || outcome.provenance === 'unavailable' || outcome.value === undefined || outcome.confidence === undefined) throw new Error('completed classifier outcome requires settled value and confidence')
    if ((intent.kind === 'bool' || intent.kind === 'choice') && !outcome.probability) throw new Error('completed classifier outcome requires probability')
  }
  if (outcome.confidence !== undefined && (!Number.isFinite(outcome.confidence) || outcome.confidence < 0 || outcome.confidence > 1)) throw new Error('classifier confidence is invalid')
  if (outcome.probability && (Object.keys(outcome.probability).length === 0 || Object.values(outcome.probability).some(value => value < 0 || value > 1 || !Number.isFinite(value)))) throw new Error('classifier probability is invalid')
  if (intent.kind === 'bool' && outcome.value !== undefined && typeof outcome.value !== 'boolean') throw new Error('boolean classifier value is invalid')
  if (intent.kind === 'choice' && outcome.value !== undefined && (typeof outcome.value !== 'string' || !intent.choices?.includes(outcome.value))) throw new Error('choice classifier value is invalid')
  if (intent.kind === 'score' && outcome.value !== undefined && (typeof outcome.value !== 'number' || !intent.score || outcome.value < intent.score.min || outcome.value > intent.score.max)) throw new Error('score classifier value is invalid')
  return outcome
}
