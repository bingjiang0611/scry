import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ConversationSendRequest, ConversationSubmissionRequest } from '../shared/conversation-api'
import type { WorkflowTaskReference, WorkflowTaskSize, WorkflowTaskSummary } from '../shared/workflow-api'
import { SCRY_WORKFLOW_COMMAND_ID } from '../shared/task-command'
import type { ConversationTarget } from '../shared/conversation'
import type { WorkflowTemplateRef } from '../shared/workflow-template'
import { parseWorkflowTemplateEditTarget, type WorkflowTemplateEditTarget } from '../shared/workflow-route'
import { templateReference } from './workflow-template-identity'
import { isCommandId } from '../shared/runtime'
import { isToolContentRef, type ContentRef } from '../shared/tool-content'
import { validateWorkflowSizeSnapshot } from '../shared/workflow-size'
import { taskSubmissionCopy as copy } from '../shared/constants/copy'
import { hashPattern, idPattern, object, requireValue, target, text } from './conversation-record'

export type TaskDispatchBranch = 'direct' | 'workflow' | 'template_edit'
export type TaskSubmissionKey = WorkflowTaskReference
export type TaskSizeSnapshot = WorkflowTaskSize
export type TaskCapturedContext = Readonly<{
  conversationRevision: number
  target: Readonly<ConversationTarget>
  workspace: Readonly<{ cwd: string; identity: string }>
  size: TaskSizeSnapshot
}>
export type WorkflowTaskContext = Omit<TaskCapturedContext, 'target'>
export type TemplateEditTaskContext = Pick<WorkflowTaskContext, 'conversationRevision' | 'workspace'>
export type TemplateEditTaskSelection = Readonly<{ kind: 'unselected' } | { kind: 'saved'; ref: WorkflowTemplateRef }>
export type TaskSubmissionState = Readonly<
  { kind: 'captured' } |
  { kind: 'dispatch_intent'; branch: TaskDispatchBranch; ownerEpoch: string; planningRequestHash?: string; authoringContinuationKey?: string } |
  { kind: 'associated'; branch: 'direct'; ownerEpoch: string; runId: string } |
  { kind: 'associated'; branch: 'workflow'; ownerEpoch: string; planningRequestHash: string; workflowId: string; programRevision: string; authoringContinuationKey?: string } |
  { kind: 'unknown'; branch: TaskDispatchBranch; ownerEpoch: string; reason: string; runId?: string;
    planningRequestHash?: string; workflowId?: string; programRevision?: string; authoringContinuationKey?: string }
>

/** Main-only intake facts. An association proves a durable turn reference, not
 * Provider entry, business success, settlement or physical process closure. */
type TaskSubmissionHeader = Readonly<{
  submissionId: string
  conversationId: string
  commandId: string
  revision: number
  createdAt: number
  capturedBy: string
}>
export type TaskSubmission = Readonly<TaskSubmissionHeader & (
  { version: 1; state: TaskSubmissionState; snapshot: TaskCapturedContext & Readonly<{
    source: 'desktop_conversation_send'; policy: Readonly<{ mode: 'off'; revision: 0 }>; input: ContentRef; confirmFresh: boolean
  }> } |
  { version: 2; state: TaskSubmissionState; snapshot: WorkflowTaskContext & Readonly<{
    source: 'desktop_conversation_submit'; policy: Readonly<{ mode: 'off'; revision: 0 }>; input: ContentRef
  }> & Readonly<{ operation: 'workflow_run' } | { operation: 'workflow_template'; template: Readonly<WorkflowTemplateRef> }> } |
  { version: 3; state: Readonly<{ kind: 'captured' }>; snapshot: TemplateEditTaskContext & Readonly<{
    source: 'desktop_conversation_submit'; operation: 'template_edit'; policy: Readonly<{ mode: 'off'; revision: 0 }>; input: ContentRef
    target?: WorkflowTemplateEditTarget; selection: TemplateEditTaskSelection
  }> }
)>
export type DirectTaskSubmission = Extract<TaskSubmission, { version: 1 }>
export type WorkflowTaskSubmission = Extract<TaskSubmission, { version: 2 }>
export type TemplateEditTaskSubmission = Extract<TaskSubmission, { version: 3 }>
export type ConfigurationTaskSubmission = WorkflowTaskSubmission | TemplateEditTaskSubmission

export function workflowTaskSummary(task: ConfigurationTaskSubmission): WorkflowTaskSummary {
  const state = task.state
  return { reference: { conversationId: task.conversationId, commandId: task.commandId }, submissionId: task.submissionId,
    phase: state.kind, revision: task.revision, createdAt: task.createdAt,
    operation: task.version === 3 ? 'template_edit' : task.snapshot.operation,
    ...(task.version === 2 ? { size: task.snapshot.size } : {}),
    ...(task.version === 2 && state.kind !== 'captured' && state.branch === 'workflow' && 'workflowId' in state && state.workflowId
      ? { workflowId: state.workflowId } : {}) }
}

