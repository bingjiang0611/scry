import { workflowOpaqueProvenance } from './workflow-opaque-provenance'
import type { WorkflowBlock, WorkflowEvaluation, WorkflowPlanPreview, WorkflowValue } from '../shared/workflow'
import type { WorkflowCallContext } from '../shared/workflow-call'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import { workflowCollectionFields, workflowField, workflowValueKey } from './workflow-expressions'
import { workflowRevisionBlocks, workflowSemanticHash, workflowSemanticValue } from './workflow-call-semantics'

/** Validate historical control evidence, then normalize only its effective
 * context. No sibling AST, physical ref names or map array positions enter it. */
export async function workflowCallContextIdentity(store: WorkflowStore, preview: WorkflowPlanPreview, contexts: WorkflowCallContext[], scopePath: string[], record?: WorkflowStoreRecord): Promise<WorkflowValue[]> {
  if (!Array.isArray(contexts) || contexts.length > 64) throw new Error(copy.invalid)
  const blocks = workflowRevisionBlocks(preview), result: WorkflowValue[] = []
  for (const context of contexts) {
    const block = blocks.get(context.blockId), frame = await store.loadFrame(preview.workflowId, context.frameId)
    if (!block || !frame || frame.nodeId !== context.blockId || frame.programRevision !== preview.programRevision || frame.scopePath.some((part, index) => scopePath[index] !== part) || scopePath.length <= frame.scopePath.length) throw new Error(copy.invalid)
    if (context.kind === 'branch') {
      if (block.kind !== 'branch' || frame.arm !== context.arm || JSON.stringify(frame.decisionRef) !== JSON.stringify(context.decisionRef)) throw new Error(copy.invalid)
      const decision = await store.loadValue(preview.workflowId, context.decisionRef)
      result.push({ kind: 'branch', blockId: block.blockId, when: JSON.parse(JSON.stringify(block.when)) as WorkflowValue, decisionSemantic: frame.decisionSemanticKey ?? null, arm: context.arm,
        decision: await workflowSemanticValue(store, preview.workflowId, decision) })
    } else if (context.kind === 'map') {
      if (block.kind !== 'map' || !frame.sourceRef) throw new Error(copy.invalid)
      const source = await store.loadValue(preview.workflowId, frame.sourceRef), input = await store.loadValue(preview.workflowId, context.itemRef)
      if (source.state !== 'known' || input.state !== 'known') throw new Error(copy.invalid)
      let expected: WorkflowEvaluation
      let producer: WorkflowValue = null
      if (context.collection) {
        if (!source.collection?.sealed) throw new Error(copy.invalid)
        const entries = await store.loadCollection(preview.workflowId, source.collection)
        const entry = entries.find(value => workflowValueKey(value.key) === workflowValueKey(context.key))
        if (!entry || !entry.settled || !entry.reference && !entry.valueRef) throw new Error(copy.invalid)
        // Entry wrapper is issued by the canonical collection owner. Its index
        // is an effective input only if the call actually consumes that field.
        const value = await store.loadValue(preview.workflowId, entry.reference?.resultRef ?? entry.valueRef!)
        if (entry.reference) {
          const child = await store.loadFrame(preview.workflowId, entry.reference.frameId)
          if (!child || child.revision !== entry.reference.revision || JSON.stringify(child.resultRef) !== JSON.stringify(entry.reference.resultRef)) throw new Error(copy.invalid)
          // Nested controlled outputs are inputs only when actually selected.
          // Their main map keys retain upstream key-source provenance below.
          producer = value.state === 'known' && (value.collection || value.collectionFields?.length) ? null : await workflowOpaqueProvenance(store, preview.workflowId, value, record)
        }
        if (!entry.reference && entry.valueRef) producer = await workflowOpaqueProvenance(store, preview.workflowId, value, record)
        const fields = workflowCollectionFields(value, ['value'])
        expected = { state: 'known' as const, value: { key: entry.key, index: entry.index, state: entry.state, settled: entry.settled,
          ...(value.state === 'known' ? { value: value.value } : {}), ...(entry.error || value.state === 'unknown' ? { error: entry.error ?? (value.state === 'unknown' ? value.reason : '') } : {}) }, derivedFrom: [], ...(fields.length ? { collectionFields: fields } : {}) }
      } else {
        if (!Array.isArray(source.value)) throw new Error(copy.invalid)
        const index = source.value.findIndex(value => {
          const key = workflowField(value, block.key)
          return key.state === 'known' && workflowValueKey(key.value) === workflowValueKey(context.key)
        })
        if (index < 0) throw new Error(copy.invalid)
        expected = workflowField(source.value, [String(index)], source.derivedFrom, source)
        // Group/unique items carry their own member manifests. Key-only
        // consumers retain those opaque member origins, not unrelated groups
        // reachable through the aggregate's outer derivedFrom reference.
        if (input.collectionFields?.length) producer = await workflowOpaqueProvenance(store, preview.workflowId, { ...input, derivedFrom: [] }, record)
      }
      if (workflowSemanticHash(await workflowSemanticValue(store, preview.workflowId, expected)) !== workflowSemanticHash(await workflowSemanticValue(store, preview.workflowId, input))) throw new Error(copy.invalid)
      result.push({ kind: 'map', blockId: block.blockId, item: block.item, keyPath: block.key, sourceDefinition: frame.sourceSemanticKey ?? null, key: context.key, producer })
    } else if (context.kind === 'loop') {
      if (block.kind !== 'loop' || !frame.loop || !Number.isSafeInteger(context.iteration) || context.iteration < 1 || context.iteration > block.maxIterations || frame.loop.iteration < context.iteration) throw new Error(copy.invalid)
      let expected = frame.loop.initialStateRefs
      let semanticStateRef = frame.loop.initialSemanticStateRef
      if (context.iteration > 1) {
        const reference = frame.loop.iterations[context.iteration - 2]
        if (!reference) throw new Error(copy.invalid)
        const previous = await store.loadValue(preview.workflowId, reference)
        if (previous.state !== 'known' || !previous.value || typeof previous.value !== 'object' || Array.isArray(previous.value) || previous.value.iteration !== context.iteration - 1) throw new Error(copy.invalid)
        expected = previous.value.stateRefs as unknown as typeof expected
        semanticStateRef = previous.value.semanticStateRef as unknown as typeof semanticStateRef
      }
      if (!semanticStateRef || JSON.stringify(semanticStateRef) !== JSON.stringify(context.semanticStateRef)) throw new Error(copy.invalid)
      if (!frame.loop.invariantSemanticRef || JSON.stringify(frame.loop.invariantSemanticRef) !== JSON.stringify(context.invariantSemanticRef)) throw new Error(copy.invalid)
      const invariantSemantic = await store.loadValue(preview.workflowId, context.invariantSemanticRef)
      if (invariantSemantic.state !== 'known') throw new Error(copy.invalid)
      const semanticState = await store.loadValue(preview.workflowId, semanticStateRef)
      if (semanticState.state !== 'known') throw new Error(copy.invalid)
      if (JSON.stringify(expected) !== JSON.stringify(context.stateRefs) || JSON.stringify(frame.loop.invariantRefs) !== JSON.stringify(context.invariantRefs)) throw new Error(copy.invalid)
      const load = async (refs: typeof expected): Promise<WorkflowValue> => {
        const values: Record<string, WorkflowValue> = {}
        for (const [name, reference] of Object.entries(refs)) values[name] = await workflowSemanticValue(store, preview.workflowId, await store.loadValue(preview.workflowId, reference))
        return values
      }
      const { body: _body, initial: _initial, carry: _carry, ...control } = block
      result.push({ kind: 'loop', control: JSON.parse(JSON.stringify(control)) as WorkflowValue, iteration: context.iteration,
        state: await load(context.stateRefs), stateSemantics: semanticState.value, invariantSemantics: invariantSemantic.value, invariants: await load(context.invariantRefs) })
    } else {
      const unsupported: never = context
      throw new Error(copy.invalid, { cause: unsupported })
    }
  }
  return result
}

