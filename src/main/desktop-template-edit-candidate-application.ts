import { createHash } from 'node:crypto'
import type { WorkflowTaskReference } from '../shared/workflow-api'
import type { WorkflowTemplateDraft, WorkflowTemplateEditCandidateApplication, WorkflowTemplateRef, WorkflowTemplateScope } from '../shared/workflow-template'
import type { ConversationStore } from './conversation-store'
import { taskWorkspaceIdentity } from './desktop-task-entry'
import type { WorkflowTemplateEditApplicationStore, TemplateEditApplicationRecord } from './workflow-template-edit-application-store'
import type { WorkflowTemplateEditCandidateStore } from './workflow-template-edit-candidate-store'
import type { WorkflowTemplateStore } from './workflow-template-store'

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }

/** Explicit candidate-to-draft application only. Publication, instantiation,
 * approval and execution remain separate existing commands. */
export function createDesktopTemplateEditCandidateApplication(deps: {
  conversations: () => ConversationStore
  templates: () => Pick<WorkflowTemplateStore, 'revision' | 'draft' | 'saveDraft'>
  candidates: WorkflowTemplateEditCandidateStore
  applications: WorkflowTemplateEditApplicationStore
  resolveWorkspace: (cwd: string) => Promise<string>
}) {
  const currentTask = async (reference: WorkflowTaskReference, expectedRevision: number) => {
    const input = await deps.conversations().readTemplateEditTaskInput(reference)
    if (!input || input.task.version !== 3 || input.task.revision !== expectedRevision) throw new Error('模板编辑任务或修订无效')
    const conversation = await deps.conversations().read(reference.conversationId)
    if (!conversation || conversation.deletion || conversation.archivedAt || conversation.cwd !== input.task.snapshot.workspace.cwd ||
      await deps.resolveWorkspace(conversation.cwd) !== conversation.cwd ||
      await taskWorkspaceIdentity(conversation.cwd) !== input.task.snapshot.workspace.identity) throw new Error('模板编辑任务的工作区上下文已变化')
    return input
  }

  const observeDraft = async (record: TemplateEditApplicationRecord, expected: { source: string; scope: WorkflowTemplateScope; base?: WorkflowTemplateRef }) => {
    if (record.state.kind !== 'applied') return null
    let draft: WorkflowTemplateDraft
    try { draft = await deps.templates().draft(record.state.draftId) } catch { return null }
    if (draft.draftRevision !== record.state.draftRevision || draft.draftId !== record.state.draftId || draft.candidateHash !== record.state.candidateHash ||
      !equal(draft.scope, expected.scope) || !equal(draft.base, expected.base ?? null)) return null
    return draft
  }

  return {
    async apply(request: { reference: WorkflowTaskReference; expectedTaskRevision: number; attemptId: string; commandId: string; destination: 'personal' | 'project' }): Promise<WorkflowTemplateEditCandidateApplication> {
      const task = await currentTask(request.reference, request.expectedTaskRevision)
      const candidate = await deps.candidates.attempt(request.reference, request.attemptId)
      if (!candidate || candidate.taskRevision !== request.expectedTaskRevision || candidate.state.kind !== 'candidate' ||
        task.task.snapshot.selection.kind === 'saved' && !equal(candidate.sourceRef, task.task.snapshot.selection.ref)) throw new Error('模板编辑候选不可用')
      const sourceSnapshot = await deps.templates().revision(candidate.sourceRef)
      if (!sourceSnapshot) throw new Error('模板编辑候选记录的来源修订不可用')
      const scope: WorkflowTemplateScope = request.destination === 'project' ? { kind: 'project', workspace: task.task.snapshot.workspace.cwd } : { kind: 'personal' }
      const sameSource = candidate.sourceRef.scope.kind !== 'builtin' && equal(candidate.sourceRef.scope, scope)
      const base = sameSource ? candidate.sourceRef : undefined
      const source = candidate.state.source
      const requestHash = digest(JSON.stringify({ reference: request.reference, taskRevision: request.expectedTaskRevision,
        attemptId: request.attemptId, candidateHash: candidate.state.candidateHash, sourceHash: digest(candidate.state.source), destination: request.destination,
        scope, base: base ?? null }))
      const admission = await deps.applications.createIntent({ version: 1, commandId: request.commandId,
        task: { ...request.reference, revision: request.expectedTaskRevision }, attemptId: request.attemptId, requestHash,
        destination: request.destination, createdAt: Date.now(), state: { kind: 'intent' } })
      const expected = { source, scope, ...(base ? { base } : {}) }
      if (!admission.created) {
        if (admission.record.state.kind === 'unknown') return { state: 'unknown', reason: admission.record.state.reason }
        if (admission.record.state.kind === 'intent') return { state: 'unknown', reason: '候选草稿结果未知；Scry 不会自动重试' }
        const observed = await observeDraft(admission.record, expected)
        if (!observed) return { state: 'unknown', reason: '候选草稿收据与实际草稿不一致' }
        if (admission.record.state.draftRevision !== observed.draftRevision || admission.record.state.candidateHash !== observed.candidateHash) {
          return { state: 'unknown', reason: '候选草稿收据与实际草稿不一致' }
        }
        return { state: 'applied', verification: 'reconciled_draft', draft: observed }
      }
      try {
        const draft = await deps.templates().saveDraft(expected)
        await deps.applications.applied(request.reference, request.commandId, draft.draftId, draft.draftRevision, draft.candidateHash)
        return { state: 'applied', verification: 'write', draft }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await deps.applications.unknown(request.reference, request.commandId, reason)
        return { state: 'unknown', reason }
      }
    }
  }
}
