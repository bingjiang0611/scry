import type { WorkflowEvaluation, WorkflowValueReference, WorkflowBlock } from '../shared/workflow'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { workflowCheckValueSchema, workflowCombineValueSchema, workflowReplicaValueSchema } from '../shared/workflow-system'
import { workflowVerificationValueSchema } from '../shared/workflow-verification'
import { workflowChildBlocks } from '../shared/workflow'
import { matchesWorkflowValue } from './workflow-values'
import { governingWorkflowSystemPreview } from './workflow-revision-boundaries'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import type { WorkflowVerification } from './workflow-verification'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import { validateWorkflowValueReference } from './workflow-frames'
import { verifyWorkflowCheckValue } from './workflow-check-evidence'

export type WorkflowProvenanceContext = { record?: WorkflowStoreRecord; verification?: WorkflowVerification }

/** Resolve main envelopes, never identically named fields inside model JSON.
 * A linear chain of committed bindings is not nested expression syntax. Walk
 * refs iteratively, retaining the distinct-reference bound without a stack cap. */
export async function workflowOpaqueProvenance(store: WorkflowStore, workflowId: string, evaluation: WorkflowEvaluation, context: WorkflowProvenanceContext = {}): Promise<string[]> {
  const leaves = new Set<string>(), visited = new Set<string>(), pending: WorkflowValueReference[] = []
  let record: WorkflowStoreRecord | undefined = context.record
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
      } else if (source.startsWith('system:')) {
        record ??= await store.load(workflowId)
        const stepId = source.slice('system:'.length), intents = record?.systemIntents ?? [], outcomes = record?.systemOutcomes ?? []
        const matches = intents.filter(item => item.stepId === stepId), outcomeMatches = outcomes.filter(item => item.stepId === stepId)
        const index = intents.findIndex(item => item.stepId === stepId), intent = matches.length === 1 ? matches[0] : undefined, outcome = outcomeMatches.length === 1 ? outcomeMatches[0] : undefined
        if (!record || !intent || !outcome || !outcome.settled || outcome.state !== 'completed' || !outcome.resultRef || outcome.resultRef.key !== stepId) throw new Error(copy.invalid)
        validateWorkflowSystemLedger(record)
        const canonical = await store.loadValue(workflowId, outcome.resultRef)
        if (JSON.stringify(canonical) !== JSON.stringify(value) || canonical.state !== 'known' || !canonical.derivedFrom.includes('system:' + stepId)) throw new Error(copy.invalid)
        const preview = governingWorkflowSystemPreview(record, 'intent', index), pendingNodes: WorkflowBlock[] = [preview.program.body], nodes = new Map<string, WorkflowBlock>()
        while (pendingNodes.length) { const node = pendingNodes.pop()!; nodes.set(node.blockId, node); pendingNodes.push(...workflowChildBlocks(node)) }
        const node = nodes.get(intent.nodeId), schema = intent.kind === 'prepare_replica' ? workflowReplicaValueSchema : intent.kind === 'combine' ? workflowCombineValueSchema : intent.kind === 'check' ? workflowCheckValueSchema : workflowVerificationValueSchema
        if ((intent.kind === 'prepare_replica' && node?.kind !== 'replica') || (intent.kind === 'combine' && node?.kind !== 'combine') || (intent.kind === 'check' && node?.kind !== 'check') || (intent.kind === 'verification' && node?.kind !== 'verification') || !matchesWorkflowValue(canonical.value, schema)) throw new Error(copy.invalid)
        if (intent.kind === 'prepare_replica' && (JSON.stringify(canonical.replica) !== JSON.stringify(outcome.replica) || JSON.stringify(canonical.value) !== JSON.stringify(outcome.replica))) throw new Error(copy.invalid)
        if (intent.kind === 'combine') {
          if (!outcome.combine || JSON.stringify(canonical.value) !== JSON.stringify(outcome.combine) || (outcome.combine.state === 'combined' && JSON.stringify(outcome.combine.integration) !== JSON.stringify(outcome.replica)) || (outcome.combine.state === 'conflict' && outcome.replica)) throw new Error(copy.invalid)
        }
        if (intent.kind === 'check' && node?.kind === 'check') {
          if (!outcome.check || !node.authorization) throw new Error(copy.invalid)
          await verifyWorkflowCheckValue(store, workflowId, stepId, outcome.check, node.authorization, canonical.value)
        }
        if (intent.kind === 'verification' && node?.kind === 'verification') {
          if (!context.verification || JSON.stringify(await context.verification.execute(record, node, stepId)) !== JSON.stringify(canonical.value)) throw new Error(copy.invalid)
        }
        // Include the immutable result hash. Equal JSON from a reexecuted native
        // step is still a different opaque source and cannot preserve reuse.
        leaves.add(JSON.stringify(['system', intent.programRevision, stepId, outcome.resultRef.hash]))
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

/** Ordinary JSON equality never erases a real native producer. Keep this
 * separate from ordinary attempt lineage: only SystemSteps are always fresh. */
export async function workflowNativeProvenance(store: WorkflowStore, workflowId: string, value: WorkflowEvaluation, context: WorkflowProvenanceContext = {}): Promise<string[]> {
  const record = context.record ?? await store.load(workflowId)
  if (!record?.systemIntents?.length) return []
  return (await workflowOpaqueProvenance(store, workflowId, value, { ...context, record })).filter(source => JSON.parse(source)[0] === 'system')
}
