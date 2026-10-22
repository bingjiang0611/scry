import { createHash } from 'node:crypto'
import type { WorkflowBlock, WorkflowCollectionEntry, WorkflowControlFrame, WorkflowEvaluation, WorkflowFrameReference, WorkflowLoopCheckpoint, WorkflowPlanPreview, WorkflowValue, WorkflowValueReference, WorkflowValueSchema } from '../shared/workflow'
import { workflowChildBlocks } from '../shared/workflow'
import { workflowExpressionCopy, workflowFrameCopy } from '../shared/constants/copy'
import { workflowExpressionReferences } from './workflow-expressions'
import { collectionDescriptor } from './workflow-collections'
import { workflowLoopStateTypes } from './workflow-program'
import { workflowFrameId } from './workflow-frames'
import type { WorkflowStore } from './workflow-store'

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
  constructor(private readonly store: WorkflowStore, private readonly preview: WorkflowPlanPreview) {
    const pending = [preview.program.body]
    let framed = false
    while (pending.length) {
      const block = pending.pop()!
      if (block.kind === 'bind' || block.kind === 'branch' || block.kind === 'map' || block.kind === 'collect' || block.kind === 'loop' || (block.kind === 'return' && block.ref.path !== undefined) || (block.kind === 'call' && block.inputRefs?.some(ref => ref.path !== undefined))) framed = true
      pending.push(...workflowChildBlocks(block))
    }
    this.framed = framed
    this.root = { path: framed ? ['revision:' + preview.programRevision] : [], bindings: new Map() }
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
    return this.store.saveFrame({ schemaVersion: 1, workflowId: this.preview.workflowId, programRevision: this.preview.programRevision,
      frameId: workflowFrameId(block.blockId, scope.path), nodeId: block.blockId, scopePath: scope.path,
      inputKey: digest({ revision: this.preview.programRevision, nodeId: block.blockId, scope: scope.path,
        sources: names.map(name => [name, scope.bindings.get(name)?.state, scope.bindings.get(name)?.derivedFrom]) }), phase: 'entered' }, 0)
  }
  async select(frame: WorkflowControlFrame | undefined, arm: 'then' | 'else' | 'unknown', decision: WorkflowEvaluation): Promise<WorkflowControlFrame> {
    if (!frame) throw new Error(workflowFrameCopy.invalid)
    const decisionRef = await this.store.saveValue(this.preview.workflowId, digest([frame.frameId, 'decision']), decision)
    const { revision, ...input } = frame
    return this.store.saveFrame({ ...input, phase: 'selected', arm, decisionRef }, revision)
  }
  async complete(block: WorkflowBlock, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined, value: WorkflowEvaluation, phase: WorkflowControlFrame['phase'], reportPartial = false): Promise<WorkflowControlFrame | undefined> {
    let completed
    let reference
    if (frame) {
      reference = await this.store.saveValue(this.preview.workflowId, digest([frame.frameId, 'result']), value)
      const { revision, ...input } = frame
      completed = await this.store.saveFrame({ ...input, phase, resultRef: reference, ...(reportPartial ? { continuation: 'report_partial' as const } : {}), ...(value.state === 'unknown' ? { reason: value.reason.slice(0, 4096) } : {}) }, revision)
    }
    // The artifact owns its direct input references. Descendants reference it,
    // rather than copying the whole transitive history into every checkpoint.
    const result = reference ? { ...value, derivedFrom: [`value:${reference.key}:${reference.hash}`] } : value
    this.bind(scope, block.blockId, result)
    return completed
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
  async freezeSource(frame: WorkflowControlFrame, value: WorkflowEvaluation): Promise<WorkflowControlFrame> {
    const sourceRef = await this.store.saveValue(this.preview.workflowId, digest([frame.frameId, 'source']), value)
    const { revision, ...input } = frame
    return this.store.saveFrame({ ...input, sourceRef }, revision)
  }
  async collection(frame: WorkflowControlFrame, entries: WorkflowCollectionEntry[], sealed: boolean): Promise<WorkflowEvaluation> {
    const collection = await this.store.saveCollection(this.preview.workflowId, digest([frame.frameId, 'entries']), entries, sealed)
    return { state: 'known', value: collectionDescriptor(collection), collection, derivedFrom: [`collection:${collection.reference.key}:${collection.reference.hash}`] }
  }
  async entries(value: Extract<WorkflowEvaluation, { state: 'known' }>): Promise<WorkflowCollectionEntry[]> {
    if (!value.collection || !value.collection.sealed) throw new Error(workflowFrameCopy.missing)
    return this.store.loadCollection(this.preview.workflowId, value.collection)
  }
  async entryValue(entry: WorkflowCollectionEntry): Promise<WorkflowEvaluation> {
    const value = entry.reference ? await this.readCommitted(entry.reference) : undefined
    const error = entry.error ?? (value?.state === 'unknown' ? value.reason : undefined)
    return { state: 'known', value: { key: entry.key, index: entry.index, state: entry.state, settled: entry.settled,
      ...(value?.state === 'known' ? { value: value.value } : {}), ...(error ? { error } : {})
    }, derivedFrom: entry.reference ? [`value:${entry.reference.resultRef.key}:${entry.reference.resultRef.hash}`] : [] }
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
