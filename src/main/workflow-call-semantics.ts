import { workflowOpaqueProvenance } from './workflow-opaque-provenance'
import { createHash } from 'node:crypto'
import type { WorkflowBlock, WorkflowEvaluation, WorkflowPlanPreview, WorkflowValue, WorkflowValueReference } from '../shared/workflow'
import { workflowChildBlocks } from '../shared/workflow'
import type { WorkflowCallContext } from '../shared/workflow-call'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { workflowField, workflowValueKey, workflowExpressionReferences } from './workflow-expressions'
import type { WorkflowStore } from './workflow-store'
import type { WorkflowControlScope } from './workflow-control'

export const workflowSemanticHash = (value: unknown): string => createHash('sha256').update(workflowValueKey(JSON.parse(JSON.stringify(value)) as WorkflowValue)).digest('hex')
export const workflowCallInputKey = (frameId: string) => workflowSemanticHash([frameId, 'call-input'])
const revisionNodes = new WeakMap<WorkflowPlanPreview['program'], Map<string, WorkflowBlock>>()
export function workflowRevisionBlocks(preview: WorkflowPlanPreview): Map<string, WorkflowBlock> {
  const cached = revisionNodes.get(preview.program)
  if (cached && Object.isFrozen(preview.program)) return cached
  const nodes = new Map<string, WorkflowBlock>(), pending = [preview.program.body]
  while (pending.length) { const block = pending.pop()!; nodes.set(block.blockId, block); pending.push(...workflowChildBlocks(block)) }
  if (Object.isFrozen(preview.program)) revisionNodes.set(preview.program, nodes)
  return nodes
}
export function workflowHasDynamicRevision(preview: WorkflowPlanPreview): boolean {
  return [...workflowRevisionBlocks(preview).values()].some(block => ['branch', 'map', 'loop', 'collect'].includes(block.kind))
}
export function assertWorkflowRevisionEffects(preview: WorkflowPlanPreview): void {
  for (const block of workflowRevisionBlocks(preview).values()) if (block.kind === 'replica' || block.kind === 'check' || block.kind === 'verification' || (block.kind === 'call' && block.replica)) throw new Error(copy.unsupported)
}

/** Strip only physical artifact names. Collection authority is resolved through
 * sealed main manifests and committed frames, never from descriptor JSON. */
export async function workflowSemanticValue(store: WorkflowStore, workflowId: string, evaluation: WorkflowEvaluation, depth = 0): Promise<WorkflowValue> {
  if (depth > 64 || (evaluation.state === 'known' && evaluation.replica)) throw new Error(copy.invalid)
  if (evaluation.state === 'unknown') return { state: 'unknown', reason: evaluation.reason }
  const collection = async (reference: NonNullable<Extract<WorkflowEvaluation, { state: 'known' }>['collection']>): Promise<WorkflowValue> => {
    if (!reference.sealed) throw new Error(copy.invalid)
    const entries = await store.loadCollection(workflowId, reference)
    const normalized: WorkflowValue[] = []
    for (const entry of entries) {
      if (!entry.settled || entry.state === 'unknown' || entry.state === 'pending') throw new Error(copy.invalid)
      let value: WorkflowValue = null, semantic: WorkflowValue = null
      if (entry.reference) {
        const frame = await store.loadFrame(workflowId, entry.reference.frameId)
        if (!frame || frame.revision !== entry.reference.revision || JSON.stringify(frame.resultRef) !== JSON.stringify(entry.reference.resultRef) || !['completed', 'failed', 'blocked', 'stopped'].includes(frame.phase)) throw new Error(copy.invalid)
        value = await workflowSemanticValue(store, workflowId, await store.loadValue(workflowId, entry.reference.resultRef), depth + 1)
        semantic = frame.resultSemanticKey ?? { legacyFrame: frame.frameId, revision: frame.revision }
      } else if (entry.valueRef) {
        const member = await store.loadValue(workflowId, entry.valueRef)
        value = await workflowSemanticValue(store, workflowId, member, depth + 1)
        semantic = await workflowOpaqueProvenance(store, workflowId, member)
      }
      else throw new Error(copy.invalid)
      normalized.push({ key: entry.key, state: entry.state, settled: entry.settled, value, semantic, ...(entry.error ? { error: entry.error } : {}) })
    }
    return normalized
  }
  if (evaluation.collection) return { state: 'known', collection: await collection(evaluation.collection) }
  let value = structuredClone(evaluation.value)
  for (const field of evaluation.collectionFields ?? []) {
    // Descriptor positions are validated on store reads; a literal with the
    // same JSON cannot acquire any entry's authority here.
    let parent: WorkflowValue = value
    for (const part of field.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object') throw new Error(copy.invalid)
      parent = Array.isArray(parent) ? parent[Number(part)] : parent[part]
    }
    if (!parent || typeof parent !== 'object') throw new Error(copy.invalid)
    const replacement = { semanticCollection: await collection(field.collection) }
    if (Array.isArray(parent)) parent[Number(field.path.at(-1)!)] = replacement
    else parent[field.path.at(-1)!] = replacement
  }
  return { state: 'known', value }
}

