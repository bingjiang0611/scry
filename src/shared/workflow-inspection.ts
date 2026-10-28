import type { AgentModelRef } from './runtime'
import type { ProviderId } from './provider'
import type { WorkflowAttemptState, WorkflowRole } from './workflow'
import type { WorkflowValueReference } from './workflow'
import { type WorkflowSystemKind, type WorkflowSystemOutcome } from './workflow-system'
import type { WorkflowClassifierIntent, WorkflowClassifierOutcome } from './workflow-classifier'

export const WORKFLOW_EXECUTION_INSPECTION_PAGE_SIZE = 32
// Offset is cursor pagination, not a renderer work budget. Main still rejects
// unsafe integers; the canonical ledger determines whether another page exists.
export const WORKFLOW_EXECUTION_INSPECTION_MAX_OFFSET = Number.MAX_SAFE_INTEGER - (Number.MAX_SAFE_INTEGER % WORKFLOW_EXECUTION_INSPECTION_PAGE_SIZE)

export type WorkflowExecutionInspectionKind = 'attempts' | 'systems' | 'classifiers'
export type WorkflowExecutionInspectionRequest = Readonly<{
  workflowId: string
  programRevision: string
  kind: WorkflowExecutionInspectionKind
  nodeId?: string
  offset?: number
}>

export type WorkflowExecutionInspectionUnavailableReason = 'root_missing' | 'source_changed'
export type WorkflowExecutionInspectionFrame =
  | Readonly<{ state: 'available'; frameId: string }>
  | Readonly<{ state: 'unavailable'; reason: 'missing_reference' }>
export type WorkflowExecutionInspectionIntent<T> =
  | Readonly<{ state: 'available'; value: T }>
  | Readonly<{ state: 'unavailable'; reason: 'missing_intent' }>
export type WorkflowExecutionInspectionOutcome<T> =
  | Readonly<{ state: 'available'; value: T }>
  | Readonly<{ state: 'unavailable'; reason: 'missing_outcome' }>

export type WorkflowAttemptInspectionIntent = Readonly<{
  nodeId: string
  programRevision: string
  createdAt: number
  role: string
  providerId: string
  requestedModel?: string | AgentModelRef
  previousAttemptId?: string
  retryCommandId?: string
  frame: WorkflowExecutionInspectionFrame
}>
export type WorkflowAttemptInspectionOutcome = Readonly<{
  nodeId: string
  role: WorkflowRole
  providerId: ProviderId
  requestedModel?: string | AgentModelRef
  actualModel?: string
  actualModelStatus: 'unknown' | 'observed'
  state: WorkflowAttemptState
  settled: boolean
  runId?: string
  error?: string
  errorTruncated?: boolean
}>
export type WorkflowAttemptInspectionRecord = Readonly<{
  attemptId: string
  taskId: string
  intent: WorkflowExecutionInspectionIntent<WorkflowAttemptInspectionIntent>
  outcome: WorkflowExecutionInspectionOutcome<WorkflowAttemptInspectionOutcome>
}>

export type WorkflowSystemInspectionIntent = Readonly<{
  nodeId: string
  programRevision: string
  createdAt: number
  kind: WorkflowSystemKind
  frame: WorkflowExecutionInspectionFrame
}>
export type WorkflowSystemInspectionOutcome = Readonly<{
  stepId: string
  taskId: string
  state: WorkflowSystemOutcome['state']
  settled: boolean
  startedAt: number
  finishedAt: number
  resultRef?: WorkflowValueReference
  error?: string
  errorTruncated?: boolean
}>
export type WorkflowSystemInspectionRecord = Readonly<{
  stepId: string
  taskId: string
  intent: WorkflowExecutionInspectionIntent<WorkflowSystemInspectionIntent>
  outcome: WorkflowExecutionInspectionOutcome<WorkflowSystemInspectionOutcome>
}>
export type WorkflowClassifierInspectionIntent = Readonly<Omit<Pick<WorkflowClassifierIntent, 'classifierId' | 'nodeId' | 'programRevision' | 'criteria' | 'model' | 'kind' | 'frame'>, 'frame'> & { frame: WorkflowExecutionInspectionFrame; createdAt: number }>
export type WorkflowClassifierInspectionOutcome = Readonly<Pick<WorkflowClassifierOutcome, 'state' | 'settled' | 'value' | 'confidence' | 'probability' | 'reason'> & { error?: string; errorTruncated?: boolean }>
export type WorkflowClassifierInspectionRecord = Readonly<{
  classifierId: string
  stepId: string
  taskId: string
  intent: WorkflowExecutionInspectionIntent<WorkflowClassifierInspectionIntent>
  outcome: WorkflowExecutionInspectionOutcome<WorkflowClassifierInspectionOutcome>
}>

export type WorkflowExecutionInspectionRecord = WorkflowAttemptInspectionRecord | WorkflowSystemInspectionRecord | WorkflowClassifierInspectionRecord
export type WorkflowExecutionInspection =
  | Readonly<{
    state: 'unavailable'
    source: 'canonical_ledger'
    observedAt: number
    reason: WorkflowExecutionInspectionUnavailableReason
  }>
  | Readonly<{
    state: 'available'
    source: 'canonical_ledger'
    observedAt: number
    workflowId: string
    programRevision: string
    kind: WorkflowExecutionInspectionKind
    offset: number
    total: number
    nextOffset?: number
    records: WorkflowExecutionInspectionRecord[]
  }>