export type PreparedTaskInput = Readonly<{ serialized: string; sha256: string }>
export const taskDigest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export function taskSubmissionId(key: TaskSubmissionKey): string {
  requireValue(idPattern.test(key.conversationId) && isCommandId(key.commandId), copy.invalid)
  return `submission-${taskDigest(JSON.stringify([key.conversationId, key.commandId]))}`
}

/** Revisions and the fresh-session acknowledgement are transport/preflight
 * facts, not a new message. Preserve the existing durable duplicate semantics.
 * Image bytes remain in the normal attachment path; this frozen body retains
 * their exact base64-text digests and requested metadata, never an arbitrary path. */
export function prepareTaskInput(request: ConversationSendRequest,
  command?: Readonly<{ id: string; origin: 'scry_workflow'; operation: 'direct' }>): PreparedTaskInput {
  const serialized = JSON.stringify({
    version: 1,
    conversationId: request.conversationId,
    commandId: request.commandId,
    originalGoal: request.prompt,
    ...(command ? { command } : {}),
    target: {
      providerId: request.providerId,
      agentProfileId: request.agentProfileId,
      expectedContinuationKey: request.expectedContinuationKey,
      model: request.model,
      effort: request.effort,
      permissionMode: request.permissionMode
    },
    attachments: request.attachments?.map(({ dataBase64, path: _path, ...metadata }) => ({
      ...metadata, base64TextSha256: taskDigest(dataBase64)
    })) ?? [],
    selectedItems: request.selectedItems
  })
  return { serialized, sha256: taskDigest(serialized) }
}

/** Explicit workflow configuration has no native runtime yet. Never fabricate a
 * Provider, continuation key, model or account to capture the original input. */
export function prepareWorkflowTaskInput(request: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'prompt'>, template?: WorkflowTemplateRef): PreparedTaskInput {
  const serialized = JSON.stringify({ version: 2, conversationId: request.conversationId, commandId: request.commandId,
    originalGoal: request.prompt, command: { id: SCRY_WORKFLOW_COMMAND_ID, origin: 'scry_workflow', operation: template ? 'template' : 'run',
      ...(template ? { template: templateReference(template) } : {}) } })
  return { serialized, sha256: taskDigest(serialized) }
}

export function prepareTemplateEditTaskInput(
  request: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'prompt'>,
  instruction: string,
  target: WorkflowTemplateEditTarget | undefined,
  selection: TemplateEditTaskSelection
): PreparedTaskInput {
  requireValue(instruction.length > 0 && instruction.length <= 16_000, copy.invalid)
  const serialized = JSON.stringify({ version: 3, conversationId: request.conversationId, commandId: request.commandId,
    originalGoal: request.prompt, instruction,
    command: { id: SCRY_WORKFLOW_COMMAND_ID, origin: 'scry_workflow', operation: 'template_edit',
      ...(target ? { target: structuredClone(target) } : {}), selection: structuredClone(selection) } })
  return { serialized, sha256: taskDigest(serialized) }
}

export function parseWorkflowTaskReference(value: unknown): TaskSubmissionKey {
  const input = object(value)
  exactKeys(input, ['conversationId', 'commandId'])
  const key = { conversationId: input.conversationId as string, commandId: input.commandId as string }
  taskSubmissionId(key)
  return key
}

