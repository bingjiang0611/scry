import type { WorkflowBlock, WorkflowControlFrame, WorkflowEvaluation, WorkflowLoopCheckpoint, WorkflowPlanPreview, WorkflowValue, WorkflowValueReference, WorkflowValueSchema } from '../shared/workflow'
import type { WorkflowSystemOutcome } from '../shared/workflow-system'
import { workflowRecoveryCopy, workflowSystemCopy } from '../shared/constants/copy'
import { workflowLoopStateTypes } from './workflow-program'
import { workflowFrameId } from './workflow-frames'
import { WorkflowControlValues } from './workflow-control-values'
import type { WorkflowExecutionOwnership, WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import type { WorkflowControlScope } from './workflow-control'

/** Same-revision committed control recovery; new revisions do not transplant
 * collection/loop subtrees. Their Interpreter derives current frames afresh. */
export class WorkflowControlRecovery extends WorkflowControlValues {
  protected readonly origins = new Map<string, WorkflowControlFrame[]>()
  constructor(store: WorkflowStore, preview: WorkflowPlanPreview,
    protected readonly execution?: { record: WorkflowStoreRecord; previous: WorkflowExecutionOwnership['segments']; generationId?: string }) { super(store, preview) }
  recoveredSystem(block: WorkflowBlock, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined): WorkflowSystemOutcome | undefined {
    if (!this.execution?.previous.length) return undefined
    const taskId = this.preview.workflowId + ':' + workflowFrameId(block.blockId, scope.path) + ':' + block.blockId
    const intent = this.execution.record.systemIntents?.find(value => value.taskId === taskId)
    const outcome = this.execution.record.systemOutcomes?.find(value => value.taskId === taskId)
    if (!intent && !outcome) {
      if (frame && this.origins.get(frame.frameId)?.some(value => value.phase === 'completed')) throw new Error(workflowSystemCopy.intent)
      return undefined
    }
    if (!frame || !this.origins.has(frame.frameId)) throw new Error(workflowRecoveryCopy.frame)
    if (!intent || !outcome || !outcome.settled || outcome.state === 'unknown' || !outcome.resultRef) throw new Error(workflowSystemCopy.unknown)
    return outcome
  }
  async restoreLoop(frame: WorkflowControlFrame): Promise<{ checkpoint: WorkflowLoopCheckpoint; values: Record<string, WorkflowEvaluation>; invariants: Record<string, WorkflowEvaluation> } | undefined> {
    const checkpoint = this.origins.get(frame.frameId)?.find(prior => prior.loop !== undefined)?.loop
    if (!checkpoint) return undefined
    const load = async (values: Record<string, WorkflowValueReference>) => {
      const entries: Array<[string, WorkflowEvaluation]> = []
      for (const [name, reference] of Object.entries(values)) entries.push([name, await this.store.loadValue(this.preview.workflowId, reference)])
      return Object.fromEntries(entries)
    }
    await load(checkpoint.initialStateRefs)
    for (const reference of [...checkpoint.iterations, ...(checkpoint.semanticStateRef ? [checkpoint.semanticStateRef] : []), ...(checkpoint.initialSemanticStateRef ? [checkpoint.initialSemanticStateRef] : []), ...(checkpoint.bestRef ? [checkpoint.bestRef] : []), ...(checkpoint.outcomeRef ? [checkpoint.outcomeRef] : [])]) await this.store.loadValue(this.preview.workflowId, reference)
    return { checkpoint: structuredClone(checkpoint), values: await load(checkpoint.stateRefs), invariants: await load(checkpoint.invariantRefs) }
  }
  loopSchemas(nodeId: string): Record<string, WorkflowValueSchema> { return workflowLoopStateTypes(this.preview.program.body, nodeId) }
  async saveBindings(values: Record<string, WorkflowEvaluation>): Promise<Record<string, WorkflowValueReference>> {
    const entries: Array<[string, WorkflowValueReference]> = []
    for (const [name, value] of Object.entries(values)) entries.push([name, await this.store.saveValue(this.preview.workflowId, 'loop_binding', value)])
    return Object.fromEntries(entries)
  }
  async saveLoopRecord(value: WorkflowValue): Promise<WorkflowValueReference> {
    return this.store.saveValue(this.preview.workflowId, 'loop_record', { state: 'known', value, derivedFrom: [] })
  }
  async checkpointLoop(frame: WorkflowControlFrame, loop: WorkflowLoopCheckpoint): Promise<WorkflowControlFrame> {
    const { revision, ...input } = frame
    return this.store.saveFrame({ ...input, loop }, revision)
  }
  async restoredCollection(frame: WorkflowControlFrame): Promise<{ value: WorkflowEvaluation; phase: WorkflowControlFrame['phase']; reportPartial: boolean } | undefined> {
    const origin = this.origins.get(frame.frameId)?.find(prior => prior.resultRef !== undefined)
    if (!origin?.resultRef || !['completed', 'failed', 'blocked', 'stopped'].includes(origin.phase)) return undefined
    const value = await this.store.loadValue(this.preview.workflowId, origin.resultRef)
    if (value.state !== 'known' || !value.collection?.sealed) return undefined
    const entries = await this.entries(value)
    for (const entry of entries) {
      if (!entry.settled || !entry.reference || entry.state === 'pending' || entry.state === 'unknown') throw new Error(workflowRecoveryCopy.frame)
      await this.readCommitted(entry.reference)
    }
    return { value, phase: origin.phase, reportPartial: origin.continuation === 'report_partial' }
  }
}
