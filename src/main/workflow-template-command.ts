import type { ScryTaskCommand } from '../shared/task-command'
import type { WorkflowValue } from '../shared/workflow'
import type { WorkflowTemplateDefinition, WorkflowTemplateRef, WorkflowTemplateScope, WorkflowTemplateSnapshot } from '../shared/workflow-template'
import { workflowTemplateCopy as copy } from '../shared/constants/copy'
import { assertWorkflowValue } from './workflow-expressions'
import { templateBody } from './workflow-template-instance'
import type { WorkflowTemplateStore } from './workflow-template-store'

type ResolvedTemplateCommand =
  | { kind: 'resolved'; ref: WorkflowTemplateRef; definition: WorkflowTemplateDefinition; parameters: Record<string, WorkflowValue> }
  | { kind: 'rejected'; error: string }

/** Workspace comes from the already-authorized Main conversation, never a
 * renderer path. A bare ID requires one source across the three fixed scopes. */
export async function resolveWorkflowTemplateCommand(store: Pick<WorkflowTemplateStore, 'read'>,
  workspace: string, command: Extract<ScryTaskCommand, { kind: 'template' }>): Promise<ResolvedTemplateCommand> {
  let parameters: unknown
  try {
    parameters = JSON.parse(command.input)
    assertWorkflowValue(parameters)
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return { kind: 'rejected', error: copy.parameterJson }
  } catch (error) {
    return { kind: 'rejected', error: error instanceof SyntaxError ? copy.parameterJson : error instanceof Error ? error.message : String(error) }
  }
  const selected = await resolveWorkflowTemplateEdit(store, workspace, command)
  if (selected.kind === 'rejected') return selected
  const snapshot = selected.snapshot!
  if (snapshot.state !== 'valid') return { kind: 'rejected', error: snapshot.error }
  try { templateBody(snapshot.definition, parameters) }
  catch (error) { return { kind: 'rejected', error: error instanceof Error ? error.message : String(error) } }
  // read() has already sealed these exact source bytes in App-owned history.
  return { kind: 'resolved', ref: snapshot.ref, definition: snapshot.definition, parameters: structuredClone(parameters) }
}

/** An edit may inspect invalid source; it never instantiates, writes or grants execution. */
export async function resolveWorkflowTemplateEdit(store: Pick<WorkflowTemplateStore, 'read'>, workspace: string,
  target?: import('../shared/workflow-route').WorkflowTemplateEditTarget): Promise<
    { kind: 'resolved'; snapshot?: WorkflowTemplateSnapshot } | { kind: 'rejected'; error: string }> {
  if (!target) return { kind: 'resolved' }
  const command = target
  const scope = (kind: 'builtin' | 'personal' | 'project'): WorkflowTemplateScope => kind === 'project' ? { kind, workspace } : { kind }
  const scopes = command.scope ? [scope(command.scope)] : [scope('builtin'), scope('personal'), scope('project')]
  const observations = await Promise.all(scopes.map(source => store.read(source, command.templateId)))
  // Invalid observations still occupy their source. Never silently prefer a
  // valid personal copy over a conflicting, invalid project definition.
  const matches = observations.filter(snapshot => snapshot !== null)
  if (matches.length === 0) return { kind: 'rejected', error: copy.missing }
  if (matches.length !== 1) return { kind: 'rejected', error: copy.ambiguousScope }
  return { kind: 'resolved', snapshot: matches[0] }
}
