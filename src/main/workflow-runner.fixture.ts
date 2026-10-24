import type { WorkflowApproval, WorkflowPlanPreview } from '../shared/workflow'
import { validateWorkflowProgram, workflowRevision } from './workflow-program'

// Scheduler fixtures use the same normalized, content-addressed program contract
// as compiled plans. The original dispatch/stop assertions remain unchanged.
export function workflowFixtureApproval(plan: WorkflowPlanPreview): WorkflowApproval {
  const { programRevision: _revision, ...program } = validateWorkflowProgram(plan.program)
  plan.programRevision = workflowRevision(program)
  plan.program = { ...program, programRevision: plan.programRevision }
  return { workflowId: plan.workflowId, programRevision: plan.programRevision, approvedAt: 1 }
}
