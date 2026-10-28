import type { WorkflowCallContext } from '../shared/workflow-call'
import type { WorkflowAdmissionFence } from './workflow-parallel-policy'
import { WorkflowCallReuse } from './workflow-call-reuse'
import type { WorkflowVerification } from './workflow-verification'
import type { WorkflowProvenanceContext } from './workflow-opaque-provenance'
import { workflowBindingSemantic, workflowExpressionSource, workflowExpressionSemantic, workflowProducerDefinition, workflowSemanticHash, workflowCallDefinition } from './workflow-call-semantics'
import { WorkflowControlRecovery } from './workflow-control-recovery'
import { createHash } from 'node:crypto'
import type { WorkflowAttemptOutcome, WorkflowBlock, WorkflowControlFrame, WorkflowEvaluation, WorkflowExpression, WorkflowFrameReference, WorkflowPlanPreview } from '../shared/workflow'
import { workflowChildBlocks } from '../shared/workflow'
import { workflowExpressionCopy, workflowFrameCopy, workflowRecoveryCopy } from '../shared/constants/copy'
import { workflowExpressionReferences } from './workflow-expressions'

import { workflowFrameId, workflowSequenceProgress } from './workflow-frames'
import { workflowPendingRetry, workflowRetryBoundary } from './workflow-retry'
import type { WorkflowExecutionOwnership, WorkflowStore, WorkflowStoreRecord } from './workflow-store'

