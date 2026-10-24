import { createHash } from 'node:crypto'
import type { WorkflowAttemptOutcome, WorkflowBlock, WorkflowCollectionEntry, WorkflowControlFrame, WorkflowEvaluation, WorkflowScalar, WorkflowValue } from '../shared/workflow'
import { WORKFLOW_MAX_BATCH } from '../shared/workflow'
import { workflowCollectionCopy, workflowFrameCopy as copy } from '../shared/constants/copy'
import { workflowArrayAuthorities, workflowField, workflowValueKey } from './workflow-expressions'
import type { WorkflowControl, WorkflowControlScope } from './workflow-control'
import type { WorkflowExecutionResult, WorkflowInterpreterState } from './workflow-interpreter'

/** Map expansion delegates every body to the existing Interpreter fiber. */
export async function runWorkflowMap(control: WorkflowControl, state: WorkflowInterpreterState,
  block: Extract<WorkflowBlock, { kind: 'map' }>, scope: WorkflowControlScope, frame: WorkflowControlFrame,
  runBody: (block: WorkflowBlock, scope: WorkflowControlScope) => Promise<WorkflowExecutionResult>,
  commit: (block: WorkflowBlock, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined, value: WorkflowEvaluation, phase: WorkflowControlFrame['phase'], outcomes?: WorkflowAttemptOutcome[], partial?: boolean) => Promise<WorkflowExecutionResult>,
  parallelism: () => number): Promise<WorkflowExecutionResult> {
    const restored = await control.restoredCollection(frame)
    if (restored) return commit(block, scope, frame, restored.value, restored.phase, [], restored.reportPartial)
    const source = await control.evaluate(block.items, scope, block.blockId, () => state.stopped)
    if (source.state === 'unknown') {
      scope.blockedReason = source.reason
      return commit(block, scope, frame, source, 'blocked')
    }
    const collection = source.collection ? await control.entries(source) : undefined
    if (!collection && !Array.isArray(source.value)) throw new Error(workflowCollectionCopy.source)
    if (collection && (block.key.length !== 1 || block.key[0] !== 'key')) throw new Error(workflowCollectionCopy.collectionKey)
    const length = collection?.length ?? (source.value as WorkflowValue[]).length
    if (length > WORKFLOW_MAX_BATCH || length > block.maxItems) throw new Error(workflowCollectionCopy.limit)
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const keys: WorkflowScalar[] = [], labels: string[] = [], seen = new Set<string>()
    // Validate the complete logical batch before starting any item. Collection
    // maps retain existing logical keys; payloads are loaded only by live fibers.
    for (let index = 0; index < length; index++) {
      const key = collection ? { state: 'known' as const, value: collection[index].key, derivedFrom: [] } : workflowField((source.value as WorkflowValue[])[index], block.key)
      if (key.state !== 'known' || !(key.value === null || typeof key.value === 'string' || typeof key.value === 'boolean' || (typeof key.value === 'number' && Number.isFinite(key.value)))) throw new Error(workflowCollectionCopy.key)
      const encoded = workflowValueKey(key.value)
      if (seen.has(encoded)) throw new Error(workflowCollectionCopy.key)
      seen.add(encoded); keys.push(key.value)
      labels.push(block.blockId + ':' + hash(encoded) + ':' + hash({ value: collection ? collection[index] : (source.value as WorkflowValue[])[index], sources: source.derivedFrom }))
    }
    frame = await control.freezeSource(frame, source, control.expressionSource(block.items, scope))
    const entries: WorkflowCollectionEntry[] = keys.map((key, index) => ({ key, index, state: 'pending', settled: false }))
    const outcomes: WorkflowAttemptOutcome[] = [], authorities = workflowArrayAuthorities(source)
    let partial = false, critical = false
    const run = async (index: number): Promise<WorkflowExecutionResult> => {
      const child = control.child(scope, labels[index])
      const input = collection ? await control.entryValue(collection[index]) : workflowField(source.value, [String(index)], source.derivedFrom, { collectionFields: authorities.get(String(index)) })
      if (input.state !== 'known') throw new Error(workflowCollectionCopy.invalid)
      child.callContexts!.push({ kind: 'map', frameId: frame.frameId, blockId: block.blockId, key: keys[index], collection: !!collection,
        itemRef: await control.saveCollectionValue(input) })
      control.bind(child, block.item, input)
      if (frame.sourceSemanticKey) (child.semanticDefinitions ??= new Map()).set(block.item, frame.sourceSemanticKey)
      const result = await runBody(block.body, child)
      const phase = result.phase
      partial ||= result.reportPartial === true
      critical ||= phase !== 'completed' && !result.reportPartial
      if (!['completed', 'failed', 'blocked', 'unknown', 'stopped'].includes(phase)) throw new Error(copy.invalid)
      entries[index] = { key: keys[index], index, state: phase as WorkflowCollectionEntry['state'], settled: result.outcomes.every(outcome => outcome.settled),
        ...(result.reference ? { reference: result.reference } : { error: workflowCollectionCopy.pending }) }
      if (child.blockedReason) scope.blockedReason ??= child.blockedReason
      return result
    }
    const finish = async (phase: WorkflowControlFrame['phase']) => commit(block, scope, frame,
      await control.collection(frame, structuredClone(entries), entries.every(entry => entry.state !== 'pending' && entry.state !== 'unknown' && entry.settled)), phase, outcomes, phase === 'blocked' && partial && !critical && !state.stopped)
    let cursor = 0
    const active = new Set<Promise<{ index: number; result?: WorkflowExecutionResult; error?: unknown }>>()
    const admit = () => {
      while (!state.stopped && cursor < length && active.size < parallelism()) {
        const index = cursor++
        active.add(run(index).then(result => ({ index, result }), (error: unknown) => ({ index, error })))
      }
    }
    admit()
    while (active.size) {
      const next = await Promise.race([...active].map(promise => promise.then(value => ({ promise, value }))))
      active.delete(next.promise)
      if ('error' in next.value) { await Promise.allSettled([...active]); throw next.value.error }
      outcomes.push(...next.value.result!.outcomes)
      if (next.value.result!.phase === 'unknown') return finish('unknown')
      admit()
    }
    const phase = state.stopped ? 'stopped' : entries.some(entry => entry.state === 'blocked') ? 'blocked' : entries.some(entry => entry.state !== 'completed') ? 'failed' : 'completed'
    return finish(phase)
}