export interface WorkflowCallInputs {
  version: 1
  programRevision: string
  nodeId: string
  scopePath: string[]
  inputKey: string
  definition: string
  inputs: Array<{ nodeId: string; path: string[]; dependency: string | null } & (
    | { valueRef: WorkflowValueReference; bindingRef?: never }
    | { bindingRef: WorkflowValueReference; valueRef?: never }
  )>
  contexts: WorkflowCallContext[]
}
export function workflowCallDefinition(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>): string {
  return workflowSemanticHash({ block, role: preview.program.roles.find(role => role.role === block.role), workspace: preview.workspace, goal: preview.userGoal })
}

/** Reuse the already committed binding fact, not a second selected-value file.
 * Matching bytes alone cannot choose an ancestor: map aliases must name the
 * actual lexical item, and other candidates come from this binding's own refs. */
async function committedBinding(store: WorkflowStore, preview: WorkflowPlanPreview, scope: WorkflowControlScope, name: string, binding: WorkflowEvaluation): Promise<WorkflowValueReference | undefined> {
  const candidates: Array<{ reference: WorkflowValueReference; exact: boolean }> = []
  const item = [...(scope.callContexts ?? [])].reverse().find(context => {
    const block = workflowRevisionBlocks(preview).get(context.blockId)
    return context.kind === 'map' && block?.kind === 'map' && block.item === name
  })
  if (item?.kind === 'map') candidates.push({ reference: item.itemRef, exact: true })
  for (const source of binding.derivedFrom) {
    const match = /^value:([A-Za-z0-9_-]{1,96}):([a-f0-9]{64})$/.exec(source)
    if (match) candidates.push({ reference: { workflowId: preview.workflowId, key: match[1], hash: match[2] }, exact: false })
  }
  const { derivedFrom: _sources, ...expected } = binding
  for (const { reference, exact } of candidates) {
    const value = await store.loadValue(preview.workflowId, reference)
    const { derivedFrom: _original, ...actual } = value
    if (exact ? JSON.stringify(value) === JSON.stringify(binding) : JSON.stringify(actual) === JSON.stringify(expected)) return reference
  }
  return undefined
}

export async function createWorkflowCallInputs(store: WorkflowStore, preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>, scope: WorkflowControlScope, inputKey: string): Promise<WorkflowCallInputs> {
  const inputs: WorkflowCallInputs['inputs'] = []
  for (const ref of block.inputRefs ?? []) {
    const binding = scope.bindings.get(ref.nodeId) ?? { state: 'unknown' as const, reason: copy.invalid, derivedFrom: [] }
    const selected = binding.state === 'known' && ref.path?.length ? workflowField(binding.value, ref.path, binding.derivedFrom, binding) : binding
    const fieldKey = JSON.stringify(ref.path ?? [])
    const bindingRef = await committedBinding(store, preview, scope, ref.nodeId, binding)
    inputs.push({ nodeId: ref.nodeId, path: ref.path ?? [], ...(bindingRef ? { bindingRef }
      : { valueRef: await store.saveValue(preview.workflowId, 'call_binding', selected) }),
      dependency: scope.semanticFields?.get(ref.nodeId)?.get(fieldKey) ?? scope.semanticBindings?.get(ref.nodeId) ?? null })
  }
  return { version: 1, programRevision: preview.programRevision, nodeId: block.blockId, scopePath: scope.path, inputKey,
    definition: workflowCallDefinition(preview, block), inputs, contexts: scope.callContexts ?? [] }
}

