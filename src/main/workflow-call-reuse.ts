import type { WorkflowAttemptOutcome, WorkflowBlock, WorkflowControlFrame, WorkflowPlanPreview, WorkflowValue } from '../shared/workflow'
import type { WorkflowCallReuseSource } from '../shared/workflow-call'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { workflowRetryCopy } from '../shared/constants/copy'
import type { WorkflowStore, WorkflowStoreRecord, WorkflowIntent } from './workflow-store'
import { governingWorkflowPreview } from './workflow-revisions'
import { decodeWorkflowOutput } from './workflow-values'
import { workflowField } from './workflow-expressions'
import { validateWorkflowValueReference, workflowFrameId } from './workflow-frames'
import { workflowCallAncestors, workflowCallContextIdentity } from './workflow-call-context'
import { createWorkflowCallInputs, workflowCallDefinition, workflowCallInputKey, workflowRevisionBlocks, workflowSemanticHash, workflowSemanticValue, type WorkflowCallInputs } from './workflow-call-semantics'
import type { WorkflowControlScope } from './workflow-control'
import { reusableWorkflowAgentInputs, type WorkflowAgentInputObservation } from './workflow-agent-inputs'

import type { WorkflowVerification } from './workflow-verification'
import { workflowNativeProvenance, type WorkflowProvenanceContext } from './workflow-opaque-provenance'

export class WorkflowCallReuse {
  private readonly provenance: WorkflowProvenanceContext
  constructor(private readonly store: WorkflowStore, private readonly preview: WorkflowPlanPreview, private readonly record?: WorkflowStoreRecord, verification?: WorkflowVerification) {
    this.provenance = { record, verification }
  }

  private async load(frame: Pick<WorkflowControlFrame, 'callInputRef' | 'frameId' | 'callInputKey' | 'scopePath' | 'inputKey' | 'nodeId' | 'programRevision'>, preview: WorkflowPlanPreview): Promise<{ inputs: WorkflowCallInputs; key: string; replayKey: string }> {
    if (!frame.callInputRef || frame.callInputRef.key !== workflowCallInputKey(frame.frameId)) throw new Error(copy.invalid)
    const artifact = await this.store.loadValue(preview.workflowId, frame.callInputRef)
    if (artifact.state !== 'known' || !artifact.value || typeof artifact.value !== 'object' || Array.isArray(artifact.value)) throw new Error(copy.invalid)
    const data = artifact.value as unknown as WorkflowCallInputs
    const block = workflowRevisionBlocks(preview).get(frame.nodeId)
    if (!block || block.kind !== 'call' || data.version !== 1 || data.programRevision !== preview.programRevision || frame.programRevision !== preview.programRevision || data.nodeId !== block.blockId || data.definition !== workflowCallDefinition(preview, block) || data.inputKey !== frame.inputKey || JSON.stringify(data.scopePath) !== JSON.stringify(frame.scopePath) || !Array.isArray(data.inputs) || data.inputs.length !== (block.inputRefs?.length ?? 0) || !Array.isArray(data.contexts) || !workflowCallAncestors(preview.program.body, block.blockId, data.contexts)) throw new Error(copy.invalid)
    const values: WorkflowValue[] = [], items = new Set<string>()
    for (const context of data.contexts) if (context.kind === 'map') {
      const ancestor = workflowRevisionBlocks(preview).get(context.blockId)
      if (ancestor?.kind !== 'map') throw new Error(copy.invalid)
      items.add(ancestor.item)
    }
    for (const [index, input] of data.inputs.entries()) {
      const ref = block.inputRefs![index]
      if (input.nodeId !== ref.nodeId || JSON.stringify(input.path) !== JSON.stringify(ref.path ?? []) || (input.dependency !== null && (typeof input.dependency !== 'string' || !/^[a-f0-9]{64}$/.test(input.dependency)))) throw new Error(copy.invalid)
      if ((input.valueRef === undefined) === (input.bindingRef === undefined)) throw new Error(copy.invalid)
      const reference = input.bindingRef ?? input.valueRef!
      validateWorkflowValueReference(reference, preview.workflowId)
      const binding = await this.store.loadValue(preview.workflowId, reference)
      const selected = input.bindingRef && input.path.length && binding.state === 'known'
        ? workflowField(binding.value, input.path, binding.derivedFrom, binding) : binding
      // Map item origins are selected by their context's own sealed member
      // manifest. Following the outer aggregate here would taint other groups.
      const native = items.has(input.nodeId) ? [] : await workflowNativeProvenance(this.store, preview.workflowId, binding, this.provenance)
      values.push({ nodeId: input.nodeId, path: input.path, dependency: input.dependency, value: await workflowSemanticValue(this.store, preview.workflowId, selected, this.provenance), ...(native.length ? { native } : {}) })
    }
    const contexts = await workflowCallContextIdentity(this.store, preview, data.contexts, data.scopePath, this.provenance)
    const staticScope = data.scopePath.filter(part => part.startsWith('parallel:'))
    const key = workflowSemanticHash({ definition: data.definition, staticScope, inputs: values, contexts })
    const replayContexts = contexts.map(context => {
      if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error(copy.invalid)
      const actual = { ...context }
      if (actual.kind === 'branch') { delete actual.when; delete actual.decisionSemantic }
      if (actual.kind === 'map') delete actual.sourceDefinition
      if (actual.kind === 'loop') {
        const control = actual.control
        if (!control || typeof control !== 'object' || Array.isArray(control)) throw new Error(copy.invalid)
        actual.blockId = control.blockId
        delete actual.control; delete actual.stateSemantics; delete actual.invariantSemantics
      }
      return actual
    })
    const replayKey = workflowSemanticHash({ definition: data.definition, staticScope,
      inputs: values.map(value => { const selected = { ...(value as Record<string, WorkflowValue>) }; delete selected.dependency; return selected }), contexts: replayContexts })
    if (frame.callInputKey !== undefined && key !== frame.callInputKey) throw new Error(copy.invalid)
    return { inputs: data, key, replayKey }
  }

