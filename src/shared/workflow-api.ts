import type { WorkflowTemplateApi, WorkflowTemplateInstantiation, WorkflowTemplateExtraction, WorkflowTemplateDraft } from './workflow-template'
import type { WorkflowApproval, WorkflowBlock, WorkflowPlanPreview, WorkflowProgress, WorkflowProgressPage, WorkflowRoleBinding } from './workflow.js'

export type WorkflowResumeResult =
  | { state: 'continued'; progress: WorkflowProgress }
  | { state: 'nothing_to_resume'; progress: WorkflowProgress | null }

/** Exact observed failure and durable state version; never an effect receipt. */
export type WorkflowRetryTarget = { taskId: string; attemptId: string; expectedRevision: number }

export type WorkflowRevisionTarget = { expectedRevision: number }

/** Editable source only. Workspace, runtime identity and native authorization are main-owned. */
export interface WorkflowRevisionDraft extends WorkflowRevisionTarget {
  workflowId: string
  userGoal: string
  roles: Omit<WorkflowRoleBinding, 'runtimeIdentity'>[]
  body: WorkflowBlock
}

export interface WorkflowApi {
  templates: WorkflowTemplateApi
  extractTemplate(request: WorkflowTemplateExtraction): Promise<WorkflowTemplateDraft>
  instantiateTemplate(request: WorkflowTemplateInstantiation): Promise<WorkflowPlanPreview>
  plan(request: { command: string; cwd: string; commandId?: string; orchestrator: WorkflowRoleBinding; roles: WorkflowRoleBinding[] }): Promise<WorkflowPlanPreview>
  preview(workflowId: string): Promise<WorkflowPlanPreview>
  approve(approval: WorkflowApproval): Promise<true>
  start(workflowId: string, approval: WorkflowApproval, commandId?: string): Promise<WorkflowProgress>
  /** Explicitly continue unstarted work; never replay unknown or failed effects. */
  resume(workflowId: string, approval: WorkflowApproval, commandId: string): Promise<WorkflowResumeResult>
  /** Explicit same-revision retry, currently only proven pre-Provider failures in static programs. */
  retry(workflowId: string, approval: WorkflowApproval, target: WorkflowRetryTarget, commandId: string): Promise<WorkflowProgress>
  /** Compile and freeze a candidate without running its program or changing the root. */
  prepareRevision(draft: WorkflowRevisionDraft): Promise<WorkflowPlanPreview>
  /** Explicit approval of a main-prepared candidate; command redelivery never redispatches. */
  revise(workflowId: string, approval: WorkflowApproval, target: WorkflowRevisionTarget, commandId: string): Promise<WorkflowProgress>
  /** true acknowledges a durable stop intent, not a native signal or scope settlement.
   * Re-delivery must reuse commandId; an explicit stop-again uses a new identity. */
  stop(workflowId: string, commandId: string): Promise<boolean>
  cancelPlanning(commandId: string): Promise<boolean>
  list(cwd: string, cursor?: string): Promise<WorkflowProgressPage>
  snapshot(workflowId: string): Promise<WorkflowProgress | null>
  onProgress(callback: (progress: WorkflowProgress) => void): () => void
}
