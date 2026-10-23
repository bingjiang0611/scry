import type { WorkflowValueReference, WorkflowValueSchema } from './workflow'
import type { WorkflowCheckResult } from './workflow-check'
import type { WorkflowReplicaReference } from './workflow-replica'

export const workflowReplicaValueSchema: WorkflowValueSchema = { type: 'object', properties: {
  workflowId: { type: 'string' }, replicaId: { type: 'string' }, inputHash: { type: 'string' }
}, required: ['workflowId', 'replicaId', 'inputHash'] }
export const workflowCheckValueSchema: WorkflowValueSchema = { type: 'object', properties: {
  passed: { type: 'boolean' }, state: { type: 'string' }, exitCode: { type: 'union', variants: [{ type: 'number' }, { type: 'null' }] },
  settled: { type: 'boolean' }, truncated: { type: 'boolean' }, diagnosticCount: { type: 'union', variants: [{ type: 'number' }, { type: 'null' }] }
}, required: ['passed', 'state', 'exitCode', 'settled', 'truncated', 'diagnosticCount'] }

export const WORKFLOW_MAX_SYSTEM_STEPS = 16384
export type WorkflowCheckSummary = Omit<WorkflowCheckResult, 'stdout' | 'stderr' | 'diagnostics'> & {
  stdoutRef: WorkflowValueReference
  stderrRef: WorkflowValueReference
  diagnostics: { state: 'available'; source: 'derived'; count: number; reference: WorkflowValueReference } | { state: 'unavailable'; reason: string }
}
export type WorkflowSystemKind = 'prepare_replica' | 'check'
export type WorkflowSystemIntent = {
  stepId: string
  taskId: string
  nodeId: string
  programRevision: string
  kind: WorkflowSystemKind
  createdAt: number
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
