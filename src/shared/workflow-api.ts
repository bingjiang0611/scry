import type { WorkflowTemplateApi, WorkflowTemplateInstantiation, WorkflowTemplateExtraction, WorkflowTemplateDraft, WorkflowTemplateRef } from './workflow-template'
import type { WorkflowApproval, WorkflowBlock, WorkflowControlFrame, WorkflowPlanPreview, WorkflowProgress, WorkflowProgressPage, WorkflowRoleBinding, WorkflowRole } from './workflow.js'
import type { WorkflowExecutionInspection, WorkflowExecutionInspectionRequest } from './workflow-inspection.js'
import type { WorkflowOutputInspection, WorkflowOutputInspectionRequest } from './workflow-output-inspection.js'

/** Main-issued lookup handle only; never workspace, planning or execution authority. */
export type WorkflowTaskReference = Readonly<{ conversationId: string; commandId: string }>
export type WorkflowTaskSize = Readonly<
  { state: 'available'; snapshot: import('./workflow-size').WorkflowSizeSnapshot; readAt: number } |
  { state: 'unavailable'; reason: string; readAt: number }
>
export type WorkflowCapturedTask = Readonly<{
  reference: WorkflowTaskReference
  planningCommandId: string
  size: WorkflowTaskSize
}>

export type WorkflowCapturedTemplateTask = Readonly<{
  reference: WorkflowTaskReference
  instanceCommandId: string
  size: WorkflowTaskSize
  template: Readonly<{ ref: WorkflowTemplateRef } & (
    { state: 'available'; name: string; roles: WorkflowRole[] } |
    { state: 'unavailable'; reason: string }
  )>
}>

export type WorkflowCapturedTemplateEditTask = Readonly<{
  reference: WorkflowTaskReference
  editCommandId: string
  selection: { kind: 'unselected' } | { kind: 'saved'; ref: WorkflowTemplateRef }
}>

/** Read-only intake evidence, not a live run result or dispatch authority. */
export type WorkflowTaskSummary = Readonly<{
  reference: WorkflowTaskReference
  submissionId: string
  phase: 'captured' | 'dispatch_intent' | 'associated' | 'unknown'
  revision: number
  createdAt: number
  operation: 'workflow_run' | 'workflow_template' | 'template_edit'
  size?: WorkflowTaskSize
  workflowId?: string
}>
export type WorkflowTaskPage = Readonly<{ items: WorkflowTaskSummary[]; nextCursor?: string; observedAt: number }>
export type WorkflowPlanningTaskInspection = Readonly<{
  task: WorkflowTaskSummary
  command: string
  workspace: string
  submission: WorkflowCapturedTask
  observedAt: number
  outcome: { kind: 'configure' } |
    { kind: 'blocked'; reason: 'interrupted' | 'unknown' | 'invalid_size' | 'archived' | 'context_changed' } |
    { kind: 'preview'; preview: WorkflowPlanPreview; progressState: WorkflowProgress['state'] }
}>

export type WorkflowTemplateTaskInspection = Omit<WorkflowPlanningTaskInspection, 'submission'> & Readonly<{ submission: WorkflowCapturedTemplateTask }>
export type WorkflowTemplateEditTaskInspection = Readonly<{
  task: WorkflowTaskSummary
  command: string
  instruction: string
  workspace: string
  submission: WorkflowCapturedTemplateEditTask
  edit: import('./workflow-template').WorkflowTemplateEditContext
  authoring: { state: 'none' } | { state: 'available'; attempt: import('./workflow-template').WorkflowTemplateEditCandidateInspection
    history: import('./workflow-template').WorkflowTemplateEditCandidateAttemptSummary[]
    applications: import('./workflow-template').WorkflowTemplateEditApplicationSummary[] }
  observedAt: number
  outcome: { kind: 'configure' } | { kind: 'blocked'; reason: 'archived' | 'context_changed' | 'source_unavailable' }
}>
export type WorkflowTaskInspection = WorkflowPlanningTaskInspection | WorkflowTemplateTaskInspection | WorkflowTemplateEditTaskInspection

export type WorkflowResumeResult =
  | { state: 'continued'; progress: WorkflowProgress }
  | { state: 'nothing_to_resume'; progress: WorkflowProgress | null }

/** Exact observed failure and durable state version; never an effect receipt. */
export type WorkflowRetryTarget = { taskId: string; attemptId: string; expectedRevision: number }
export type WorkflowRestartTarget = { taskId: string; attemptId: string; expectedRevision: number }

export type WorkflowRevisionTarget = { expectedRevision: number }

export type WorkflowFrameInspectionReason = 'root_missing' | 'frame_missing'
export type WorkflowFrameInspection =
  | { state: 'unavailable'; source: 'canonical_frame'; observedAt: number; reason: WorkflowFrameInspectionReason }
  | { state: 'available'; source: 'canonical_frame'; observedAt: number; frame: {
    frameId: string; nodeId: string; programRevision: string; executionEpoch?: string; generationId?: string; originFrameId?: string
    phase: WorkflowControlFrame['phase']
    revision: number; cursor?: number; arm?: 'then' | 'else' | 'unknown'
    parentage: { state: 'root' } | { state: 'available'; frameId: string } | { state: 'unavailable'; reason: 'legacy_parentage' }
  } }