export type WorkflowControlScope = {
  path: string[]
  /** Structural frame context for the next block in this scope. */
  parentFrameId?: string | null
  admission?: WorkflowAdmissionFence
  bindings: Map<string, WorkflowEvaluation>
  blockedReason?: string
  legacyInputs?: boolean
  semanticChildren?: Map<string, string[]>
  callContexts?: WorkflowCallContext[]
  semanticDefinitions?: Map<string, string>
  semanticBindings?: Map<string, string>
  semanticFields?: Map<string, Map<string, string>>
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** One control owner per Runner invocation; scopes share immutable value
 * references, never mutable variables or a second executable AST. */
export class WorkflowControl extends WorkflowControlRecovery {
  readonly framed: boolean
  readonly root: WorkflowControlScope
  private readonly callReuse: WorkflowCallReuse
  private readonly provenance: WorkflowProvenanceContext
  constructor(store: WorkflowStore, preview: WorkflowPlanPreview,
    execution?: { record: WorkflowStoreRecord; previous: WorkflowExecutionOwnership['segments']; generationId?: string }, verification?: WorkflowVerification) {
    super(store, preview, execution)
    this.provenance = { record: execution?.record, verification }
    this.callReuse = new WorkflowCallReuse(store, preview, execution?.record, verification)
    const pending = [preview.program.body]
    let framed = false
    while (pending.length) {
      const block = pending.pop()!
      if (block.kind === 'replica' || block.kind === 'combine' || block.kind === 'check' || block.kind === 'verification' || block.kind === 'bind' || block.kind === 'branch' || block.kind === 'map' || block.kind === 'collect' || block.kind === 'loop' || (block.kind === 'return' && block.ref.path !== undefined) || (block.kind === 'call' && (block.replica || block.inputRefs?.some(ref => ref.path !== undefined)))) framed = true
      pending.push(...workflowChildBlocks(block))
    }
    this.framed = framed || execution !== undefined
    this.root = { path: this.framed ? ['revision:' + preview.programRevision] : [], parentFrameId: this.framed ? null : undefined, bindings: new Map(), callContexts: [], semanticBindings: new Map(), semanticFields: new Map() }
  }
  /** Dynamic child scopes receive isolated binding maps. */
  child(parent: WorkflowControlScope, label: string, parentFrame?: WorkflowControlFrame): WorkflowControlScope {
    const parentFrameId = parentFrame?.frameId ?? parent.parentFrameId
    return {
      path: this.framed ? [...parent.path, label] : parent.path,
      ...(parentFrameId === undefined ? {} : { parentFrameId }),
      ...(parent.admission ? { admission: parent.admission } : {}),
      bindings: new Map(parent.bindings), legacyInputs: parent.legacyInputs,
      semanticChildren: new Map(parent.semanticChildren), callContexts: [...(parent.callContexts ?? [])],
      semanticDefinitions: new Map(parent.semanticDefinitions), semanticBindings: new Map(parent.semanticBindings),
      semanticFields: new Map(parent.semanticFields)
    }
  }
  bind(scope: WorkflowControlScope, name: string, value: WorkflowEvaluation, semantic?: string): void {
    if (scope.bindings.has(name)) throw new Error(workflowExpressionCopy.binding(name))
    scope.bindings.set(name, value)
    if (semantic) (scope.semanticBindings ??= new Map()).set(name, semantic)
  }
  join(parent: WorkflowControlScope, children: WorkflowControlScope[]): void {
    const inherited = new Set(parent.bindings.keys())
    const additions = new Map<string, WorkflowEvaluation>()
    for (const child of children) {
      parent.blockedReason ??= child.blockedReason
      for (const [name, value] of child.bindings) if (!inherited.has(name)) {
        if (additions.has(name)) throw new Error(workflowExpressionCopy.binding(name))
        additions.set(name, value)
      }
    }
    for (const [name, value] of additions) {
      const child = children.find(scope => scope.bindings.has(name) && !inherited.has(name))!
      this.bind(parent, name, value, child.semanticBindings?.get(name))
      const definition = child.semanticDefinitions?.get(name)
      if (definition) (parent.semanticDefinitions ??= new Map()).set(name, definition)
      const fields = child.semanticFields?.get(name)
      if (fields) (parent.semanticFields ??= new Map()).set(name, fields)
    }
  }
  async enter(block: WorkflowBlock, scope: WorkflowControlScope, captureCall = true, parentFrameId = scope.parentFrameId): Promise<WorkflowControlFrame | undefined> {
    if (!this.framed) return undefined
    const names = block.kind === 'loop' ? [...new Set([...Object.values(block.initial), ...Object.values(block.invariants)].flatMap(workflowExpressionReferences))] : block.kind === 'map' || block.kind === 'collect' ? workflowExpressionReferences(block.items) : block.kind === 'bind' ? workflowExpressionReferences(block.value) : block.kind === 'branch' ? workflowExpressionReferences(block.when)
      : block.kind === 'verification' ? [...Object.values(block.required).flatMap(entry => workflowExpressionReferences(entry.result)), ...(block.baseline ? workflowExpressionReferences(block.baseline) : [])]
      : block.kind === 'check' ? workflowExpressionReferences(block.replica) : block.kind === 'combine' ? [...workflowExpressionReferences(block.base), ...workflowExpressionReferences(block.candidates)] : block.kind === 'replica' ? block.source ? workflowExpressionReferences(block.source) : [] : block.kind === 'call' ? [...(block.inputRefs ?? []).map(ref => ref.nodeId), ...(block.replica ? workflowExpressionReferences(block.replica) : [])] : block.kind === 'return' ? [block.ref.nodeId] : []
    const inputKey = digest({ revision: this.preview.programRevision, nodeId: block.blockId, scope: scope.path,
      sources: names.map(name => [name, scope.bindings.get(name)?.state, scope.bindings.get(name)?.derivedFrom]) })
    const frameId = workflowFrameId(block.blockId, scope.path, this.execution?.generationId)
    const origins: WorkflowControlFrame[] = []
    const taskId = this.preview.workflowId + ':' + workflowFrameId(block.blockId, scope.path) + ':' + block.blockId
    const boundary = block.kind === 'call' && this.execution ? workflowRetryBoundary(this.execution.record, taskId) : 0
    for (const segment of [...(this.execution?.previous.slice(boundary) ?? [])].reverse()) {
      const prior = await this.store.loadFrame(this.preview.workflowId, workflowFrameId(block.blockId, scope.path, segment.generationId))
      if (!prior) continue
      if (prior.executionEpoch !== segment.id || prior.inputKey !== inputKey || prior.programRevision !== this.preview.programRevision) throw new Error(workflowRecoveryCopy.frame)
      origins.push(prior)
    }
    if (origins.length) this.origins.set(frameId, origins)
    const reuse = block.kind === 'call' ? this.execution?.record.revisions?.at(-1)?.reuse.find(entry => entry.nodeId === block.blockId) : undefined
    if (reuse) {
      const prior = await this.store.loadFrame(this.preview.workflowId, reuse.reference.frameId)
      if (!prior || prior.phase !== 'completed' || prior.revision !== reuse.reference.revision || JSON.stringify(prior.resultRef) !== JSON.stringify(reuse.reference.resultRef)) throw new Error(workflowRecoveryCopy.frame)
      await this.store.loadValue(this.preview.workflowId, reuse.reference.resultRef)
      // Cross-revision reuse preserves the old immutable result authority. It
      // does not rewrite old inputKey/scopePath into the new revision.
      origins.push(prior)
      this.origins.set(frameId, origins)
    }
    const origin = origins[0]
    const input: Omit<WorkflowControlFrame, 'revision'> = { schemaVersion: 1, workflowId: this.preview.workflowId, programRevision: this.preview.programRevision,
      frameId, nodeId: block.blockId, scopePath: scope.path, ...(parentFrameId === undefined ? {} : { parentFrameId }), inputKey, phase: 'entered',
      ...(this.execution ? { executionEpoch: this.execution.record.execution!.epoch } : {}), ...(this.execution?.generationId ? { generationId: this.execution.generationId } : {}),
      ...(origin ? { origin: { frameId: origin.frameId, revision: origin.revision } } : {}) }
    if (captureCall && !scope.legacyInputs && block.kind === 'call' && !block.replica) {
      Object.assign(input, await this.callReuse.inputs(block, scope, input))
      for (const prior of origins) if (prior.programRevision === input.programRevision && prior.callInputKey && prior.callInputKey !== input.callInputKey) throw new Error(workflowRecoveryCopy.frame)
      const selection = origins.find(prior => prior.callReuse)?.callReuse
      if (selection) input.callReuse = selection
    }
    return this.store.saveFrame(input, 0)
  }
  async select(frame: WorkflowControlFrame | undefined, arm: 'then' | 'else' | 'unknown', decision: WorkflowEvaluation, decisionSemanticKey?: string): Promise<WorkflowControlFrame> {
    if (!frame) throw new Error(workflowFrameCopy.invalid)
    const origin = this.origins.get(frame.frameId)?.find(prior => prior.arm !== undefined)
    if (origin?.arm !== undefined) {
      if (origin.arm !== arm || origin.decisionRef!.hash !== digest(decision)) throw new Error(workflowRecoveryCopy.frame)
      await this.store.loadValue(this.preview.workflowId, origin.decisionRef!)
    }
    const decisionRef = await this.store.saveValue(this.preview.workflowId, digest([frame.frameId, 'decision']), decision)
    const { revision, ...input } = frame
    return this.store.saveFrame({ ...input, phase: 'selected', arm, decisionRef, ...(decisionSemanticKey ? { decisionSemanticKey } : {}) }, revision)
  }
  async complete(block: WorkflowBlock, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined, value: WorkflowEvaluation, phase: WorkflowControlFrame['phase'], reportPartial = false): Promise<WorkflowControlFrame | undefined> {
    let completed
    let reference
    if (frame) {
      const origin = this.origins.get(frame.frameId)?.find(prior => prior.resultRef !== undefined)
      if (origin?.resultRef && origin.resultRef.hash === digest(value)) {
        await this.store.loadValue(this.preview.workflowId, origin.resultRef)
        reference = origin.resultRef
      } else {
        if (origin?.resultRef && (block.kind === 'call' || block.kind === 'check' || block.kind === 'replica' || block.kind === 'combine' || block.kind === 'verification')) throw new Error(workflowRecoveryCopy.frame)
      }
      if (!reference && this.execution && phase === 'completed' && (block.kind === 'replica' || block.kind === 'combine' || block.kind === 'check' || block.kind === 'verification')) {
        const record = this.execution.record, taskId = this.preview.workflowId + ':' + workflowFrameId(block.blockId, scope.path) + ':' + block.blockId
        const intent = record.systemIntents?.findLast(item => item.taskId === taskId && item.programRevision === frame.programRevision)
        const outcome = record.systemOutcomes?.find(item => item.stepId === intent?.stepId)
        if (!intent || intent.nodeId !== block.blockId || intent.kind !== (block.kind === 'replica' ? 'prepare_replica' : block.kind) || outcome?.taskId !== taskId || outcome.state !== 'completed' || !outcome.resultRef || outcome.resultRef.key !== intent.stepId) throw new Error(workflowRecoveryCopy.frame)
        // The effect already durably committed this main-issued result. Publish
        // its exact reference under normal frame CAS/directory synchronization;
        // do not write a second copy or promote its separate settlement status.
        const canonical = await this.store.loadValue(this.preview.workflowId, outcome.resultRef)
        if (digest(canonical) !== digest(value)) throw new Error(workflowRecoveryCopy.frame)
        reference = outcome.resultRef
      }
      const { revision, ...input } = frame
      const resultSemanticKey = phase === 'completed' ? await workflowBindingSemantic(this.store, this.preview, block, scope, value, frame.callInputKey, this.provenance) : undefined
      const nextInput = { ...input, phase, ...(reference ? { resultRef: reference } : {}), ...(resultSemanticKey ? { resultSemanticKey } : {}), ...(reportPartial ? { continuation: 'report_partial' as const } : {}), ...(value.state === 'unknown' ? { reason: value.reason.slice(0, 4096) } : {}) }
      completed = reference
        ? await this.store.saveFrame(nextInput, revision)
        : await this.store.saveFrameWithValue(nextInput, revision, { field: 'resultRef', key: digest([frame.frameId, 'result']), evaluation: value })
      reference = completed.resultRef
      if (!reference) throw new Error(workflowRecoveryCopy.frame)
    }
    // The artifact owns its direct input references. Descendants reference it,
    // rather than copying the whole transitive history into every checkpoint.
    const result = reference ? { ...value, derivedFrom: [`value:${reference.key}:${reference.hash}`] } : value
    this.bind(scope, block.blockId, result, block.kind === 'call' && frame?.callInputKey ? workflowSemanticHash({ definition: workflowCallDefinition(this.preview, block), inputs: frame.callInputKey, attempt: value.derivedFrom }) : completed?.resultSemanticKey)
    ;(scope.semanticDefinitions ??= new Map()).set(block.blockId, workflowProducerDefinition(this.preview, block, scope, value, frame?.sourceSemanticKey))
    if (block.kind === 'parallel') {
      const fields = new Map<string, string>()
      for (const child of block.blocks) {
        const semantic = scope.semanticBindings?.get(child.blockId)
        if (semantic) fields.set(JSON.stringify([child.blockId]), semantic)
      }
      ;(scope.semanticFields ??= new Map()).set(block.blockId, fields)
    }
    return completed
  }
  expressionSource(expression: WorkflowExpression, scope: WorkflowControlScope) { return workflowExpressionSource(expression, scope) }
  expressionSemantic(expression: WorkflowExpression, scope: WorkflowControlScope, value: WorkflowEvaluation) { return workflowExpressionSemantic(this.store, this.preview, expression, scope, value, this.provenance) }
  async selectedCall(frame: WorkflowControlFrame): Promise<WorkflowAttemptOutcome | undefined> {
    const outcome = await this.callReuse.validateSelection(frame)
    if (frame.callReuse) {
      const source = await this.store.loadFrame(this.preview.workflowId, frame.callReuse.reference.frameId)
      if (!source) throw new Error(workflowRecoveryCopy.frame)
      const origins = this.origins.get(frame.frameId) ?? []
      if (!origins.some(prior => prior.frameId === source.frameId)) this.origins.set(frame.frameId, [...origins, source])
    }
    return outcome
  }
  async selectCall(frame: WorkflowControlFrame, observe: () => Promise<import('./workflow-agent-inputs').WorkflowAgentInputObservation | undefined>): Promise<WorkflowAttemptOutcome | undefined> {
    if (frame.callReuse) return this.selectedCall(frame)
    const selection = await this.callReuse.select(frame, observe)
    if (!selection) return undefined
    const { revision, ...input } = frame
    const selected = await this.store.saveFrame({ ...input, callReuse: selection }, revision)
    Object.assign(frame, selected)
    const source = await this.store.loadFrame(this.preview.workflowId, selection.reference.frameId)
    if (!source) throw new Error(workflowRecoveryCopy.frame)
    this.origins.set(frame.frameId, [...(this.origins.get(frame.frameId) ?? []), source])
    return this.selectedCall(frame)
  }
  recoveredOutcome(block: WorkflowBlock, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined): WorkflowAttemptOutcome | undefined {
    if (!this.execution?.previous.length) return undefined
    const taskId = this.preview.workflowId + ':' + workflowFrameId(block.blockId, scope.path) + ':' + block.blockId
    if (workflowPendingRetry(this.execution.record, taskId)) return undefined
    const reuse = this.execution.record.revisions?.at(-1)?.reuse.find(entry => entry.nodeId === block.blockId)
    const intent = [...this.execution.record.intents].reverse().find(value => value.taskId === taskId)
    const outcome = [...this.execution.record.outcomes].reverse().find(value => value.taskId === taskId) ?? (reuse ? this.execution.record.outcomes.find(value => value.attemptId === reuse.attemptId) : undefined)
    if (!intent && !outcome) return undefined
    if (!frame || !this.origins.has(frame.frameId)) throw new Error(workflowRecoveryCopy.frame)
    if (!outcome || !outcome.settled || outcome.state === 'unknown') throw new Error(workflowRecoveryCopy.unknown)
    return outcome
  }
  async freezeSource(frame: WorkflowControlFrame, value: WorkflowEvaluation, sourceSemanticKey?: string): Promise<WorkflowControlFrame> {
    const { revision, ...input } = frame
    return this.store.saveFrameWithValue({ ...input, ...(sourceSemanticKey ? { sourceSemanticKey } : {}) }, revision,
      { field: 'sourceRef', key: digest([frame.frameId, 'source']), evaluation: value })
  }
  async advanceSequence(frame: WorkflowControlFrame | undefined, cursor: number, child: WorkflowFrameReference | undefined): Promise<WorkflowControlFrame | undefined> {
    const next = workflowSequenceProgress(frame, cursor, child)
    if (!next) return undefined
    const { revision, ...input } = next
    return this.store.saveFrame(input, revision)
  }
  async skip(block: WorkflowBlock, scope: WorkflowControlScope): Promise<void> {
    const frame = await this.enter(block, scope, false)
    if (!frame) throw new Error(workflowFrameCopy.invalid)
    const { revision, ...input } = frame
    await this.store.saveFrame({ ...input, phase: 'skipped_by_condition' }, revision)
  }
}
