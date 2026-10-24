import { WORKFLOW_MAX_BATCH, type WorkflowValueReference, type WorkflowValueSchema } from './workflow'
import type { WorkflowVerificationInputs } from './workflow-verification'
import type { WorkflowCheckResult } from './workflow-check'
import type { WorkflowReplicaReference } from './workflow-replica'

export const workflowReplicaValueSchema: WorkflowValueSchema = { type: 'object', properties: {
  workflowId: { type: 'string' }, replicaId: { type: 'string' }, inputHash: { type: 'string' }
}, required: ['workflowId', 'replicaId', 'inputHash'] }
const inputSnapshotSchema: WorkflowValueSchema = { type: 'object', properties: {
  inputHash: { type: 'string' }, entryCount: { type: 'number' }, contentBytes: { type: 'number' }, manifestBytes: { type: 'number' }, startedAt: { type: 'number' }, finishedAt: { type: 'number' }
}, required: ['inputHash', 'entryCount', 'contentBytes', 'manifestBytes', 'startedAt', 'finishedAt'] }

export const workflowCheckValueSchema: WorkflowValueSchema = { type: 'object', properties: {
  stepId: { type: 'string' }, passed: { type: 'boolean' }, state: { type: 'string' }, exitCode: { type: 'union', variants: [{ type: 'number' }, { type: 'null' }] },
  settled: { type: 'boolean' }, truncated: { type: 'boolean' }, diagnosticCount: { type: 'union', variants: [{ type: 'number' }, { type: 'null' }] },
  // Optional for already committed checks: missing evidence remains unknown,
  // never a fabricated empty diagnostic list or a reason to rerun the process.
  diagnostics: { type: 'object', properties: {
    state: { type: 'enum', values: ['available', 'unavailable'] }, source: { type: 'enum', values: ['derived'] }, reason: { type: 'string' },
    items: { type: 'array', maxItems: WORKFLOW_MAX_BATCH, items: { type: 'object', properties: {
      file: { type: 'string' }, line: { type: 'number' }, column: { type: 'number' }, code: { type: 'string' }, message: { type: 'string' }
    }, required: ['file', 'line', 'column', 'code', 'message'] } }
  }, required: ['state'] },
  inputs: { type: 'object', properties: {
    before: inputSnapshotSchema, after: inputSnapshotSchema,
    materialization: { type: 'object', properties: {
      state: { type: 'enum', values: ['available', 'unavailable'] }, source: { type: 'enum', values: ['main_ledger'] }, reason: { type: 'string' },
      preparationStepId: { type: 'string' }, materialized: workflowReplicaValueSchema, candidate: workflowReplicaValueSchema
    }, required: ['state', 'source', 'preparationStepId', 'materialized'] },
    changes: { type: 'object', properties: {
      state: { type: 'enum', values: ['available', 'unavailable'] }, source: { type: 'enum', values: ['snapshot_comparison'] }, reason: { type: 'string' },
      items: { type: 'array', maxItems: WORKFLOW_MAX_BATCH, items: { type: 'object', properties: {
        path: { type: 'string' }, kind: { type: 'enum', values: ['added', 'modified', 'removed'] }
      }, required: ['path', 'kind'] } }
    }, required: ['state'] }
  }, required: ['before', 'changes'] }
}, required: ['passed', 'state', 'exitCode', 'settled', 'truncated', 'diagnosticCount'] }

export const WORKFLOW_MAX_SYSTEM_STEPS = 16384
/** A bounded manifest observation, not an atomic filesystem snapshot, saved
 * file contents, sandbox audit, or proof of which process caused a change. */
export type WorkflowRepositorySource = { kind: 'non_repository' } | { kind: 'repository'; root: string; head: string }
export type WorkflowInputSnapshot = {
  inputHash: string
  entryCount: number
  contentBytes: number
  manifestBytes: number
  startedAt: number
  finishedAt: number
  repositorySource?: WorkflowRepositorySource
  reference: WorkflowValueReference
}
export type WorkflowInputChange = { path: string; kind: 'added' | 'modified' | 'removed' }
/** The materialized reference hashes the state captured at preparation, not the
 * current mutable candidate, nor the candidate reference's original creation. */
export type WorkflowMaterializedInput = {
  source: 'main_ledger'
  preparationStepId: string
  materialized: WorkflowReplicaReference
  candidate?: WorkflowReplicaReference
}
export type WorkflowInputMaterialization = WorkflowMaterializedInput & (
  { state: 'available' } | { state: 'unavailable'; reason: string }
)
export type WorkflowCheckInputs = {
  before: WorkflowInputSnapshot
  materialization?: WorkflowInputMaterialization
  changes: { state: 'available'; source: 'snapshot_comparison'; after: WorkflowInputSnapshot; count: number; reference: WorkflowValueReference }
    | { state: 'unavailable'; reason: string; after?: WorkflowInputSnapshot }
}
export type WorkflowCheckSummary = Omit<WorkflowCheckResult, 'stdout' | 'stderr' | 'diagnostics'> & {
  inputs?: WorkflowCheckInputs
  stdoutRef: WorkflowValueReference
  stderrRef: WorkflowValueReference
  diagnostics: { state: 'available'; source: 'derived'; count: number; reference: WorkflowValueReference } | { state: 'unavailable'; reason: string }
}
export type WorkflowSystemKind = 'prepare_replica' | 'check' | 'verification'
export type WorkflowSystemIntent = {
  stepId: string
  taskId: string
  nodeId: string
  programRevision: string
  kind: WorkflowSystemKind
  createdAt: number
  inputSnapshot?: WorkflowInputSnapshot
  verificationInputs?: WorkflowVerificationInputs
  inputMaterialization?: WorkflowInputMaterialization
  replica?: WorkflowReplicaReference
}
export type WorkflowSystemOutcome = {
  stepId: string
  taskId: string
  state: 'completed' | 'failed' | 'blocked' | 'unknown' | 'stopped'
  settled: boolean
  startedAt: number
  /** Receipt observation time; physical convergence is the separate settled fact. */
  finishedAt: number
  resultRef?: WorkflowValueReference
  replica?: WorkflowReplicaReference
  check?: WorkflowCheckSummary
  error?: string
}
export type WorkflowSystemProgress = {
  stepId: string
  nodeId: string
  kind: WorkflowSystemKind
  state: 'queued' | 'running' | WorkflowSystemOutcome['state']
  settled: boolean
  startedAt?: number
  finishedAt?: number
  replica?: WorkflowReplicaReference
  result?: WorkflowSystemOutcome['check']
  error?: string
}
