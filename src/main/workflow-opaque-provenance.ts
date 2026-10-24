import type { WorkflowEvaluation, WorkflowValue, WorkflowValueReference } from '../shared/workflow'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import { validateWorkflowValueReference } from './workflow-frames'

/** Resolve main envelopes, never identically named fields inside model JSON.
 * A linear chain of committed bindings is not nested expression syntax. Walk
 * refs iteratively, retaining the distinct-reference bound without a stack cap. */
export async function workflowOpaqueProvenance(store: WorkflowStore, workflowId: string, evaluation: WorkflowEvaluation, currentRecord?: WorkflowStoreRecord): Promise<WorkflowValue> {
  const leaves = new Set<string>(), visited = new Set<string>(), pending: WorkflowValueReference[] = []
  let record: WorkflowStoreRecord | undefined = currentRecord
  const enqueue = (reference: WorkflowValueReference) => {
    validateWorkflowValueReference(reference, workflowId)
    const identity = reference.key + ':' + reference.hash
    if (visited.has(identity)) return
    if (visited.size >= 16384) throw new Error(copy.invalid)
    visited.add(identity)
    pending.push(reference)
  }
  let value = evaluation
  for (;;) {
    for (const source of value.derivedFrom) {
      if (source.startsWith('attempt:')) {
        record ??= await store.load(workflowId)
        const attemptId = source.slice('attempt:'.length), intent = record?.intents.find(item => item.attemptId === attemptId)
        const outcome = record?.outcomes.find(item => item.attemptId === attemptId)
        if (!intent || !outcome || !outcome.settled || outcome.state !== 'completed' || await store.loadOutput(workflowId, outcome) === undefined) throw new Error(copy.invalid)
        leaves.add(JSON.stringify([intent.programRevision, intent.taskId, intent.attemptId]))
      } else if (source.startsWith('value:')) {
        const match = /^value:([A-Za-z0-9_-]{1,96}):([a-f0-9]{64})$/.exec(source)
        if (!match) throw new Error(copy.invalid)
        enqueue({ workflowId, key: match[1], hash: match[2] })
      }
    }
    const collections = value.state === 'known' ? [...(value.collection ? [value.collection] : []), ...(value.collectionFields ?? []).map(field => field.collection)] : []
    for (const collection of collections) {
      if (!collection.sealed) throw new Error(copy.invalid)
      for (const entry of await store.loadCollection(workflowId, collection)) {
        if (entry.reference) {
          const frame = await store.loadFrame(workflowId, entry.reference.frameId)
          if (!frame || frame.revision !== entry.reference.revision || JSON.stringify(frame.resultRef) !== JSON.stringify(entry.reference.resultRef)) throw new Error(copy.invalid)
          enqueue(entry.reference.resultRef)
        } else if (entry.valueRef) enqueue(entry.valueRef)
        else throw new Error(copy.invalid)
      }
    }
    const reference = pending.pop()
    if (!reference) break
    value = await store.loadValue(workflowId, reference)
  }
  return [...leaves].sort()
}