  async inputs(block: Extract<WorkflowBlock, { kind: 'call' }>, scope: WorkflowControlScope, frame: Omit<WorkflowControlFrame, 'revision'>): Promise<Pick<WorkflowControlFrame, 'callInputRef' | 'callInputKey'>> {
    const inputs = await createWorkflowCallInputs(this.store, this.preview, block, scope, frame.inputKey)
    const callInputRef = await this.store.saveValue(this.preview.workflowId, workflowCallInputKey(frame.frameId), { state: 'known', value: JSON.parse(JSON.stringify(inputs)) as WorkflowValue, derivedFrom: [] })
    const { key } = await this.load({ ...frame, callInputRef }, this.preview)
    return { callInputRef, callInputKey: key }
  }

  private async source(intent: WorkflowIntent): Promise<{ frame: WorkflowControlFrame; preview: WorkflowPlanPreview; outcome: WorkflowAttemptOutcome; key: string; replayKey: string }> {
    if (!this.record || !intent.callFrameId) throw new Error(copy.invalid)
    const index = this.record.intents.indexOf(intent), preview = governingWorkflowPreview(this.record, 'intent', index)
    const frame = await this.store.loadFrame(preview.workflowId, intent.callFrameId)
    const outcome = this.record.outcomes.find(value => value.attemptId === intent.attemptId)
    if (!frame || !outcome || frame.programRevision !== intent.programRevision || frame.nodeId !== outcome.nodeId || intent.taskId !== `${preview.workflowId}:${workflowFrameId(frame.nodeId, frame.scopePath)}:${frame.nodeId}` || !this.record.execution?.segments.some(segment => segment.id === frame.executionEpoch && segment.generationId === frame.generationId)) throw new Error(copy.invalid)
    const { key, replayKey } = await this.load(frame, preview)
    return { frame, preview, outcome, key, replayKey }
  }

  private async committed(intent: WorkflowIntent, key: string): Promise<WorkflowCallReuseSource> {
    const source = await this.source(intent), { frame, preview, outcome } = source
    const block = workflowRevisionBlocks(preview).get(frame.nodeId)
    if (source.key !== key || block?.kind !== 'call' || outcome.state !== 'completed' || !outcome.settled || frame.phase !== 'completed' || !frame.resultRef || !frame.callInputRef || outcome.actualModelStatus !== 'observed' || (intent.requestedModel && outcome.actualModel !== intent.requestedModel)) throw new Error(copy.invalid)
    const output = await this.store.loadOutput(preview.workflowId, outcome), value = await this.store.loadValue(preview.workflowId, frame.resultRef)
    if (output === undefined || value.state !== 'known' || JSON.stringify(value.derivedFrom) !== JSON.stringify(['attempt:' + intent.attemptId]) || workflowSemanticHash(value.value) !== workflowSemanticHash(block.outputSchema ? decodeWorkflowOutput(output, block.outputSchema) : output)) throw new Error(copy.invalid)
    return { programRevision: preview.programRevision, attemptId: intent.attemptId, inputRef: frame.callInputRef,
      reference: { frameId: frame.frameId, revision: frame.revision, resultRef: frame.resultRef } }
  }

  async validateSelection(frame: WorkflowControlFrame): Promise<WorkflowAttemptOutcome | undefined> {
    if (!frame.callReuse) return undefined
    const intent = this.record?.intents.find(value => value.attemptId === frame.callReuse!.attemptId)
    if (!intent || !frame.callInputKey) throw new Error(copy.invalid)
    await this.load(frame, this.preview)
    const source = await this.committed(intent, frame.callInputKey)
    if (JSON.stringify(source) !== JSON.stringify(frame.callReuse)) throw new Error(copy.invalid)
    return this.record!.outcomes.find(value => value.attemptId === intent.attemptId)!
  }

  async select(frame: WorkflowControlFrame, observe: () => Promise<WorkflowAgentInputObservation | undefined>): Promise<WorkflowCallReuseSource | undefined> {
    if (!this.record || !frame.callInputRef || !frame.callInputKey) return undefined
    const currentInput = await this.load(frame, this.preview)
    const latest = new Set<string>()
    let current: ReturnType<typeof observe> | undefined
    for (const intent of [...this.record.intents].reverse()) {
      if (intent.programRevision === this.preview.programRevision || intent.taskId.split(':').at(-1) !== frame.nodeId || !intent.callFrameId || latest.has(intent.taskId)) continue
      latest.add(intent.taskId)
      const source = await this.source(intent)
      if (source.outcome.state !== 'completed') {
        if (source.replayKey === currentInput.replayKey && source.outcome.providerDispatch !== 'not_attempted') throw new Error(workflowRetryCopy.unsafe)
        continue
      }
      if (source.key !== frame.callInputKey) continue
      if (!source.outcome.settled) throw new Error(copy.invalid)
      if (source.outcome.actualModelStatus !== 'observed' || (intent.requestedModel && source.outcome.actualModel !== intent.requestedModel)) continue
      const committed = await this.committed(intent, frame.callInputKey)
      // A mismatched call cannot consume an observation. Keep one fresh view
      // for the eligible candidates of this selection, never across calls.
      current ??= observe()
      if (!await reusableWorkflowAgentInputs(this.store, this.preview.workflowId, intent.attemptId, this.record.agentInputs?.[intent.attemptId], await current)) continue
      return committed
    }
    return undefined
  }
}
