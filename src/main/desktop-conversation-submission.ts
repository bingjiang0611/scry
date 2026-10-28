import type { Conversation } from '../shared/conversation'
import type { ConversationSubmissionResult } from '../shared/conversation-api'
import { SCRY_WORKFLOW_COMMAND_ID, type ResolvedTaskCommand } from '../shared/task-command'
import type { WorkflowSizeGuideline, WorkflowSizeSnapshot } from '../shared/workflow-size'
import { isCommandId } from '../shared/runtime'
import { taskCommandCopy as copy, taskSubmissionCopy } from '../shared/constants/copy'
import { WORKFLOW_MODE_COPY } from '../shared/constants/workflow-mode-copy'
import type { WorkflowConversationMode, WorkflowRoutingMode } from '../shared/workflow-mode'
import { parseWorkflowTemplateEditTarget, type WorkflowRouteResult } from '../shared/workflow-route'
import { isProviderId, type ProviderId } from '../shared/provider'
import { idPattern } from './conversation-record'
import { requestObject } from './conversation-request'
import type { createDesktopTaskEntry } from './desktop-task-entry'
import type { createDesktopWorkflowTaskEntry } from './desktop-workflow-task-entry'
import { createTaskCommandCatalog, resolveTaskCommand, TaskCommandResolutionError } from './task-command'

const messageFields = ['providerId', 'agentProfileId', 'model', 'effort', 'permissionMode',
  'expectedContinuationKey', 'attachments', 'selectedItems', 'confirmFresh', 'workflowOverride']

/** Only envelope fields are decoded here. The existing direct-entry decoder
 * owns attachment/reference normalization; do not decode large image bodies a
 * third time merely to determine which source the user selected. */
export function parseDesktopConversationSubmission(input: unknown) {
  const value = requestObject(input, ['conversationId', 'expectedRevision', 'commandId', 'prompt', 'selectedCommandId', 'message'])
  if (typeof value.conversationId !== 'string' || !idPattern.test(value.conversationId) ||
    !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 ||
    typeof value.commandId !== 'string' || !isCommandId(value.commandId) || typeof value.prompt !== 'string' ||
    (value.selectedCommandId !== undefined && (typeof value.selectedCommandId !== 'string' ||
      !value.selectedCommandId || value.selectedCommandId.length > 256))) throw new Error(copy.invalid)
  return {
    conversationId: value.conversationId, expectedRevision: Number(value.expectedRevision),
    commandId: value.commandId, prompt: value.prompt, selectedCommandId: value.selectedCommandId as string | undefined,
    message: value.message === undefined ? undefined : requestObject(value.message, messageFields)
  }
}

type DesktopSubmission = ReturnType<typeof parseDesktopConversationSubmission>

/** Main's single typed submission dispatcher. Source choice precedes any run
 * reservation. Settings/list are controls, not execution roots or model calls.
 * Legacy send remains a plain-only API; neither API trusts renderer origin. */
