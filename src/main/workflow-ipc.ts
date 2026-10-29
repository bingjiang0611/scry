import type { WorkflowApproval } from '../shared/workflow'
import { templateIdPattern } from '../shared/workflow-template'
import type { WorkflowExecutionInspectionRequest } from '../shared/workflow-inspection'
import type { WorkflowOutputInspectionRequest } from '../shared/workflow-output-inspection'
import { MAX_RECORD_BYTES } from './workflow-store-artifacts'
import { WORKFLOW_EXECUTION_INSPECTION_MAX_OFFSET, WORKFLOW_EXECUTION_INSPECTION_PAGE_SIZE } from '../shared/workflow-inspection'
import { workflowInspectionCopy } from '../shared/constants/workflow-inspection-copy'
import { WORKFLOW_OUTPUT_COPY as workflowOutputCopy } from '../shared/constants/workflow-output-copy'
import type { WorkflowService } from './workflow-service'
import { validateWorkflowRoleBinding } from './workflow-program'
import { workflowRecoveryCopy, taskSubmissionCopy } from '../shared/constants/copy'
import { validateWorkflowRestartTarget, validateWorkflowRetryTarget } from './workflow-retry'
import { validateWorkflowRevisionDraft, validateWorkflowRevisionTarget } from './workflow-revision-draft'
import { validateWorkflowStopTarget } from './workflow-stop'
import { parseWorkflowTaskReference } from './task-submission-record'
import type { createDesktopWorkflowTaskEntry } from './desktop-workflow-task-entry'
import type { createDesktopTemplateEditAuthoring } from './desktop-template-edit-authoring'
import type { createDesktopTemplateEditCandidateApplication } from './desktop-template-edit-candidate-application'
import { idPattern } from './conversation-record'
import { templateReference } from './workflow-template-identity'
import type { WorkflowSourceApplicationService } from './workflow-source-application-service'
import { registerWorkflowSourceApplicationIpc } from './workflow-source-application-ipc'

type Service = Pick<WorkflowService, 'sizeGuideline' | 'setSizeGuideline' | 'planCommand' | 'preview' | 'findPreview' | 'approve' | 'start' | 'resume' | 'retry' | 'restartStalled' | 'prepareRevision' | 'revisePrepared' | 'stop' | 'stopNode' | 'snapshot' | 'inspectFrame' | 'inspectExecution' | 'inspectOutput' | 'list' | 'cancelPlanning'>
const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw new Error('工作流身份无效')
  return value
}
function executionInspection(value: unknown): WorkflowExecutionInspectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(workflowInspectionCopy.invalidRequest)
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['workflowId', 'programRevision', 'kind', 'nodeId', 'offset'].includes(key)) ||
    typeof input.programRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.programRevision) ||
    !['attempts', 'systems', 'classifiers'].includes(input.kind as string) ||
    input.nodeId !== undefined && (typeof input.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(input.nodeId)) ||
    input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0 || (input.offset as number) > WORKFLOW_EXECUTION_INSPECTION_MAX_OFFSET || (input.offset as number) % WORKFLOW_EXECUTION_INSPECTION_PAGE_SIZE !== 0)) throw new Error(workflowInspectionCopy.invalidRequest)
  return { workflowId: identity(input.workflowId), programRevision: input.programRevision, kind: input.kind as WorkflowExecutionInspectionRequest['kind'],
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}), ...(input.offset !== undefined ? { offset: input.offset as number } : {}) }
}
function outputInspection(value: unknown): WorkflowOutputInspectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(workflowOutputCopy.invalidRequest)
  const input = value as Record<string, unknown>, selection = input.selection
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
    Object.keys(input).some(key => !['workflowId', 'programRevision', 'selection', 'offset', 'expectedContentHash'].includes(key)) ||
    typeof input.programRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.programRevision) ||
    input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0 || (input.offset as number) > MAX_RECORD_BYTES) ||
    input.offset !== undefined && (input.offset as number) > 0 && (typeof input.expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedContentHash)) ||
    input.expectedContentHash !== undefined && (typeof input.expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedContentHash))) throw new Error(workflowOutputCopy.invalidRequest)
  const selected = selection as Record<string, unknown>
  let normalized: WorkflowOutputInspectionRequest['selection']
  if (selected.kind === 'attempt' && Object.keys(selected).every(key => ['kind', 'attemptId'].includes(key))) normalized = { kind: 'attempt', attemptId: identity(selected.attemptId) }
  else if (selected.kind === 'system' && Object.keys(selected).every(key => ['kind', 'stepId', 'field'].includes(key)) && ['result', 'stdout', 'stderr'].includes(selected.field as string)) normalized = { kind: 'system', stepId: identity(selected.stepId), field: selected.field as 'result' | 'stdout' | 'stderr' }
  else if (selected.kind === 'frame' && Object.keys(selected).every(key => ['kind', 'frameId'].includes(key))) normalized = { kind: 'frame', frameId: identity(selected.frameId) }
  else throw new Error(workflowOutputCopy.invalidRequest)
  return { workflowId: identity(input.workflowId), programRevision: input.programRevision, selection: normalized,
    ...(input.offset !== undefined ? { offset: input.offset as number } : {}), ...(input.expectedContentHash !== undefined ? { expectedContentHash: input.expectedContentHash as string } : {}) }
}
function approval(value: unknown): WorkflowApproval {
  if (!value || typeof value !== 'object') throw new Error('工作流确认请求无效')
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input.approvedAt) || (input.approvedAt as number) <= 0) throw new Error('工作流确认时间无效')
  return { workflowId: identity(input.workflowId), programRevision: identity(input.programRevision), approvedAt: input.approvedAt as number }
}

