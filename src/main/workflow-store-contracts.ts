import type { WorkflowAttemptOutcome, WorkflowCollectionEntry, WorkflowCollectionReference, WorkflowControlFrame, WorkflowEvaluation, WorkflowPlanPreview, WorkflowProgress, WorkflowValueReference } from '../shared/workflow'
import type { WorkflowRetryTarget } from '../shared/workflow-api'
import type { WorkflowSystemIntent, WorkflowSystemOutcome } from '../shared/workflow-system'
import type { WorkflowReplicaReference } from '../shared/workflow-replica'
import type { WorkflowGoverningRevision } from './workflow-revisions'
import type { WorkflowAgentInputs } from './workflow-agent-inputs'

export interface WorkflowIntent {
  workflowId: string
  programRevision: string
  taskId: string
  attemptId: string
  callFrameId?: string
  previousAttemptId?: string
  retryCommandId?: string
  replica?: WorkflowReplicaReference
  role: string
  providerId: string
  requestedModel?: string
  createdAt: number
}
export type WorkflowExecutionOwnership = {
  version: 2
  epoch: string
  owner: { pid: number; instanceId: string; state: 'active' | 'closed' }
  segments: Array<{ id: string; generationId?: string; commandId?: string; createdAt: number; mode: 'start' | 'continue' | 'retry' | 'revision'; retry?: WorkflowRetryTarget; expectedRevision?: number }>
}

export interface WorkflowStoreRecord {
  preview: WorkflowPlanPreview
  revisions?: WorkflowGoverningRevision[]
  agentInputs?: Record<string, WorkflowAgentInputs>
  executionStarted?: number
  execution?: WorkflowExecutionOwnership
  /** Durable user intents only. Presence never proves a native signal or settlement. */
  stopRequests?: Array<{ commandId: string; requestedAt: number }>
  receipt?: { commandId: string; fingerprint: string; status: 'accepted' | 'completed' | 'failed' | 'unknown' }
  progress: WorkflowProgress
  intents: WorkflowIntent[]
  outcomes: WorkflowAttemptOutcome[]
  systemIntents?: WorkflowSystemIntent[]
  systemOutcomes?: WorkflowSystemOutcome[]
}
export interface WorkflowPlanningIntent {
  workflowId: string
  commandId?: string
  command?: string
  fingerprint?: string
  role: string
  providerId: string
  agentProfileId?: string
  requestedModel?: string
  workspace: string
  goal: string
  createdAt: number
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'stopped'
  scopeSettled?: boolean
  providerDispatch?: 'not_attempted'
  /** Durable shutdown/cancel intent. It does not prove planner settlement. */
  stopCommandId?: string
  stopRequestedAt?: number
  result?: { output?: string; outputRef?: string; actualModel?: string; archiveRef?: string }
  error?: string
}
export interface WorkflowStorePage { records: WorkflowStoreRecord[]; nextCursor?: string }
export type WorkflowFrameValueCheckpoint = {
  field: 'resultRef' | 'sourceRef'
  key: string
  evaluation: WorkflowEvaluation
}
export interface WorkflowStore {
  create(record: WorkflowStoreRecord): Promise<boolean>
  save(record: WorkflowStoreRecord): Promise<void>
  claim(record: WorkflowStoreRecord, expectedFingerprint: string | undefined): Promise<void>
  loadOutput(workflowId: string, outcome: WorkflowAttemptOutcome): Promise<string | undefined>
  saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number): Promise<WorkflowControlFrame>
  saveFrameWithValue(frame: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number, checkpoint: WorkflowFrameValueCheckpoint): Promise<WorkflowControlFrame>
  loadFrame(workflowId: string, frameId: string): Promise<WorkflowControlFrame | undefined>
  saveValue(workflowId: string, key: string, evaluation: WorkflowEvaluation): Promise<WorkflowValueReference>
  loadValue(workflowId: string, reference: WorkflowValueReference): Promise<WorkflowEvaluation>
  saveCollection(workflowId: string, key: string, entries: WorkflowCollectionEntry[], sealed: boolean): Promise<WorkflowCollectionReference>
  loadCollection(workflowId: string, reference: WorkflowCollectionReference): Promise<WorkflowCollectionEntry[]>
  savePlanningIntent(intent: WorkflowPlanningIntent): Promise<void>
  loadPlanningIntent(workflowId: string): Promise<WorkflowPlanningIntent | undefined>
  planningIntents(): AsyncIterable<WorkflowPlanningIntent>
  /** Output bodies are immutable artifacts, not part of a history page. */
  load(workflowId: string): Promise<WorkflowStoreRecord | undefined>
  listPage(cursor?: string, limit?: number): Promise<WorkflowStorePage>
}
