import { createHash } from 'node:crypto'
import type { ProviderContext } from '../shared/provider'
import type { WorkflowRoleBinding } from '../shared/workflow'
import type { WorkflowTaskReference } from '../shared/workflow-api'
import type { WorkflowTemplateEditAuthor, WorkflowTemplateEditCandidateInspection, WorkflowTemplateRef } from '../shared/workflow-template'
import { WORKFLOW_TEMPLATE_MAX_BYTES } from '../shared/workflow-template'
import type { ConversationStore } from './conversation-store'
import { taskWorkspaceIdentity } from './desktop-task-entry'
import type { WorkflowTemplateEditCandidateStore } from './workflow-template-edit-candidate-store'
import { assertTemplateSource, validateWorkflowTemplate } from './workflow-template-definition'
import type { WorkflowTemplateStore } from './workflow-template-store'

export const workflowTemplateEditCandidateSchema = Object.freeze({
  type: 'object',
  properties: {
    source: { type: 'string', maxLength: WORKFLOW_TEMPLATE_MAX_BYTES },
    summary: { type: 'string', maxLength: 16_000 }
  },
  required: ['source', 'summary'],
  additionalProperties: false
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function candidatePrompt(input: { instruction: string; source: string; templateId: string }): string {
  return JSON.stringify({
    purpose: 'Propose one review-only Scry workflow template edit candidate.',
    authority: [
      'Return candidate data only. Do not claim that anything was saved, published, approved or executed.',
      'Do not request, infer or use conversation history, attachments, credentials, workspace files, paths or shell commands.',
      'Keep schemaVersion 1 and the exact templateId. Follow the existing template grammar and runtime limits.',
      'The response must match the supplied JSON schema with source and summary only.'
    ],
    templateId: input.templateId,
    instruction: input.instruction,
    source: input.source
  })
}

function parseCandidate(output: string, templateId: string): { source: string; summary: string; validation: { state: 'valid' } | { state: 'invalid'; error: string } } {
  const value = JSON.parse(output) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => key !== 'source' && key !== 'summary')) throw new Error('模型返回的模板编辑候选结构无效')
  const candidate = value as Record<string, unknown>
  assertTemplateSource(candidate.source)
  if (typeof candidate.summary !== 'string' || !candidate.summary.trim() || candidate.summary.length > 16_000) throw new Error('模型返回的模板编辑摘要无效')
  let validation: { state: 'valid' } | { state: 'invalid'; error: string }
  try { validateWorkflowTemplate(candidate.source, templateId); validation = { state: 'valid' } }
  catch (error) { validation = { state: 'invalid', error: error instanceof Error ? error.message : String(error) } }
  return { source: candidate.source, summary: candidate.summary, validation }
}

/** Explicit, disclosed candidate generation only. It cannot create a draft,
 * save or publish a template, instantiate a workflow, approve or execute it. */
