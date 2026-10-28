import { createHash } from 'node:crypto'
import type { WorkflowClassifierAdapter, WorkflowClassifierInput, WorkflowClassifierIntent, WorkflowClassifierOutcome } from '../shared/workflow-classifier'
import type { WorkflowBlock, WorkflowEvaluation, WorkflowOutputRef, WorkflowPlanPreview } from '../shared/workflow'
import type { WorkflowSlots } from './workflow-slots'
import type { WorkflowStore } from './workflow-store'
import type { WorkflowControlScope } from './workflow-control'
import { normalizeWorkflowClassifierOutcome, unavailableWorkflowClassifier, validateWorkflowClassifierOutcome, applyWorkflowClassifierThreshold } from '../shared/workflow-classifier'
import { workflowField } from './workflow-expressions'

export type WorkflowClassifierRun = Readonly<{
  intent: WorkflowClassifierIntent
  outcome: Promise<WorkflowClassifierOutcome>
  settled: Promise<void>
  stop: () => boolean
  setResultRef: (reference: import('../shared/workflow').WorkflowValueReference) => Promise<void>
}>

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function materializeWorkflowClassifierInputs(store: WorkflowStore, preview: WorkflowPlanPreview, refs: readonly WorkflowOutputRef[], scope: WorkflowControlScope, frameId: string): Promise<WorkflowClassifierInput[]> {
  const inputs: WorkflowClassifierInput[] = []
  for (const ref of refs) {
    const binding = scope.bindings.get(ref.nodeId) ?? { state: 'unknown' as const, reason: 'classifier input is unavailable', derivedFrom: [] }
    const value: WorkflowEvaluation = binding.state === 'known' && ref.path?.length ? workflowField(binding.value, ref.path, binding.derivedFrom, binding) : binding
    const valueRef = await store.saveValue(preview.workflowId, `classifier_input_${digest([frameId, ref.nodeId, ref.path ?? []])}`, value)
    inputs.push({ nodeId: ref.nodeId, path: ref.path ?? [], valueRef, value })
  }
  return inputs
}

export function classifierCheckpointKey(classifierId: string): string { return `classifier_intent_${digest(classifierId)}` }

export async function runWorkflowClassifier(args: {
  store: WorkflowStore
  preview: WorkflowPlanPreview
  record: import('./workflow-store').WorkflowStoreRecord
  progress: import('../shared/workflow').WorkflowProgress
  slots: WorkflowSlots
  adapter: WorkflowClassifierAdapter
  block: Extract<WorkflowBlock, { kind: 'classifier' }>
  scope: WorkflowControlScope
  frame: import('../shared/workflow').WorkflowControlFrame
  generationId?: string
  now: () => number
  persist: (record: import('./workflow-store').WorkflowStoreRecord, progress: import('../shared/workflow').WorkflowProgress) => Promise<void>
}): Promise<{ outcome: WorkflowClassifierOutcome; value: WorkflowEvaluation; setResultRef: WorkflowClassifierRun['setResultRef'] }> {
  const { store, preview, record, progress, slots, adapter, block, scope, frame, generationId, now, persist } = args
  const classifierId = `${preview.workflowId}:${frame.frameId}:${block.classifierId}`
  const inputs = await materializeWorkflowClassifierInputs(store, preview, block.inputRefs ?? [], scope, frame.frameId)
  const intentRef = await store.saveValue(preview.workflowId, classifierCheckpointKey(classifierId), {
    state: 'known', value: { kind: 'classifier_intent', classifierId, inputs: inputs.map(input => ({ nodeId: input.nodeId, path: [...input.path], valueRef: input.valueRef, value: input.value })) },
    derivedFrom: inputs.map(input => `value:${input.valueRef.key}:${input.valueRef.hash}`)
  })
  const intent: WorkflowClassifierIntent = { classifierId, workflowId: preview.workflowId, programRevision: preview.programRevision, nodeId: block.blockId,
    frame: { frameId: frame.frameId, revision: frame.revision, resultRef: intentRef }, checkpointKey: classifierCheckpointKey(classifierId), recoveryGeneration: generationId ?? 'initial', createdAt: now(), kind: block.classifier, prompt: block.prompt, criteria: block.criteria,
    inputRefs: block.inputRefs ?? [], inputs, ...(block.model ? { model: block.model } : {}), ...(block.threshold ? { threshold: block.threshold } : {}), ...(block.choices ? { choices: block.choices } : {}), ...(block.score ? { score: block.score } : {}) }
  ;(record.classifierIntents ??= []).push(intent)
  await persist(record, progress)
  const outcome = await enqueueWorkflowClassifier(slots, intent, adapter).outcome
  const storedOutcome = { ...outcome }
  ;(record.classifierOutcomes ??= []).push(storedOutcome)
  await persist(record, progress)
  const setResultRef = async (reference: import('../shared/workflow').WorkflowValueReference): Promise<void> => {
    storedOutcome.resultRef = reference
    await persist(record, progress)
  }
  const value: WorkflowEvaluation = outcome.state === 'completed' && outcome.value !== undefined && outcome.confidence !== undefined
    ? { state: 'known', value: { kind: 'classifier_result', value: outcome.value, confidence: outcome.confidence, ...(outcome.probability ? { probability: outcome.probability } : {}) }, derivedFrom: [`classifier:${classifierId}`] }
    : { state: 'unknown', reason: outcome.reason ?? 'classifier unavailable', derivedFrom: [`classifier:${classifierId}`] }
  return { outcome, value, setResultRef }
}

/** Main-owned adapter seam. Scheduling remains the existing Runner's job; this
 * only binds a classifier result to an already admitted slot/frame/checkpoint. */
export function executeWorkflowClassifier(intent: WorkflowClassifierIntent, adapter: WorkflowClassifierAdapter = unavailableWorkflowClassifier): WorkflowClassifierRun {
  const controller = new AbortController()
  let close!: () => void
  const settled = new Promise<void>(resolve => { close = resolve })
  const outcome = Promise.resolve().then(async () => {
    if (controller.signal.aborted) return { classifierId: intent.classifierId, state: 'unknown', settled: true, provenance: 'unavailable', reason: 'classifier stopped' } satisfies WorkflowClassifierOutcome
    const raw = await adapter(intent)
    return applyWorkflowClassifierThreshold(intent, validateWorkflowClassifierOutcome(intent, normalizeWorkflowClassifierOutcome(intent, raw)))
  }).catch(error => ({ classifierId: intent.classifierId, state: 'unknown', settled: false, provenance: 'unavailable', reason: String(error) } satisfies WorkflowClassifierOutcome)).finally(close)
  return { intent, outcome, settled, stop: () => { controller.abort(); return true }, setResultRef: async () => undefined }
}

/** Uses the existing fair Runner slot queue; it deliberately does not add a
 * classifier scheduler or a second recovery protocol. */
export function enqueueWorkflowClassifier(slots: WorkflowSlots, intent: WorkflowClassifierIntent, adapter: WorkflowClassifierAdapter = unavailableWorkflowClassifier): WorkflowClassifierRun {
  let run: WorkflowClassifierRun | undefined
  const outcome = slots.withSlot(async () => {
    run = executeWorkflowClassifier(intent, adapter)
    return run.outcome
  }, intent.workflowId, () => run?.settled)
  const settled = outcome.then(() => run?.settled ?? Promise.resolve()).then(() => undefined)
  return { intent, outcome: outcome.then(value => value), settled, stop: () => run?.stop() ?? true, setResultRef: reference => run?.setResultRef(reference) ?? Promise.resolve() }
}
