import { createHash } from 'node:crypto'
import type { WorkflowAttemptOutcome, WorkflowBlock, WorkflowCollectionEntry, WorkflowCollectionReference, WorkflowControlFrame, WorkflowEvaluation, WorkflowExpression, WorkflowFrameReference, WorkflowLoopCheckpoint, WorkflowPlanPreview, WorkflowValue, WorkflowValueReference, WorkflowValueSchema } from '../shared/workflow'
import { workflowChildBlocks } from '../shared/workflow'
import { workflowExpressionCopy, workflowFrameCopy, workflowRecoveryCopy } from '../shared/constants/copy'
import { workflowCollectionFields, workflowExpressionReferences, workflowExpressionSteps } from './workflow-expressions'
import { evaluateWorkflowCollection } from './workflow-collection-expressions'
import { collectionDescriptor } from './workflow-collections'
import { workflowLoopStateTypes } from './workflow-program'
import { workflowFrameId } from './workflow-frames'
import { workflowPendingRetry, workflowRetryBoundary } from './workflow-retry'
import type { WorkflowExecutionOwnership, WorkflowStore, WorkflowStoreRecord } from './workflow-store'

export type WorkflowControlScope = {
  path: string[]
  bindings: Map<string, WorkflowEvaluation>
  blockedReason?: string
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** One control owner per Runner invocation; scopes share immutable value
 * references, never mutable variables or a second executable AST. */
export class WorkflowControl {
  readonly framed: boolean
  readonly root: WorkflowControlScope
  private readonly origins = new Map<string, WorkflowControlFrame[]>()
  constructor(private readonly store: WorkflowStore, private readonly preview: WorkflowPlanPreview,
    private readonly execution?: { record: WorkflowStoreRecord; previous: WorkflowExecutionOwnership['segments']; generationId?: string }) {
    const pending = [preview.program.body]
    let framed = false
    while (pending.length) {
      const block = pending.pop()!
      if (block.kind === 'bind' || block.kind === 'branch' || block.kind === 'map' || block.kind === 'collect' || block.kind === 'loop' || (block.kind === 'return' && block.ref.path !== undefined) || (block.kind === 'call' && block.inputRefs?.some(ref => ref.path !== undefined))) framed = true
      pending.push(...workflowChildBlocks(block))
    }
    this.framed = framed || execution !== undefined
    this.root = { path: this.framed ? ['revision:' + preview.programRevision] : [], bindings: new Map() }
  }
  child(parent: WorkflowControlScope, label: string): WorkflowControlScope {
    return { path: this.framed ? [...parent.path, label] : parent.path, bindings: new Map(parent.bindings) }
  }
  bind(scope: WorkflowControlScope, name: string, value: WorkflowEvaluation): void {
    if (scope.bindings.has(name)) throw new Error(workflowExpressionCopy.binding(name))
    scope.bindings.set(name, value)
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
    for (const [name, value] of additions) this.bind(parent, name, value)
  }
  async enter(block: WorkflowBlock, scope: WorkflowControlScope): Promise<WorkflowControlFrame | undefined> {
    if (!this.framed) return undefined
    const names = block.kind === 'loop' ? [...new Set([...Object.values(block.initial), ...Object.values(block.invariants)].flatMap(workflowExpressionReferences))] : block.kind === 'map' || block.kind === 'collect' ? workflowExpressionReferences(block.items) : block.kind === 'bind' ? workflowExpressionReferences(block.value) : block.kind === 'branch' ? workflowExpressionReferences(block.when)
      : block.kind === 'call' ? (block.inputRefs ?? []).map(ref => ref.nodeId) : block.kind === 'return' ? [block.ref.nodeId] : []
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
    const origin = origins[0]
    return this.store.saveFrame({ schemaVersion: 1, workflowId: this.preview.workflowId, programRevision: this.preview.programRevision,
      frameId, nodeId: block.blockId, scopePath: scope.path, inputKey, phase: 'entered',
      ...(this.execution ? { executionEpoch: this.execution.record.execution!.epoch } : {}), ...(this.execution?.generationId ? { generationId: this.execution.generationId } : {}),
      ...(origin ? { origin: { frameId: origin.frameId, revision: origin.revision } } : {}) }, 0)
  }
  async select(frame: WorkflowControlFrame | undefined, arm: 'then' | 'else' | 'unknown', decision: WorkflowEvaluation): Promise<WorkflowControlFrame> {
    if (!frame) throw new Error(workflowFrameCopy.invalid)
    const origin = this.origins.get(frame.frameId)?.find(prior => prior.arm !== undefined)
    if (origin?.arm !== undefined) {
      if (origin.arm !== arm || origin.decisionRef!.hash !== digest(decision)) throw new Error(workflowRecoveryCopy.frame)
      await this.store.loadValue(this.preview.workflowId, origin.decisionRef!)
    }
    const decisionRef = await this.store.saveValue(this.preview.workflowId, digest([frame.frameId, 'decision']), decision)
    const { revision, ...input } = frame
    return this.store.saveFrame({ ...input, phase: 'selected', arm, decisionRef }, revision)
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
        if (origin?.resultRef && block.kind === 'call') throw new Error(workflowRecoveryCopy.frame)
        reference = await this.store.saveValue(this.preview.workflowId, digest([frame.frameId, 'result']), value)
      }
      const { revision, ...input } = frame
      completed = await this.store.saveFrame({ ...input, phase, resultRef: reference, ...(reportPartial ? { continuation: 'report_partial' as const } : {}), ...(value.state === 'unknown' ? { reason: value.reason.slice(0, 4096) } : {}) }, revision)
    }
    // The artifact owns its direct input references. Descendants reference it,
    // rather than copying the whole transitive history into every checkpoint.
    const result = reference ? { ...value, derivedFrom: [`value:${reference.key}:${reference.hash}`] } : value
    this.bind(scope, block.blockId, result)
    return completed
  }
  recoveredOutcome(block: WorkflowBlock, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined): WorkflowAttemptOutcome | undefined {
    if (!this.execution?.previous.length) return undefined
    const taskId = this.preview.workflowId + ':' + workflowFrameId(block.blockId, scope.path) + ':' + block.blockId
    if (workflowPendingRetry(this.execution.record, taskId)) return undefined
    const intent = [...this.execution.record.intents].reverse().find(value => value.taskId === taskId)
    const outcome = [...this.execution.record.outcomes].reverse().find(value => value.taskId === taskId)
    if (!intent && !outcome) return undefined
    if (!frame || !this.origins.has(frame.frameId)) throw new Error(workflowRecoveryCopy.frame)
    if (!outcome || !outcome.settled || outcome.state === 'unknown') throw new Error(workflowRecoveryCopy.unknown)
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
    for (const reference of [...checkpoint.iterations, ...(checkpoint.bestRef ? [checkpoint.bestRef] : []), ...(checkpoint.outcomeRef ? [checkpoint.outcomeRef] : [])]) await this.store.loadValue(this.preview.workflowId, reference)
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
  async freezeSource(frame: WorkflowControlFrame, value: WorkflowEvaluation): Promise<WorkflowControlFrame> {
    const sourceRef = await this.store.saveValue(this.preview.workflowId, digest([frame.frameId, 'source']), value)
    const { revision, ...input } = frame
    return this.store.saveFrame({ ...input, sourceRef }, revision)
  }
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
  async saveCollectionValue(value: Extract<WorkflowEvaluation, { state: 'known' }>): Promise<WorkflowValueReference> {
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
  async advanceSequence(frame: WorkflowControlFrame | undefined, cursor: number, child: WorkflowFrameReference | undefined): Promise<WorkflowControlFrame | undefined> {
    if (!frame) return undefined
    if (!child || cursor !== (frame.cursor ?? 0) + 1) throw new Error(workflowFrameCopy.invalid)
    const { revision, ...input } = frame
    return this.store.saveFrame({ ...input, cursor, children: [...(frame.children ?? []), child] }, revision)
  }
  async readCommitted(reference: WorkflowFrameReference): Promise<WorkflowEvaluation> {
    const frame = await this.store.loadFrame(this.preview.workflowId, reference.frameId)
    if (!frame || frame.phase === 'entered' || frame.phase === 'selected' || frame.revision !== reference.revision || !frame.resultRef || frame.resultRef.key !== reference.resultRef.key || frame.resultRef.hash !== reference.resultRef.hash) throw new Error(workflowFrameCopy.identity)
    return this.store.loadValue(this.preview.workflowId, reference.resultRef)
  }
  async skip(block: WorkflowBlock, scope: WorkflowControlScope): Promise<void> {
    const frame = await this.enter(block, scope)
    if (!frame) throw new Error(workflowFrameCopy.invalid)
    const { revision, ...input } = frame
    await this.store.saveFrame({ ...input, phase: 'skipped_by_condition' }, revision)
  }
}