export function createDesktopTemplateEditAuthoring(deps: {
  conversations: () => ConversationStore
  templates: () => Pick<WorkflowTemplateStore, 'revision'>
  candidates: WorkflowTemplateEditCandidateStore
  resolveWorkspace: (cwd: string) => Promise<string>
  resolveContinuationKey: (context: ProviderContext) => Promise<string>
  providerAuthoringAvailable: (providerId: WorkflowTemplateEditAuthor['providerId']) => boolean
  workflowRunControls: (role: WorkflowRoleBinding, workspace: string) => Promise<{ model: boolean; identity: string; independentRun: boolean; terminalOutput: boolean }>
  runAuthoring: (input: { runId: string; role: WorkflowRoleBinding; prompt: string; workspace: string; beforeProviderDispatch?: () => Promise<void>; expectedContinuationKey?: string; authoringSchema?: Readonly<Record<string, unknown>> }) => Promise<{ output: string; outputSource?: string; actualModel?: string; archiveRef?: string }>
}) {
  const assertCurrent = async (reference: WorkflowTaskReference, expectedRevision: number, selection?: WorkflowTemplateRef) => {
    const input = await deps.conversations().readTemplateEditTaskInput(reference)
    if (!input || input.task.revision !== expectedRevision || input.task.version !== 3) throw new Error('模板编辑任务修订已变化')
    const task = input.task
    const ref = task.snapshot.selection.kind === 'saved' ? task.snapshot.selection.ref : selection
    if (!ref) throw new Error('请先为此任务选择一个精确模板修订')
    if (task.snapshot.selection.kind === 'saved' && selection !== undefined) throw new Error('已记录来源的模板编辑任务不能替换来源')
    const conversation = await deps.conversations().read(reference.conversationId)
    if (!conversation || conversation.deletion || conversation.archivedAt || conversation.cwd !== task.snapshot.workspace.cwd ||
      await deps.resolveWorkspace(conversation.cwd) !== conversation.cwd ||
      await taskWorkspaceIdentity(conversation.cwd) !== task.snapshot.workspace.identity) throw new Error('模板编辑任务的工作区上下文已变化')
    const snapshot = await deps.templates().revision(ref)
    if (!snapshot) throw new Error('模板编辑任务记录的来源修订不可用')
    return { input, task, snapshot }
  }

  return {
    async request(request: {
      reference: WorkflowTaskReference
      expectedTaskRevision: number
      attemptId: string
      author: WorkflowTemplateEditAuthor
      selection?: WorkflowTemplateRef
      disclosure: { acknowledgesModelCall: true; acknowledgesSourceDisclosure: true }
    }): Promise<WorkflowTemplateEditCandidateInspection> {
      if (request.disclosure.acknowledgesModelCall !== true || request.disclosure.acknowledgesSourceDisclosure !== true) throw new Error('请先确认模型调用与发送内容')
      const current = await assertCurrent(request.reference, request.expectedTaskRevision, request.selection)
      if (!deps.providerAuthoringAvailable(request.author.providerId)) throw new Error('所选 Provider 不支持受限的工作流编写输出')
      const roleInput: WorkflowRoleBinding = { role: 'orchestrator', providerId: request.author.providerId,
        ...(request.author.agentProfileId ? { agentProfileId: request.author.agentProfileId } : {}),
        ...(request.author.requestedModel ? { requestedModel: request.author.requestedModel } : {}), permissionMode: 'default' }
      const controls = await deps.workflowRunControls(roleInput, current.task.snapshot.workspace.cwd)
      if (!controls.model || !controls.identity || !controls.independentRun || !controls.terminalOutput) throw new Error('所选 Provider、模型或工作流编写能力不可用')
      const role = { ...roleInput, runtimeIdentity: controls.identity }
      const continuationKey = await deps.resolveContinuationKey({ providerId: role.providerId, cwd: current.task.snapshot.workspace.cwd, agentProfileId: role.agentProfileId })
      const sourceHash = digest(current.snapshot.source), continuationKeyHash = digest(continuationKey)
      const requestHash = digest(JSON.stringify({ task: { reference: request.reference, revision: current.task.revision, submissionId: current.task.submissionId,
        inputSha256: current.task.snapshot.input.sha256 }, sourceRef: current.snapshot.ref, sourceHash,
        author: role, continuationKeyHash, disclosure: request.disclosure }))
      const runId = `workflow-template-edit-${request.attemptId}`
      const admission = await deps.candidates.createIntent({
        version: 1, attemptId: request.attemptId,
        task: { ...request.reference, revision: current.task.revision, submissionId: current.task.submissionId, inputSha256: current.task.snapshot.input.sha256 },
        sourceRef: current.snapshot.ref, sourceHash,
        author: { providerId: role.providerId, ...(role.agentProfileId ? { agentProfileId: role.agentProfileId } : {}),
          ...(role.requestedModel ? { requestedModel: role.requestedModel } : {}), runtimeIdentity: controls.identity },
        continuationKeyHash, requestHash, requestedAt: Date.now(),
        disclosure: { sourceBytes: Buffer.byteLength(current.snapshot.source), sends: ['instruction', 'template_source', 'authoring_contract'],
          excludes: ['conversation_history', 'attachments', 'workspace_files', 'credentials'],
          estimatedCost: { state: 'unavailable', reason: '所选 Provider 未提供此调用的可靠费用估算' } },
        state: { kind: 'dispatch_intent', runId }
      })
      if (!admission.created) return admission.observed
      const intent = admission.intent
      const beforeProviderDispatch = async () => {
        const latest = await assertCurrent(request.reference, intent.task.revision, current.task.snapshot.selection.kind === 'unselected' ? intent.sourceRef : undefined)
        if (latest.task.snapshot.input.sha256 !== intent.task.inputSha256 || JSON.stringify(latest.snapshot.ref) !== JSON.stringify(intent.sourceRef) ||
          digest(latest.snapshot.source) !== intent.sourceHash) throw new Error('模板编辑任务或精确来源在发送前变化')
        const latestControls = await deps.workflowRunControls(role, latest.task.snapshot.workspace.cwd)
        if (latestControls.identity !== controls.identity || !latestControls.model || !latestControls.independentRun || !latestControls.terminalOutput) {
          throw new Error('Provider 或模型能力在发送前变化')
        }
      }
      try {
        const result = await deps.runAuthoring({ runId, role, workspace: current.task.snapshot.workspace.cwd,
          prompt: candidatePrompt({ instruction: current.input.instruction, source: current.snapshot.source, templateId: current.snapshot.ref.templateId }),
          beforeProviderDispatch, expectedContinuationKey: continuationKey, authoringSchema: workflowTemplateEditCandidateSchema })
        if (!result.archiveRef || !result.outputSource) throw new Error('模板编辑候选缺少权威归档或结构化来源')
        const candidate = parseCandidate(result.output, current.snapshot.ref.templateId)
        return await deps.candidates.recordCandidate(request.reference, request.attemptId, {
          archiveRef: result.archiveRef, outputSource: result.outputSource, ...(result.actualModel ? { actualModel: result.actualModel } : {}), ...candidate
        })
      } catch (error) {
        return deps.candidates.recordUnknown(request.reference, request.attemptId, error instanceof Error ? error.message : String(error))
      }
    }
  }
}