/** register must be the production trusted sender/frame/origin wrapper. */
export function registerWorkflowIpc({ register, service, capturedTasks, templateEditAuthoring, templateEditApplication, sourceApplications, resolveWorkspace, assertCurrentWorkspace }: {
  register: (channel: string, listener: (...args: unknown[]) => unknown) => void
  service: Service
  capturedTasks: ReturnType<typeof createDesktopWorkflowTaskEntry>
  templateEditAuthoring: ReturnType<typeof createDesktopTemplateEditAuthoring>
  templateEditApplication: ReturnType<typeof createDesktopTemplateEditCandidateApplication>
  sourceApplications: Pick<WorkflowSourceApplicationService, 'catalog' | 'apply'>
  resolveWorkspace: (cwd: string) => string
  assertCurrentWorkspace: (cwd: string) => void
}): void {
  register('workflow:sizeGuideline', () => service.sizeGuideline())
  register('workflow:setSizeGuideline', value => service.setSizeGuideline(value))
  register('workflow:plan', payload => {
    if (!payload || typeof payload !== 'object') throw new Error('工作流计划请求无效')
    const value = payload as Record<string, unknown>
    if (typeof value.command !== 'string' || value.command.length > 16_000 || typeof value.cwd !== 'string' || value.cwd.length > 4096 || !value.cwd.trim()) throw new Error('工作流入口请求无效')
    const submission = value.submission === undefined ? undefined : parseWorkflowTaskReference(value.submission)
    if (submission && Object.keys(value).some(key => !['command', 'commandId', 'cwd', 'orchestrator', 'roles', 'submission'].includes(key))) throw new Error(taskSubmissionCopy.invalid)
    const commandId = value.commandId === undefined ? undefined : identity(value.commandId)
    if (!submission && commandId && /^submission-[a-f0-9]{64}$/.test(commandId)) throw new Error(taskSubmissionCopy.invalid)
    if (!Array.isArray(value.roles) || value.roles.length > 3) throw new Error('工作流角色配置无效')
    const orchestrator = validateWorkflowRoleBinding(value.orchestrator)
    if (orchestrator.role !== 'orchestrator') throw new Error('编排角色无效')
    const roles = value.roles.map((role, index) => validateWorkflowRoleBinding(role, index + 1))
    const workspace = resolveWorkspace(value.cwd)
    assertCurrentWorkspace(workspace)
    const request = { command: value.command, commandId, workspace, orchestrator, roles }
    return submission ? capturedTasks.plan(request, submission) : service.planCommand(request)
  })
  register('workflow:capturedTasks', (conversationId, cursor) => {
    if (typeof conversationId !== 'string' || !idPattern.test(conversationId) ||
      cursor !== undefined && (typeof cursor !== 'string' || !/^submission-[a-f0-9]{64}$/.test(cursor))) throw new Error(taskSubmissionCopy.invalid)
    return capturedTasks.list(conversationId, cursor as string | undefined)
  })
  register('workflow:inspectTask', reference => capturedTasks.inspect(parseWorkflowTaskReference(reference)))
  register('workflow:requestTemplateEditCandidate', payload => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(taskSubmissionCopy.invalid)
    const value = payload as Record<string, unknown>
    if (Object.keys(value).some(key => !['reference', 'expectedTaskRevision', 'attemptId', 'author', 'selection', 'disclosure'].includes(key)) ||
      !Number.isSafeInteger(value.expectedTaskRevision) || (value.expectedTaskRevision as number) < 0 ||
      !value.author || typeof value.author !== 'object' || Array.isArray(value.author) ||
      Object.keys(value.author as object).some(key => !['providerId', 'agentProfileId', 'requestedModel'].includes(key)) ||
      !value.disclosure || typeof value.disclosure !== 'object' || Array.isArray(value.disclosure) ||
      Object.keys(value.disclosure as object).some(key => !['acknowledgesModelCall', 'acknowledgesSourceDisclosure'].includes(key))) throw new Error(taskSubmissionCopy.invalid)
    const disclosure = value.disclosure as Record<string, unknown>
    if (disclosure.acknowledgesModelCall !== true || disclosure.acknowledgesSourceDisclosure !== true) throw new Error(taskSubmissionCopy.invalid)
    const role = validateWorkflowRoleBinding({ ...(value.author as object), role: 'orchestrator' })
    return templateEditAuthoring.request({ reference: parseWorkflowTaskReference(value.reference), expectedTaskRevision: value.expectedTaskRevision as number,
      attemptId: identity(value.attemptId), author: { providerId: role.providerId, ...(role.agentProfileId ? { agentProfileId: role.agentProfileId } : {}),
        ...(role.requestedModel ? { requestedModel: role.requestedModel } : {}) },
      ...(value.selection === undefined ? {} : { selection: templateReference(value.selection) }),
      disclosure: { acknowledgesModelCall: true, acknowledgesSourceDisclosure: true } })
  })
  register('workflow:applyTemplateEditCandidate', payload => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(taskSubmissionCopy.invalid)
    const value = payload as Record<string, unknown>
    if (Object.keys(value).some(key => !['reference', 'expectedTaskRevision', 'attemptId', 'commandId', 'destination'].includes(key)) ||
      !Number.isSafeInteger(value.expectedTaskRevision) || (value.expectedTaskRevision as number) < 0 ||
      value.destination !== 'personal' && value.destination !== 'project') throw new Error(taskSubmissionCopy.invalid)
    const commandId = identity(value.commandId)
    if (!templateIdPattern.test(commandId)) throw new Error(taskSubmissionCopy.invalid)
    return templateEditApplication.apply({ reference: parseWorkflowTaskReference(value.reference), expectedTaskRevision: value.expectedTaskRevision as number,
      attemptId: identity(value.attemptId), commandId, destination: value.destination })
  })
  register('workflow:prepareTemplateTask', payload => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(taskSubmissionCopy.invalid)
    const value = payload as Record<string, unknown>
    if (Object.keys(value).some(key => !['reference', 'orchestrator', 'roles'].includes(key)) ||
      !Array.isArray(value.roles) || value.roles.length > 3) throw new Error(taskSubmissionCopy.invalid)
    const reference = parseWorkflowTaskReference(value.reference), orchestrator = validateWorkflowRoleBinding(value.orchestrator)
    if (orchestrator.role !== 'orchestrator') throw new Error(taskSubmissionCopy.invalid)
    const roles = value.roles.map((role, index) => validateWorkflowRoleBinding(role, index + 1))
    return capturedTasks.prepareTemplate(reference, orchestrator, roles)
  })
  register('workflow:preview', async workflowId => {
    const preview = await service.preview(identity(workflowId))
    resolveWorkspace(preview.workspace)
    return preview
  })
  register('workflow:approve', payload => service.approve(approval(payload)))
  register('workflow:start', (workflowId, payload) => {
    const accepted = approval(payload)
    if (identity(workflowId) !== accepted.workflowId) throw new Error('工作流确认不匹配')
    const commandId = (payload as Record<string, unknown>).commandId
    return service.start(accepted.workflowId, accepted, commandId === undefined ? undefined : identity(commandId))
  })
  register('workflow:resume', (workflowId, payload) => {
    const accepted = approval(payload)
    if (identity(workflowId) !== accepted.workflowId) throw new Error(workflowRecoveryCopy.fingerprint)
    const commandId = identity((payload as Record<string, unknown>).commandId)
    return (async () => {
      // Workspace authority comes from the frozen program, never a progress summary.
      const preview = await service.findPreview(accepted.workflowId)
      if (preview) resolveWorkspace(preview.workspace)
      return service.resume(accepted.workflowId, accepted, commandId)
    })()
  })
  register('workflow:retry', async (workflowId, payload) => {
    const accepted = approval(payload)
    if (identity(workflowId) !== accepted.workflowId) throw new Error(workflowRecoveryCopy.fingerprint)
    const value = payload as Record<string, unknown>
    const commandId = identity(value.commandId)
    const target = validateWorkflowRetryTarget(value.target)
    const preview = await service.preview(accepted.workflowId)
    resolveWorkspace(preview.workspace)
    return service.retry(accepted.workflowId, accepted, target, commandId)
  })
  register('workflow:restartStalled', async (workflowId, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(workflowRecoveryCopy.fingerprint)
    const value = payload as Record<string, unknown>
    if (Object.keys(value).length !== 5 || Object.keys(value).some(key => !['workflowId', 'programRevision', 'approvedAt', 'target', 'commandId'].includes(key))) throw new Error(workflowRecoveryCopy.fingerprint)
    const accepted = approval(value)
    if (identity(workflowId) !== accepted.workflowId) throw new Error(workflowRecoveryCopy.fingerprint)
    const commandId = identity(value.commandId)
    const target = validateWorkflowRestartTarget(value.target)
    const preview = await service.preview(accepted.workflowId)
    resolveWorkspace(preview.workspace)
    return service.restartStalled(accepted.workflowId, accepted, target, commandId)
  })
  register('workflow:prepareRevision', async payload => {
    const draft = validateWorkflowRevisionDraft(payload)
    const preview = await service.preview(draft.workflowId)
    resolveWorkspace(preview.workspace)
    return service.prepareRevision(draft)
  })
  register('workflow:revise', async (workflowId, payload) => {
    const accepted = approval(payload)
    if (identity(workflowId) !== accepted.workflowId) throw new Error(workflowRecoveryCopy.fingerprint)
    const value = payload as Record<string, unknown>
    if (Object.keys(value).some(key => !['workflowId', 'programRevision', 'approvedAt', 'target', 'commandId'].includes(key))) throw new Error(workflowRecoveryCopy.fingerprint)
    const target = validateWorkflowRevisionTarget(value.target)
    const commandId = identity(value.commandId)
    const preview = await service.preview(accepted.workflowId)
    resolveWorkspace(preview.workspace)
    return service.revisePrepared(accepted.workflowId, accepted, target, commandId)
  })
  register('workflow:stop', (workflowId, commandId) => service.stop(identity(workflowId), identity(commandId)))
  register('workflow:stopNode', async (workflowId, target, commandId) => {
    const id = identity(workflowId), acceptedTarget = validateWorkflowStopTarget(target), command = identity(commandId)
    const preview = await service.preview(id)
    resolveWorkspace(preview.workspace)
    return service.stopNode(id, acceptedTarget, command)
  })
  register('workflow:snapshot', async workflowId => {
    const progress = await service.snapshot(identity(workflowId))
    if (progress) resolveWorkspace(progress.workspace)
    return progress ?? null
  })
  register('workflow:inspectFrame', async (workflowId, frameId) => {
    const id = identity(workflowId), frame = identity(frameId)
    const preview = await service.findPreview(id)
    if (!preview) return { state: 'unavailable', source: 'canonical_frame', observedAt: Date.now(), reason: 'root_missing' as const }
    resolveWorkspace(preview.workspace)
    return service.inspectFrame(preview, frame)
  })
  register('workflow:inspectExecution', request => service.inspectExecution(executionInspection(request), resolveWorkspace))
  register('workflow:inspectOutput', request => service.inspectOutput(outputInspection(request), resolveWorkspace))
  registerWorkflowSourceApplicationIpc(register, sourceApplications)
  register('workflow:list', (cwd, cursor) => {
    if (typeof cwd !== 'string' || cwd.length > 4096 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 101))) throw new Error('工作流列表请求无效')
    return service.list(resolveWorkspace(cwd), cursor as string | undefined)
  })
  register('workflow:cancelPlanning', (commandId, submission) => {
    const id = identity(commandId)
    if (submission === undefined) {
      if (/^submission-[a-f0-9]{64}$/.test(id)) throw new Error(taskSubmissionCopy.invalid)
      return service.cancelPlanning(id)
    }
    return capturedTasks.cancel(id, parseWorkflowTaskReference(submission))
  })
}
