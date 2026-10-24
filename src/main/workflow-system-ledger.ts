import { createHash } from 'node:crypto'
import { WORKFLOW_MAX_BATCH, workflowChildBlocks, type WorkflowBlock } from '../shared/workflow'
import { WORKFLOW_MAX_SYSTEM_STEPS, type WorkflowInputSnapshot } from '../shared/workflow-system'
import { workflowSystemCopy as copy } from '../shared/constants/copy'
import { validateWorkflowValueReference } from './workflow-frames'
import { WORKFLOW_REPLICA_MAX_CONTENT, WORKFLOW_REPLICA_MAX_ENTRIES, WORKFLOW_REPLICA_MAX_MANIFEST, validateWorkflowReplicaReference } from './workflow-replica'
import type { WorkflowStoreRecord } from './workflow-store'

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
export function validateWorkflowSystemLedger(record: WorkflowStoreRecord): void {
  const intents = record.systemIntents ?? [], outcomes = record.systemOutcomes ?? []
  if (!intents.length && !outcomes.length) return
  if (intents.length > WORKFLOW_MAX_SYSTEM_STEPS || outcomes.length > WORKFLOW_MAX_SYSTEM_STEPS ||
    new Set(intents.map(value => value.stepId)).size !== intents.length || new Set(intents.map(value => value.taskId)).size !== intents.length || new Set(outcomes.map(value => value.stepId)).size !== outcomes.length) throw new Error(copy.intent)
  const nodes = new Map<string, WorkflowBlock>(), pending = [record.preview.program.body]
  while (pending.length) { const block = pending.pop()!; nodes.set(block.blockId, block); pending.push(...workflowChildBlocks(block)) }
  const admitted = new Map(intents.map(intent => [intent.stepId, intent]))
  for (const intent of intents) {
    const node = nodes.get(intent.nodeId), task = intent.taskId.split(':')
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(intent.stepId) || !Number.isSafeInteger(intent.createdAt) || task.length !== 3 || task[0] !== record.preview.workflowId || !/^[a-f0-9]{64}$/.test(task[1]) || task[2] !== intent.nodeId ||
      intent.programRevision !== record.preview.programRevision || (intent.kind !== 'prepare_replica' && intent.kind !== 'check') || node?.kind !== (intent.kind === 'prepare_replica' ? 'replica' : 'check')) throw new Error(copy.intent)
    if (intent.replica) validateWorkflowReplicaReference(intent.replica, record.preview.workflowId)
    if (intent.inputSnapshot) {
      if (intent.kind !== 'check' || !intent.replica) throw new Error(copy.intent)
      validateWorkflowInputSnapshot(intent.inputSnapshot, record.preview.workflowId, intent.stepId, 'before')
    }
  }
  for (const outcome of outcomes) {
    const intent = admitted.get(outcome.stepId)
    if (!intent || outcome.taskId !== intent.taskId || typeof outcome.settled !== 'boolean' || !['completed', 'failed', 'blocked', 'unknown', 'stopped'].includes(outcome.state) || !Number.isSafeInteger(outcome.startedAt) || !Number.isSafeInteger(outcome.finishedAt)) throw new Error(copy.intent)
    if (outcome.resultRef) {
      validateWorkflowValueReference(outcome.resultRef, record.preview.workflowId)
      if (outcome.resultRef.key !== intent.stepId) throw new Error(copy.intent)
    }
    if (outcome.state === 'completed' && (!outcome.settled || !outcome.resultRef)) throw new Error(copy.intent)
    if (outcome.replica) {
      validateWorkflowReplicaReference(outcome.replica, record.preview.workflowId)
      if (intent.kind === 'prepare_replica' ? outcome.replica.replicaId !== intent.stepId : JSON.stringify(intent.replica) !== JSON.stringify(outcome.replica)) throw new Error(copy.intent)
    }
    if (outcome.state === 'completed' && (!outcome.replica || (intent.kind === 'check' && !outcome.check))) throw new Error(copy.intent)
    if (outcome.check) {
      if (intent.kind !== 'check') throw new Error(copy.intent)
      const inputs = outcome.check.inputs
      if (Boolean(inputs) !== Boolean(intent.inputSnapshot)) throw new Error(copy.intent)
      if (inputs) {
        if (JSON.stringify(inputs.before) !== JSON.stringify(intent.inputSnapshot)) throw new Error(copy.intent)
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
}

export function assertWorkflowSystemsSettled(record: WorkflowStoreRecord): void {
  validateWorkflowSystemLedger(record)
  const outcomes = new Map((record.systemOutcomes ?? []).map(outcome => [outcome.stepId, outcome]))
  for (const intent of record.systemIntents ?? []) {
    const outcome = outcomes.get(intent.stepId)
    if (!outcome || !outcome.settled || outcome.state === 'unknown') throw new Error(copy.unknown)
  }
}
