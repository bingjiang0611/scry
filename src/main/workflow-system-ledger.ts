import { createHash } from 'node:crypto'
import { validateWorkflowVerificationInputs } from './workflow-verification-inputs'
import { WORKFLOW_MAX_BATCH, workflowChildBlocks, type WorkflowBlock } from '../shared/workflow'
import { WORKFLOW_MAX_SYSTEM_STEPS, type WorkflowInputSnapshot, type WorkflowInputMaterialization, type WorkflowMaterializedInput } from '../shared/workflow-system'
import { workflowSystemCopy as copy } from '../shared/constants/copy'
import { validateWorkflowValueReference } from './workflow-frames'
import { WORKFLOW_REPLICA_MAX_CONTENT, WORKFLOW_REPLICA_MAX_ENTRIES, WORKFLOW_REPLICA_MAX_MANIFEST, validateWorkflowReplicaReference } from './workflow-replica'
import type { WorkflowStoreRecord } from './workflow-store'
import { governingWorkflowSystemPreview } from './workflow-revision-boundaries'
import type { WorkflowReplicaReference } from '../shared/workflow-replica'

export const workflowSystemArtifactKey = (stepId: string, label: string): string => createHash('sha256').update(JSON.stringify([stepId, label])).digest('hex')

export function validateWorkflowInputSnapshot(snapshot: WorkflowInputSnapshot, workflowId: string, stepId: string, phase: 'before' | 'after'): void {
  if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.inputHash) || !Number.isSafeInteger(snapshot.entryCount) || snapshot.entryCount < 0 || snapshot.entryCount > WORKFLOW_REPLICA_MAX_ENTRIES ||
    !Number.isSafeInteger(snapshot.contentBytes) || snapshot.contentBytes < 0 || snapshot.contentBytes > WORKFLOW_REPLICA_MAX_CONTENT + WORKFLOW_REPLICA_MAX_MANIFEST ||
    !Number.isSafeInteger(snapshot.manifestBytes) || snapshot.manifestBytes < 2 || snapshot.manifestBytes > WORKFLOW_REPLICA_MAX_MANIFEST ||
    !Number.isSafeInteger(snapshot.startedAt) || !Number.isSafeInteger(snapshot.finishedAt) || snapshot.finishedAt < snapshot.startedAt) throw new Error(copy.intent)
  validateWorkflowValueReference(snapshot.reference, workflowId)
  if (snapshot.reference.key !== workflowSystemArtifactKey(stepId, 'input-' + phase)) throw new Error(copy.intent)
}

/** Structure is valid during active dispatch too; unresolved intent is checked
 * separately at recovery, never normalized into a safe-to-repeat operation. */