/** Producer identities use effective data and local definitions, not new frame
 * keys, whole-revision hashes or unrelated sibling bodies. */
export async function workflowBindingSemantic(store: WorkflowStore, preview: WorkflowPlanPreview, block: WorkflowBlock, scope: WorkflowControlScope, value: WorkflowEvaluation, callInputKey?: string): Promise<string> {
  const local = { ...block } as Record<string, unknown>
  for (const name of ['blocks', 'body', 'then', 'else', 'unknown', 'initial', 'carry']) delete local[name]
  const refs = block.kind === 'bind' ? workflowExpressionReferences(block.value) : block.kind === 'return' ? [block.ref.nodeId] : block.kind === 'collect' ? workflowExpressionReferences(block.items) : []
  const dependencies = block.kind === 'bind' ? workflowExpressionDependencies(block.value, scope) : refs.map(name => [name, scope.semanticBindings?.get(name) ?? null])
  dependencies.push(...(scope.semanticChildren?.get(block.blockId) ?? []).map((value, index) => [String(index), value]))
  if (block.kind === 'sequence') dependencies.push(...block.blocks.map(child => [child.blockId, scope.semanticBindings?.get(child.blockId) ?? null]))
  if (block.kind === 'parallel') dependencies.push(...block.blocks.map(child => [child.blockId, scope.semanticBindings?.get(child.blockId) ?? null]))
  return workflowSemanticHash({ local, dependencies, ...(callInputKey ? { callInputKey } : {}), ...(block.kind === 'call' ? { attempt: value.derivedFrom } : {}), value: await workflowSemanticValue(store, preview.workflowId, value) })
}

export function workflowExpressionSource(expression: import('../shared/workflow').WorkflowExpression, scope: WorkflowControlScope): string {
  const local = expression.kind === 'literal' ? { kind: 'literal' } : expression
  return workflowSemanticHash({ local, definitions: workflowExpressionReferences(expression).map(name => [name, scope.semanticDefinitions?.get(name) ?? null]) })
}
export async function workflowExpressionSemantic(store: WorkflowStore, preview: WorkflowPlanPreview, expression: import('../shared/workflow').WorkflowExpression, scope: WorkflowControlScope, value: WorkflowEvaluation): Promise<string> {
  return workflowSemanticHash({ expression, dependencies: workflowExpressionDependencies(expression, scope), value: await workflowSemanticValue(store, preview.workflowId, value) })
}
export function workflowProducerDefinition(preview: WorkflowPlanPreview, block: WorkflowBlock, scope: WorkflowControlScope, value: WorkflowEvaluation, sourceSemanticKey?: string): string {
  if (block.kind === 'call') return workflowSemanticHash({ definition: workflowCallDefinition(preview, block), attempt: value.derivedFrom })
  const local = { ...block } as Record<string, unknown>
  for (const key of ['blocks', 'body', 'then', 'else', 'unknown']) delete local[key]
  if (block.kind === 'bind' && block.value.kind === 'literal') local.value = { kind: 'literal' }
  const refs = block.kind === 'bind' ? workflowExpressionReferences(block.value) : block.kind === 'return' ? [block.ref.nodeId] : []
  return workflowSemanticHash({ local, definitions: refs.map(name => [name, scope.semanticDefinitions?.get(name) ?? null]), children: scope.semanticChildren?.get(block.blockId) ?? [], ...(sourceSemanticKey ? { sourceSemanticKey } : {}) })
}

export function workflowExpressionDependencies(expression: import('../shared/workflow').WorkflowExpression, scope: WorkflowControlScope) {
  let source = expression
  let path: string[] = []
  while (source.kind === 'field') { path = [...source.path, ...path]; source = source.source }
  const selected = source.kind === 'ref' && path.length ? { name: source.name, path } : undefined
  return workflowExpressionReferences(expression).map(name => [name, selected?.name === name ? scope.semanticFields?.get(name)?.get(JSON.stringify(selected.path)) ?? scope.semanticBindings?.get(name) ?? null : scope.semanticBindings?.get(name) ?? null])
}