export async function submitDesktopConversation(conversation: Conversation, request: DesktopSubmission, deps: {
  entry: Pick<ReturnType<typeof createDesktopTaskEntry>, 'commands' | 'submit' | 'captureWorkflow'>
  templateTasks: Pick<ReturnType<typeof createDesktopWorkflowTaskEntry>, 'captureTemplate'>
  editTasks: Pick<ReturnType<typeof createDesktopWorkflowTaskEntry>, 'captureEdit'>
  setSizeGuideline: (value: WorkflowSizeGuideline | null) => Promise<WorkflowSizeSnapshot>
  setWorkflowMode: (conversationId: string, expectedRevision: number, mode: WorkflowConversationMode) => Promise<Conversation>
  editTemplate: (workspace: string, target?: import('../shared/workflow-route').WorkflowTemplateEditTarget) => ReturnType<typeof import('./workflow-template-command').resolveWorkflowTemplateEdit>
  routeWorkflow: (conversation: Conversation, input: { prompt: string; commandId: string; providerId: ProviderId; agentProfileId?: string; routingMode: WorkflowRoutingMode }) => Promise<WorkflowRouteResult>
}): Promise<ConversationSubmissionResult> {
  if (conversation.id !== request.conversationId) throw new Error(copy.stale)
  if (conversation.deletion) throw new Error(taskSubmissionCopy.conversationDeleting)
  const scope = { conversationId: conversation.id, cwd: conversation.cwd }
  let catalog = createTaskCommandCatalog(scope)
  if (request.prompt.trimStart().startsWith('/') && request.selectedCommandId !== SCRY_WORKFLOW_COMMAND_ID) {
    if (!request.message?.providerId) return { kind: 'needs_native_context' }
    const { providerId, agentProfileId, model, effort, permissionMode } = request.message
    catalog = await deps.entry.commands(conversation, { providerId, agentProfileId, model, effort, permissionMode })
  }
  let resolved: ResolvedTaskCommand
  try { resolved = resolveTaskCommand(request.prompt, catalog, request.selectedCommandId) } catch (error) {
    // These are resolution-only failures, before settings or actor effects.
    // Do not classify later Store/dispatch exceptions as safe-to-retry.
    if (!(error instanceof TaskCommandResolutionError)) throw error
    return error.code === 'source_required' ? { kind: 'needs_command_source', catalog } : { kind: 'rejected', error: error.message }
  }
  if (resolved.kind === 'provider') return { kind: 'rejected', error: copy.actionUnavailable }
  if (conversation.archivedAt) return { kind: 'rejected', error: taskSubmissionCopy.conversationArchived }
  if (conversation.revision !== request.expectedRevision) return { kind: 'rejected', error: taskSubmissionCopy.conversationChanged }
  const edit = async (instruction: string, target?: import('../shared/workflow-route').WorkflowTemplateEditTarget): Promise<ConversationSubmissionResult> => {
    const normalizedTarget = target ? parseWorkflowTemplateEditTarget({ templateId: target.templateId,
      ...(target.scope ? { scope: target.scope } : {}) }) : undefined
    const selected = await deps.editTemplate(conversation.cwd, normalizedTarget)
    if (selected.kind === 'rejected') return selected
    const captured = await deps.editTasks.captureEdit(conversation, request, instruction, normalizedTarget, selected.snapshot)
    if (captured.kind === 'rejected') return captured
    return { kind: 'control', commandId: request.commandId, action: 'edit_workflow_template',
      workspace: captured.workspace, submission: captured.submission, edit: captured.edit }
  }
  if (resolved.kind === 'scry_workflow' && (resolved.command.kind === 'list' || resolved.command.kind === 'size' || resolved.command.kind === 'mode' ||
      resolved.command.kind === 'run' || resolved.command.kind === 'template' || resolved.command.kind === 'edit')) {
    if (request.message?.attachments !== undefined &&
      (!Array.isArray(request.message.attachments) || request.message.attachments.length !== 0)) return { kind: 'rejected', error: copy.controlContext }
    if (request.message?.selectedItems !== undefined &&
      (!Array.isArray(request.message.selectedItems) || request.message.selectedItems.length !== 0)) return { kind: 'rejected', error: copy.controlContext }
    if (resolved.command.kind === 'run') {
      if (request.prompt.length > 16_000) return { kind: 'rejected', error: copy.invalid }
      const captured = await deps.entry.captureWorkflow(conversation, request)
      if (captured.kind === 'rejected') return captured
      return { kind: 'control', commandId: request.commandId, action: 'open_workflow_planner', command: request.prompt,
        workspace: captured.workspace, submission: captured.submission }
    }
    if (resolved.command.kind === 'template') {
      if (request.prompt.length > 16_000) return { kind: 'rejected', error: copy.invalid }
      const captured = await deps.templateTasks.captureTemplate(conversation, request, resolved.command)
      if (captured.kind === 'rejected') return captured
      return { kind: 'control', commandId: request.commandId, action: 'open_workflow_template', command: request.prompt,
        workspace: captured.workspace, submission: captured.submission }
    }
    if (resolved.command.kind === 'edit') {
      if (request.prompt.length > 16_000) return { kind: 'rejected', error: copy.invalid }
      return edit(resolved.command.input, resolved.command)
    }
    if (resolved.command.kind === 'list') return { kind: 'control', commandId: request.commandId, action: 'open_workflows' }
    if (resolved.command.kind === 'mode') {
      const updated = await deps.setWorkflowMode(conversation.id, request.expectedRevision, resolved.command.mode)
      return { kind: 'control', commandId: request.commandId, action: 'mode_updated', mode: updated.workflowMode ?? 'off' }
    }
    if (resolved.command.kind === 'size') {
      const snapshot = await deps.setSizeGuideline(resolved.command.value === 'default' ? null : resolved.command.value)
      return { kind: 'control', commandId: request.commandId, action: 'size_updated', snapshot }
    }
  }
  if (resolved.kind === 'scry_workflow' && resolved.command.kind !== 'direct') return { kind: 'rejected', error: copy.actionUnavailable }
  if (!request.message?.providerId) return { kind: 'needs_native_context' }
  const { conversationId, expectedRevision, commandId, prompt } = request
  // Recognizing natural language spends one routing call before dispatch. Commands above
  // already carry an explicit intent, so they never pay for routing twice.
  // The message is a partial transport shape; only these two identity fields
  // are needed for routing, and each must be a bounded string.
  const providerId = request.message.providerId
  if (!isProviderId(providerId)) return { kind: 'needs_native_context' }
  const agentProfileId = typeof request.message.agentProfileId === 'string' ? request.message.agentProfileId : undefined
  // A per-send override lives only in this request: it is consumed here and can
  // never change the conversation's stored mode.
  // The only Scry command reaching this branch is explicit `direct`. It wins
  // over a pending UI choice and auto mode; it never needs routing consent.
  const override = resolved.kind === 'scry_workflow' ? 'direct' : request.message.workflowOverride
  if (override !== undefined && override !== 'direct' && override !== 'workflow') return { kind: 'rejected', error: WORKFLOW_MODE_COPY.invalid }
  if (override === 'workflow') {
    if ((request.message.attachments !== undefined && (!Array.isArray(request.message.attachments) || request.message.attachments.length !== 0)) ||
      (request.message.selectedItems !== undefined && (!Array.isArray(request.message.selectedItems) || request.message.selectedItems.length !== 0))) return { kind: 'rejected', error: copy.controlContext }
    const command = `/scry-workflow run ${prompt}`
    const captured = await deps.entry.captureWorkflow(conversation, { ...request, prompt: command })
    if (captured.kind === 'rejected') return captured
    return { kind: 'control', commandId, action: 'open_workflow_planner', command, workspace: captured.workspace, submission: captured.submission }
  }
  const mode = conversation.workflowMode ?? 'off'
  if (override !== 'direct' && mode !== 'off') {
    if (!conversation.workflowRoutingConsent) return { kind: 'rejected', error: WORKFLOW_MODE_COPY.consentRequired }
    const routed = await deps.routeWorkflow(conversation, { prompt, commandId, providerId, routingMode: mode,
      ...(agentProfileId ? { agentProfileId } : {}) })
    if (routed.kind === 'template_edit') return edit(prompt, routed.target)
    if (routed.kind === 'clarification') return { kind: 'rejected', error: routed.question }
    if (routed.kind === 'workflow') return { kind: 'control', commandId, action: 'open_workflow_routed', command: prompt, preview: routed.preview }
  }
  // The override is consumed above; the direct send request has no such field.
  const { workflowOverride: _override, ...sendMessage } = request.message
  const result = await deps.entry.submit({ ...sendMessage, conversationId, expectedRevision, commandId, prompt },
    resolved.kind === 'scry_workflow' && resolved.command.kind === 'direct' ? resolved.command.goal : undefined)
  return { kind: 'direct', ...result }
}