export function validateWorkflowSystemLedger(record: WorkflowStoreRecord): ReadonlyMap<string, WorkflowMaterializedInput> {
  const intents = record.systemIntents ?? [], outcomes = record.systemOutcomes ?? []
  if (!intents.length && !outcomes.length) return new Map()
  if (intents.length > WORKFLOW_MAX_SYSTEM_STEPS || outcomes.length > WORKFLOW_MAX_SYSTEM_STEPS ||
    new Set(intents.map(value => value.stepId)).size !== intents.length || new Set(intents.map(value => value.taskId)).size !== intents.length || new Set(outcomes.map(value => value.stepId)).size !== outcomes.length) throw new Error(copy.intent)
  const nodeCache = new WeakMap<object, Map<string, WorkflowBlock>>()
  const nodesFor = (preview: WorkflowStoreRecord['preview']) => {
    const cached = nodeCache.get(preview.program)
    if (cached) return cached
    const nodes = new Map<string, WorkflowBlock>(), pending = [preview.program.body]
    while (pending.length) { const block = pending.pop()!; nodes.set(block.blockId, block); pending.push(...workflowChildBlocks(block)) }
    nodeCache.set(preview.program, nodes)
    return nodes
  }
  const admitted = new Map(intents.map(intent => [intent.stepId, intent]))
  // One origin index, not a scan per check. Only committed main-produced pairs
  // establish materialization; Agent JSON cannot supply a candidate association.
  const prepared = new Map<string, WorkflowMaterializedInput>()
  for (const outcome of outcomes) {
    const intent = admitted.get(outcome.stepId)
    if (intent?.kind === 'prepare_replica' && outcome.state === 'completed' && outcome.settled && outcome.replica && outcome.resultRef) prepared.set(JSON.stringify(outcome.replica), {
      source: 'main_ledger', preparationStepId: intent.stepId, materialized: outcome.replica, ...(intent.replica ? { candidate: intent.replica } : {})
    })
  }
  for (const [index, intent] of intents.entries()) {
    const governing = governingWorkflowSystemPreview(record, 'intent', index), node = nodesFor(governing).get(intent.nodeId), task = intent.taskId.split(':')
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(intent.stepId) || !Number.isSafeInteger(intent.createdAt) || task.length !== 3 || task[0] !== governing.workflowId || !/^[a-f0-9]{64}$/.test(task[1]) || task[2] !== intent.nodeId ||
      intent.programRevision !== governing.programRevision || (intent.kind !== 'prepare_replica' && intent.kind !== 'check' && intent.kind !== 'verification') || node?.kind !== (intent.kind === 'prepare_replica' ? 'replica' : intent.kind)) throw new Error(copy.intent)
    if (node?.kind === 'verification') {
      validateWorkflowVerificationInputs(intent.verificationInputs, node)
      if (intent.replica || intent.inputSnapshot || intent.inputMaterialization) throw new Error(copy.intent)
    } else if (intent.verificationInputs !== undefined) throw new Error(copy.intent)
    if (intent.replica) validateWorkflowReplicaReference(intent.replica, record.preview.workflowId)
    if (intent.inputSnapshot) {
      if (intent.kind !== 'check' || !intent.replica) throw new Error(copy.intent)
      validateWorkflowInputSnapshot(intent.inputSnapshot, record.preview.workflowId, intent.stepId, 'before')
    }
    if (intent.inputMaterialization !== undefined && (!intent.inputSnapshot || !intent.replica ||
      JSON.stringify(intent.inputMaterialization) !== JSON.stringify(workflowInputMaterialization(prepared, intent.replica, intent.inputSnapshot)))) throw new Error(copy.intent)
  }
  for (const [index, outcome] of outcomes.entries()) {
    const intent = admitted.get(outcome.stepId), governing = governingWorkflowSystemPreview(record, 'outcome', index)
    const node = intent ? nodesFor(governing).get(intent.nodeId) : undefined
    if (!intent || intent.programRevision !== governing.programRevision || outcome.taskId !== intent.taskId || typeof outcome.settled !== 'boolean' || !['completed', 'failed', 'blocked', 'unknown', 'stopped'].includes(outcome.state) || !Number.isSafeInteger(outcome.startedAt) || !Number.isSafeInteger(outcome.finishedAt)) throw new Error(copy.intent)
    if (outcome.resultRef) {
      validateWorkflowValueReference(outcome.resultRef, record.preview.workflowId)
      if (outcome.resultRef.key !== intent.stepId) throw new Error(copy.intent)
    }
    if (outcome.state === 'completed' && (!outcome.settled || !outcome.resultRef)) throw new Error(copy.intent)
    if (outcome.replica) {
      validateWorkflowReplicaReference(outcome.replica, record.preview.workflowId)
      if (intent.kind === 'prepare_replica' ? outcome.replica.replicaId !== intent.stepId : JSON.stringify(intent.replica) !== JSON.stringify(outcome.replica)) throw new Error(copy.intent)
    }
    if (intent.kind === 'verification' && (outcome.replica || outcome.check)) throw new Error(copy.intent)
    if (outcome.state === 'completed' && intent.kind !== 'verification' && (!outcome.replica || (intent.kind === 'check' && !outcome.check))) throw new Error(copy.intent)
    if (outcome.state === 'completed' && node?.kind === 'replica' && ((node.source !== undefined) !== Boolean(intent.replica) ||
      (intent.replica && (intent.replica.replicaId === outcome.replica!.replicaId || !prepared.has(JSON.stringify(intent.replica)))))) throw new Error(copy.intent)
    if (outcome.check) {
      if (intent.kind !== 'check') throw new Error(copy.intent)
      const inputs = outcome.check.inputs
      if (Boolean(inputs) !== Boolean(intent.inputSnapshot)) throw new Error(copy.intent)
      if (inputs) {
        if (JSON.stringify(inputs.before) !== JSON.stringify(intent.inputSnapshot) || JSON.stringify(inputs.materialization) !== JSON.stringify(intent.inputMaterialization)) throw new Error(copy.intent)
        if (inputs.changes.after) validateWorkflowInputSnapshot(inputs.changes.after, record.preview.workflowId, intent.stepId, 'after')
        if (inputs.changes.state === 'available') {
          if (inputs.changes.source !== 'snapshot_comparison' || !Number.isSafeInteger(inputs.changes.count) || inputs.changes.count < 0 || inputs.changes.count > WORKFLOW_MAX_BATCH || !inputs.changes.after) throw new Error(copy.intent)
          validateWorkflowValueReference(inputs.changes.reference, record.preview.workflowId)
          if (inputs.changes.reference.key !== workflowSystemArtifactKey(intent.stepId, 'input-changes')) throw new Error(copy.intent)
        } else if (inputs.changes.state !== 'unavailable' || typeof inputs.changes.reason !== 'string' || !inputs.changes.reason) throw new Error(copy.intent)
      }
      const references = [['stdout', outcome.check.stdoutRef], ['stderr', outcome.check.stderrRef], ...(outcome.check.diagnostics.state === 'available' ? [['diagnostics', outcome.check.diagnostics.reference] as const] : [])] as const
      for (const [label, reference] of references) {
        validateWorkflowValueReference(reference, record.preview.workflowId)
        if (reference.key !== workflowSystemArtifactKey(intent.stepId, label)) throw new Error(copy.intent)
      }
    }
  }
  return prepared
}

/** Availability proves only that pre-input matches a committed materialization,
 * not check success, a required suite, or the candidate's current contents. */
export function workflowInputMaterialization(prepared: ReadonlyMap<string, WorkflowMaterializedInput>, replica: WorkflowReplicaReference, before: WorkflowInputSnapshot): WorkflowInputMaterialization {
  const origin = prepared.get(JSON.stringify(replica))
  if (!origin) throw new Error(copy.intent)
  return replica.inputHash === before.inputHash ? { ...origin, state: 'available' }
    : { ...origin, state: 'unavailable', reason: copy.materializationChanged }
}

export function assertWorkflowSystemsSettled(record: WorkflowStoreRecord): void {
  validateWorkflowSystemLedger(record)
  const outcomes = new Map((record.systemOutcomes ?? []).map(outcome => [outcome.stepId, outcome]))
  for (const intent of record.systemIntents ?? []) {
    const outcome = outcomes.get(intent.stepId)
    if (!outcome || !outcome.settled || outcome.state === 'unknown') throw new Error(copy.unknown)
  }
}
