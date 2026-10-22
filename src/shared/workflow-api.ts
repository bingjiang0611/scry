import type { WorkflowTemplateApi } from './workflow-template'
import type { WorkflowApproval, WorkflowPlanPreview, WorkflowProgress, WorkflowProgressPage, WorkflowRoleBinding } from './workflow.js'

export type WorkflowResumeResult =
  | { state: 'continued'; progress: WorkflowProgress }
  | { state: 'nothing_to_resume'; progress: WorkflowProgress | null }

export interface WorkflowApi {
  templates: WorkflowTemplateApi
  plan(request: { command: string; cwd: string; commandId?: string; orchestrator: WorkflowRoleBinding; roles: WorkflowRoleBinding[] }): Promise<WorkflowPlanPreview>
  preview(workflowId: string): Promise<WorkflowPlanPreview>
  approve(approval: WorkflowApproval): Promise<true>
  start(workflowId: string, approval: WorkflowApproval, commandId?: string): Promise<WorkflowProgress>
  /** Explicitly continue unstarted work; never replay unknown or failed effects. */
  resume(workflowId: string, approval: WorkflowApproval, commandId: string): Promise<WorkflowResumeResult>
  /** true acknowledges a durable stop intent, not a native signal or scope settlement.
   * Re-delivery must reuse commandId; an explicit stop-again uses a new identity. */
  stop(workflowId: string, commandId: string): Promise<boolean>
  cancelPlanning(commandId: string): Promise<boolean>
  list(cwd: string, cursor?: string): Promise<WorkflowProgressPage>
  snapshot(workflowId: string): Promise<WorkflowProgress | null>
  onProgress(callback: (progress: WorkflowProgress) => void): () => void
}
