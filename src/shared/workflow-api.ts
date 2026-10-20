import type { WorkflowApproval, WorkflowPlanPreview, WorkflowProgress, WorkflowProgressPage, WorkflowRoleBinding } from './workflow.js'

export interface WorkflowApi {
  plan(request: { command: string; cwd: string; commandId?: string; orchestrator: WorkflowRoleBinding; roles: WorkflowRoleBinding[] }): Promise<WorkflowPlanPreview>
  preview(workflowId: string): Promise<WorkflowPlanPreview>
  approve(approval: WorkflowApproval): Promise<true>
  start(workflowId: string, approval: WorkflowApproval, commandId?: string): Promise<WorkflowProgress>
  stop(workflowId: string): Promise<boolean>
  cancelPlanning(commandId: string): Promise<boolean>
  list(cwd: string, cursor?: string): Promise<WorkflowProgressPage>
  snapshot(workflowId: string): Promise<WorkflowProgress | null>
  onProgress(callback: (progress: WorkflowProgress) => void): () => void
}
