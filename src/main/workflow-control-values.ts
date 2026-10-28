import { createHash } from 'node:crypto'
import type { WorkflowCollectionEntry, WorkflowCollectionReference, WorkflowControlFrame, WorkflowEvaluation, WorkflowExpression, WorkflowFrameReference, WorkflowPlanPreview, WorkflowValueReference } from '../shared/workflow'
import { workflowFrameCopy } from '../shared/constants/copy'
import { workflowCollectionFields, workflowExpressionSteps } from './workflow-expressions'
import { evaluateWorkflowCollection } from './workflow-collection-expressions'
import { collectionDescriptor } from './workflow-collections'
import type { WorkflowStore } from './workflow-store'
import type { WorkflowControlScope } from './workflow-control'
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Canonical immutable value/collection operations, shared by the control owner. */
export class WorkflowControlValues {
  constructor(protected readonly store: WorkflowStore, protected readonly preview: WorkflowPlanPreview) {}
  async collection(frame: Pick<WorkflowControlFrame, 'frameId'>, entries: WorkflowCollectionEntry[], sealed: boolean): Promise<Extract<WorkflowEvaluation, { state: 'known' }> & { collection: WorkflowCollectionReference }> {
    const collection = await this.store.saveCollection(this.preview.workflowId, digest([frame.frameId, 'entries']), entries, sealed)
    return { state: 'known', value: collectionDescriptor(collection), collection, derivedFrom: [`collection:${collection.reference.key}:${collection.reference.hash}`] }
  }
  async entries(value: Extract<WorkflowEvaluation, { state: 'known' }>): Promise<WorkflowCollectionEntry[]> {
    if (!value.collection || !value.collection.sealed) throw new Error(workflowFrameCopy.missing)
    return this.store.loadCollection(this.preview.workflowId, value.collection)
  }
  async entryValue(entry: WorkflowCollectionEntry): Promise<Extract<WorkflowEvaluation, { state: 'known' }>> {
    const reference = entry.reference?.resultRef ?? entry.valueRef
    const value = entry.reference ? await this.readCommitted(entry.reference) : entry.valueRef ? await this.store.loadValue(this.preview.workflowId, entry.valueRef) : undefined
    const error = entry.error ?? (value?.state === 'unknown' ? value.reason : undefined)
    const fields = value ? workflowCollectionFields(value, ['value']) : []
    return { state: 'known', value: { key: entry.key, index: entry.index, state: entry.state, settled: entry.settled,
      ...(value?.state === 'known' ? { value: value.value } : {}), ...(error ? { error } : {})
    }, ...(fields.length ? { collectionFields: fields } : {}), derivedFrom: reference ? [`value:${reference.key}:${reference.hash}`] : [] }
  }
  async saveCollectionValue(value: WorkflowEvaluation): Promise<WorkflowValueReference> {
    return this.store.saveValue(this.preview.workflowId, 'collection_member', value)
  }
  async evaluate(expression: WorkflowExpression, scope: WorkflowControlScope, label: string, stopped: () => boolean): Promise<WorkflowEvaluation> {
    const steps = workflowExpressionSteps(expression, scope.bindings)
    let step = steps.next(), ordinal = 0
    while (!step.done) {
      // Pure immutable artifacts belong to the frozen input/program, not the
      // controller generation. Changing their keys would invalidate consumers
      // even when recovery reuses exactly the same committed source outcomes.
      const identity = digest([this.preview.programRevision, scope.path, label, ordinal++])
      step = steps.next(await evaluateWorkflowCollection(this, step.value, identity, scope.path, stopped))
    }
    return step.value
  }
  async readCommitted(reference: WorkflowFrameReference): Promise<WorkflowEvaluation> {
    const frame = await this.store.loadFrame(this.preview.workflowId, reference.frameId)
    if (!frame || frame.phase === 'entered' || frame.phase === 'selected' || frame.revision !== reference.revision || !frame.resultRef || frame.resultRef.key !== reference.resultRef.key || frame.resultRef.hash !== reference.resultRef.hash) throw new Error(workflowFrameCopy.identity)
    return this.store.loadValue(this.preview.workflowId, reference.resultRef)
  }
}