const callAncestors = new WeakMap<WorkflowBlock, Map<string, string[]>>()
export function workflowCallAncestors(body: WorkflowBlock, nodeId: string, contexts: WorkflowCallContext[]): boolean {
  const cached = callAncestors.get(body)
  if (cached && Object.isFrozen(body)) return JSON.stringify(cached.get(nodeId)) === JSON.stringify(contexts.map(context => context.blockId))
  const indexed = new Map<string, string[]>()
  const pending: Array<{ block: WorkflowBlock; ancestors: string[] }> = [{ block: body, ancestors: [] }]
  while (pending.length) {
    const { block, ancestors } = pending.pop()!
    indexed.set(block.blockId, ancestors)
    const next = ['branch', 'map', 'loop'].includes(block.kind) ? [...ancestors, block.blockId] : ancestors
    const children = block.kind === 'sequence' || block.kind === 'parallel' ? block.blocks : block.kind === 'map' || block.kind === 'loop' ? [block.body] : block.kind === 'branch' ? [block.then, block.else, ...(block.unknown === 'blocked' ? [] : [block.unknown])] : []
    for (const child of children) pending.push({ block: child, ancestors: next })
  }
  if (Object.isFrozen(body)) callAncestors.set(body, indexed)
  return indexed.has(nodeId) && JSON.stringify(indexed.get(nodeId)) === JSON.stringify(contexts.map(context => context.blockId))
}
