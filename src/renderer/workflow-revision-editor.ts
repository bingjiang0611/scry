import type { WorkflowPlanPreview } from '@shared/workflow'
import type { WorkflowRevisionDraft } from '@shared/workflow-api'
import { workflowSystemSourceBody } from '@shared/workflow-source'
import { WORKFLOW_REVISION_COPY as copy } from './constants/copy'

export function workflowRevisionSource(preview: WorkflowPlanPreview): string {
  return JSON.stringify({ userGoal: preview.userGoal,
    roles: preview.program.roles.map(({ runtimeIdentity: _identity, ...role }) => role),
    body: workflowSystemSourceBody(preview.program.body) }, null, 2)
}

/** Parse editable JSON, not execution authority. Main still compiles all nodes,
 * resolves runtimes, and freezes native checks before returning a candidate. */
export function workflowRevisionDraft(workflowId: string, expectedRevision: number, text: string): WorkflowRevisionDraft {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(copy.invalidSource) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.invalidSource)
  const source = value as Record<string, unknown>
  if (Object.keys(source).length !== 3 || Object.keys(source).some(key => !['userGoal', 'roles', 'body'].includes(key)) ||
    typeof source.userGoal !== 'string' || !Array.isArray(source.roles) || !source.body || typeof source.body !== 'object') throw new Error(copy.invalidSource)
  return { workflowId, expectedRevision, userGoal: source.userGoal,
    roles: source.roles as WorkflowRevisionDraft['roles'], body: source.body as WorkflowRevisionDraft['body'] }
}