function exactKeys(value: Record<string, unknown>, fields: string[]): void {
  requireValue(Object.keys(value).every(key => fields.includes(key)), copy.invalid)
}
function counter(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function branch(value: unknown): value is TaskDispatchBranch {
  return value === 'direct' || value === 'workflow' || value === 'template_edit'
}

export function decodeTaskSubmission(value: unknown): TaskSubmission {
  const data = object(value)
  exactKeys(data, ['version', 'submissionId', 'conversationId', 'commandId', 'revision', 'createdAt', 'capturedBy', 'snapshot', 'state'])
  requireValue((data.version === 1 || data.version === 2 || data.version === 3) && typeof data.conversationId === 'string' && idPattern.test(data.conversationId) &&
    typeof data.commandId === 'string' && isCommandId(data.commandId), copy.invalid)
  requireValue(data.submissionId === taskSubmissionId({ conversationId: data.conversationId, commandId: data.commandId }), copy.invalid)
  requireValue(counter(data.revision) && counter(data.createdAt) && text(data.capturedBy), copy.invalid)
  const snapshot = object(data.snapshot)
  if (data.version === 1) {
    exactKeys(snapshot, ['source', 'policy', 'input', 'confirmFresh', 'conversationRevision', 'target', 'workspace', 'size'])
    requireValue(snapshot.source === 'desktop_conversation_send' && typeof snapshot.confirmFresh === 'boolean', copy.invalid)
    target(snapshot.target)
    exactKeys(object(snapshot.target), ['providerId', 'agentProfileId', 'continuationKey'])
  } else if (data.version === 2) {
    exactKeys(snapshot, ['source', 'operation', 'policy', 'input', 'conversationRevision', 'workspace', 'size',
      ...(snapshot.operation === 'workflow_template' ? ['template'] : [])])
    requireValue(snapshot.source === 'desktop_conversation_submit' && (snapshot.operation === 'workflow_run' || snapshot.operation === 'workflow_template'), copy.invalid)
    if (snapshot.operation === 'workflow_template') templateReference(snapshot.template)
  } else {
    exactKeys(snapshot, ['source', 'operation', 'policy', 'input', 'conversationRevision', 'workspace', 'selection',
      ...(snapshot.target === undefined ? [] : ['target'])])
    requireValue(snapshot.source === 'desktop_conversation_submit' && snapshot.operation === 'template_edit', copy.invalid)
    if (snapshot.target !== undefined) parseWorkflowTemplateEditTarget(snapshot.target)
    const selection = object(snapshot.selection)
    if (selection.kind === 'unselected') exactKeys(selection, ['kind'])
    else {
      exactKeys(selection, ['kind', 'ref'])
      requireValue(selection.kind === 'saved', copy.invalid)
      templateReference(selection.ref)
    }
  }
  requireValue(counter(snapshot.conversationRevision), copy.invalid)
  const policy = object(snapshot.policy)
  exactKeys(policy, ['mode', 'revision'])
  requireValue(policy.mode === 'off' && policy.revision === 0, copy.invalid)
  requireValue(isToolContentRef(snapshot.input) && snapshot.input.encoding === 'json', copy.invalid)
  const workspace = object(snapshot.workspace)
  exactKeys(workspace, ['cwd', 'identity'])
  requireValue(typeof workspace.cwd === 'string' && isAbsolute(workspace.cwd) &&
    typeof workspace.identity === 'string' && hashPattern.test(workspace.identity), copy.invalid)
  if (data.version === 2 && snapshot.operation === 'workflow_template') {
    const ref = templateReference(snapshot.template)
    requireValue(ref.scope.kind !== 'project' || ref.scope.workspace === workspace.cwd, copy.invalid)
  }
  if (data.version === 3 && object(snapshot.selection).kind === 'saved') {
    const ref = templateReference(object(snapshot.selection).ref)
    requireValue(ref.scope.kind !== 'project' || ref.scope.workspace === workspace.cwd, copy.invalid)
  }
  if (data.version !== 3) {
    const size = object(snapshot.size)
    requireValue(counter(size.readAt), copy.invalid)
    if (size.state === 'available') {
      exactKeys(size, ['state', 'snapshot', 'readAt'])
      validateWorkflowSizeSnapshot(size.snapshot)
    } else {
      exactKeys(size, ['state', 'reason', 'readAt'])
      requireValue(size.state === 'unavailable' && text(size.reason) && size.reason.length <= 4096, copy.invalid)
    }
  }
  const state = object(data.state)
  if (state.kind === 'captured') {
    exactKeys(state, ['kind'])
    requireValue(data.revision === 0, copy.invalid)
  } else {
    requireValue(data.version !== 3 && branch(state.branch) && text(state.ownerEpoch) && (data.version === 1 || state.branch === 'workflow'), copy.invalid)
    const workflow = data.version === 2
    const planningHash = typeof state.planningRequestHash === 'string' && hashPattern.test(state.planningRequestHash)
    if (workflow && state.authoringContinuationKey !== undefined) requireValue(snapshot.operation === 'workflow_run' && planningHash && text(state.authoringContinuationKey), copy.invalid)
    if (state.kind === 'dispatch_intent') {
      exactKeys(state, workflow ? ['kind', 'branch', 'ownerEpoch', 'planningRequestHash', 'authoringContinuationKey'] : ['kind', 'branch', 'ownerEpoch'])
      requireValue(data.revision === 1 && (!workflow || planningHash), copy.invalid)
    } else if (state.kind === 'associated') {
      if (workflow) {
        exactKeys(state, ['kind', 'branch', 'ownerEpoch', 'planningRequestHash', 'workflowId', 'programRevision', 'authoringContinuationKey'])
        requireValue(planningHash && text(state.workflowId) && text(state.programRevision), copy.invalid)
      } else {
        exactKeys(state, ['kind', 'branch', 'ownerEpoch', 'runId'])
        requireValue(state.branch === 'direct' && text(state.runId), copy.invalid)
      }
      requireValue(data.revision === 2, copy.invalid)
    } else {
      exactKeys(state, workflow ? ['kind', 'branch', 'ownerEpoch', 'reason', 'planningRequestHash', 'workflowId', 'programRevision', 'authoringContinuationKey'] : ['kind', 'branch', 'ownerEpoch', 'reason', 'runId'])
      requireValue(state.kind === 'unknown' && text(state.reason) && state.reason.length <= 4096 && Number(data.revision) >= (workflow ? 1 : 2), copy.invalid)
      if (workflow) {
        requireValue(state.planningRequestHash === undefined || planningHash, copy.invalid)
        requireValue((state.workflowId === undefined && state.programRevision === undefined) ||
          (planningHash && text(state.workflowId) && text(state.programRevision)), copy.invalid)
      } else requireValue(state.runId === undefined || (state.branch === 'direct' && text(state.runId)), copy.invalid)
    }
  }
  return structuredClone(value) as TaskSubmission
}
