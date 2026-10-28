import type { WorkflowAttemptOutcome, WorkflowCollectionEntry, WorkflowCollectionReference, WorkflowControlFrame, WorkflowEvaluation, WorkflowPlanPreview, WorkflowProgress, WorkflowStopProvenance, WorkflowValueReference } from '../shared/workflow'
import type { WorkflowSizeGuideline, WorkflowSizeSnapshot } from '../shared/workflow-size'
import type { WorkflowRetryTarget, WorkflowStopTarget } from '../shared/workflow-api'
import type { WorkflowSystemIntent, WorkflowSystemOutcome } from '../shared/workflow-system'
import type { WorkflowClassifierIntent, WorkflowClassifierOutcome } from '../shared/workflow-classifier'
import type { WorkflowReplicaReference } from '../shared/workflow-replica'
import type { WorkflowGoverningRevision } from './workflow-revisions'
import type { WorkflowAgentInputs } from './workflow-agent-inputs'
import type { ProviderStructuredOutput } from './providers/types'

export interface WorkflowIntent {
  workflowId: string
  programRevision: string
  taskId: string
  attemptId: string
  /** Canonical frame at admission; missing on legacy intents. */
  frameId?: string
  callFrameId?: string
  previousAttemptId?: string
  retryCommandId?: string
  restartCommandId?: string
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
  segments: Array<{ id: string; generationId?: string; commandId?: string; createdAt: number; mode: 'start' | 'continue' | 'retry' | 'restart' | 'revision'; retry?: WorkflowRetryTarget; restart?: { taskId: string; attemptId: string; expectedRevision: number; reason: 'stalled' | 'reply_lost' }; expectedRevision?: number }>
}

export interface WorkflowStoreRecord {
  /** Written atomically with the admitted root; correlation evidence, not execution approval. */
  planningRequestHash?: string
  preview: WorkflowPlanPreview
  revisions?: WorkflowGoverningRevision[]
  agentInputs?: Record<string, WorkflowAgentInputs>
  executionStarted?: number
  execution?: WorkflowExecutionOwnership
  /** Durable user intents only. Presence never proves a native signal or settlement. */
  stopRequests?: Array<{ commandId: string; requestedAt: number; target?: WorkflowStopTarget; provenance?: WorkflowStopProvenance }>
  receipt?: { commandId: string; fingerprint: string; status: 'accepted' | 'completed' | 'failed' | 'unknown' }
  progress: WorkflowProgress
  intents: WorkflowIntent[]
  outcomes: WorkflowAttemptOutcome[]
  systemIntents?: WorkflowSystemIntent[]
  systemOutcomes?: WorkflowSystemOutcome[]
  classifierIntents?: WorkflowClassifierIntent[]
  classifierOutcomes?: WorkflowClassifierOutcome[]
}
export interface WorkflowPlanningIntent {
  workflowId: string
  readonly sizeGuideline?: WorkflowSizeSnapshot
  sizeOverrideReason?: string
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
  result?: { output?: string; outputRef?: string; outputSource?: ProviderStructuredOutput['source']; actualModel?: string; archiveRef?: string }
  /** Durable routing decision for an ordinary message. Absent means the intent
   *  was an explicit single-workflow planning call, not a routed one. */
  route?: 'direct' | 'clarification' | 'workflow' | 'template_edit'
  routeTarget?: import('../shared/workflow-route').WorkflowTemplateEditTarget
  /** The exact question shown to the user for a `clarification` decision. */
  routeQuestion?: string
  error?: string
}
export interface WorkflowStorePage { records: WorkflowStoreRecord[]; nextCursor?: string }
export type WorkflowFrameValueCheckpoint = {
  field: 'resultRef' | 'sourceRef'
  key: string
  evaluation: WorkflowEvaluation
}
export interface WorkflowStore {
  sizeGuideline(): Promise<WorkflowSizeSnapshot>
  setSizeGuideline(value: WorkflowSizeGuideline | null): Promise<WorkflowSizeSnapshot>
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