export type WorkflowStopTarget = { kind: 'attempt' | 'system'; id: string }

/** Editable source only. Workspace, runtime identity and native authorization are main-owned. */
export interface WorkflowRevisionDraft extends WorkflowRevisionTarget {
  workflowId: string
  userGoal: string
  roles: Omit<WorkflowRoleBinding, 'runtimeIdentity'>[]
  body: WorkflowBlock
}

export interface WorkflowApi {
  sizeGuideline(): Promise<import('./workflow-size').WorkflowSizeSnapshot>
  setSizeGuideline(value: import('./workflow-size').WorkflowSizeGuideline | null): Promise<import('./workflow-size').WorkflowSizeSnapshot>
  templates: WorkflowTemplateApi
  extractTemplate(request: WorkflowTemplateExtraction): Promise<WorkflowTemplateDraft>
  instantiateTemplate(request: WorkflowTemplateInstantiation): Promise<WorkflowPlanPreview>
  prepareTemplateTask(request: { reference: WorkflowTaskReference; orchestrator: WorkflowRoleBinding; roles: WorkflowRoleBinding[] }): Promise<WorkflowPlanPreview>
  plan(request: { command: string; cwd: string; commandId?: string; submission?: WorkflowTaskReference; orchestrator: WorkflowRoleBinding; roles: WorkflowRoleBinding[] }): Promise<WorkflowPlanPreview>
  capturedTasks(conversationId: string, cursor?: string): Promise<WorkflowTaskPage>
  inspectTask(reference: WorkflowTaskReference): Promise<WorkflowTaskInspection>
  requestTemplateEditCandidate(request: {
    reference: WorkflowTaskReference
    expectedTaskRevision: number
    attemptId: string
    author: import('./workflow-template').WorkflowTemplateEditAuthor
    selection?: WorkflowTemplateRef
    disclosure: { acknowledgesModelCall: true; acknowledgesSourceDisclosure: true }
  }): Promise<import('./workflow-template').WorkflowTemplateEditCandidateInspection>
  applyTemplateEditCandidate(request: {
    reference: WorkflowTaskReference
    expectedTaskRevision: number
    attemptId: string
    commandId: string
    destination: 'personal' | 'project'
  }): Promise<import('./workflow-template').WorkflowTemplateEditCandidateApplication>
  preview(workflowId: string): Promise<WorkflowPlanPreview>
  approve(approval: WorkflowApproval): Promise<true>
  start(workflowId: string, approval: WorkflowApproval, commandId?: string): Promise<WorkflowProgress>
  /** Explicitly continue unstarted work; never replay unknown or failed effects. */
  resume(workflowId: string, approval: WorkflowApproval, commandId: string): Promise<WorkflowResumeResult>
  /** Explicit same-revision retry, currently only proven pre-Provider failures in static programs. */
  retry(workflowId: string, approval: WorkflowApproval, target: WorkflowRetryTarget, commandId: string): Promise<WorkflowProgress>
  restartStalled(workflowId: string, approval: WorkflowApproval, target: WorkflowRestartTarget, commandId: string): Promise<WorkflowProgress>
  /** Compile and freeze a candidate without running its program or changing the root. */
  prepareRevision(draft: WorkflowRevisionDraft): Promise<WorkflowPlanPreview>
  /** Explicit approval of a main-prepared candidate; command redelivery never redispatches. */
  revise(workflowId: string, approval: WorkflowApproval, target: WorkflowRevisionTarget, commandId: string): Promise<WorkflowProgress>
  /** true acknowledges a durable stop intent, not a native signal or scope settlement.
   * Re-delivery must reuse commandId; an explicit stop-again uses a new identity. */
  stop(workflowId: string, commandId: string): Promise<boolean>
  stopNode(workflowId: string, target: WorkflowStopTarget, commandId: string): Promise<boolean>
  cancelPlanning(commandId: string, submission?: WorkflowTaskReference): Promise<boolean>
  list(cwd: string, cursor?: string): Promise<WorkflowProgressPage>
  snapshot(workflowId: string): Promise<WorkflowProgress | null>
  inspectFrame(workflowId: string, frameId: string): Promise<WorkflowFrameInspection>
  inspectExecution(request: WorkflowExecutionInspectionRequest): Promise<WorkflowExecutionInspection>
  inspectOutput(request: WorkflowOutputInspectionRequest): Promise<WorkflowOutputInspection>
  sourceApplications(workflowId: string, programRevision: string): Promise<import('./workflow-source-application').WorkflowSourceApplicationCatalog>
  applySourceApplication(command: import('./workflow-source-application').WorkflowSourceApplicationCommand): Promise<import('./workflow-source-application').WorkflowSourceApplicationReceipt>
  onProgress(callback: (progress: WorkflowProgress) => void): () => void
}
