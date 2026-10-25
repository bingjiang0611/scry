import type { WorkflowRevisionDraft, WorkflowRevisionTarget } from '../shared/workflow-api'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { validateWorkflowRoleBinding } from './workflow-program'

export function validateWorkflowRevisionTarget(value: unknown): WorkflowRevisionTarget {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('expectedRevision' in value) ||
    !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw new Error(copy.stale)
  return { expectedRevision: value.expectedRevision as number }
}

/** The compiler validates the body. This envelope admits no workspace, frozen
 * runtime, template claim, capability envelope or execution authorization. */
export function validateWorkflowRevisionDraft(value: unknown): WorkflowRevisionDraft {
  if (!value || typeof value !== 'object') throw new Error(copy.draftInvalid)
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['workflowId', 'expectedRevision', 'userGoal', 'roles', 'body'].includes(key)) ||
    typeof input.workflowId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(input.workflowId) ||
    typeof input.userGoal !== 'string' || !input.userGoal.trim() || input.userGoal.length > 16_000 ||
    !Array.isArray(input.roles) || !input.roles.length || input.roles.length > 4 ||
    !input.body || typeof input.body !== 'object') throw new Error(copy.draftInvalid)
  const roles = input.roles.map((role, index) => validateWorkflowRoleBinding(role, index))
  if (new Set(roles.map(role => role.role)).size !== roles.length || !roles.some(role => role.role === 'orchestrator')) throw new Error(copy.draftInvalid)
  return { workflowId: input.workflowId, ...validateWorkflowRevisionTarget({ expectedRevision: input.expectedRevision }),
    userGoal: input.userGoal.trim(), roles, body: input.body as WorkflowRevisionDraft['body'] }
}
