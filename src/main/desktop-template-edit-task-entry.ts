import type { Conversation } from '../shared/conversation'
import type { ConversationSubmissionRequest } from '../shared/conversation-api'
import type { WorkflowCapturedTemplateEditTask, WorkflowTemplateEditTaskInspection } from '../shared/workflow-api'
import type { WorkflowTemplateEditTarget } from '../shared/workflow-route'
import type { WorkflowTemplateSnapshot } from '../shared/workflow-template'
import type { ConversationStore } from './conversation-store'
import type { createDesktopTaskEntry } from './desktop-task-entry'
import { taskWorkspaceIdentity } from './desktop-task-entry'
import { workflowTaskSummary, type TemplateEditTaskSubmission } from './task-submission-record'
import type { WorkflowTemplateStore } from './workflow-template-store'
import type { WorkflowTemplateEditCandidateStore } from './workflow-template-edit-candidate-store'
import type { WorkflowTemplateEditApplicationStore } from './workflow-template-edit-application-store'

/** Durable edit configuration only. It never starts authoring, creates a draft,
 * saves, publishes, instantiates, approves or executes a workflow. */
export function createDesktopTemplateEditTaskEntry(deps: {
  conversations: () => ConversationStore
  templates: () => Pick<WorkflowTemplateStore, 'revision'>
  candidates?: WorkflowTemplateEditCandidateStore
  applications?: WorkflowTemplateEditApplicationStore
  intake: Pick<ReturnType<typeof createDesktopTaskEntry>, 'captureEdit'>
}) {
  const metadata = (task: TemplateEditTaskSubmission): WorkflowCapturedTemplateEditTask => ({
    reference: { conversationId: task.conversationId, commandId: task.commandId },
    editCommandId: task.submissionId,
    selection: structuredClone(task.snapshot.selection)
  })

  return {
    async capture(conversation: Conversation,
      request: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'expectedRevision' | 'prompt'>,
      instruction: string,
      target: WorkflowTemplateEditTarget | undefined,
      snapshot: WorkflowTemplateSnapshot | undefined) {
      const selection = snapshot ? { kind: 'saved' as const, ref: structuredClone(snapshot.ref) } : { kind: 'unselected' as const }
      const captured = await deps.intake.captureEdit(conversation, request, instruction, target, selection)
      if (captured.kind === 'rejected') return captured
      return { kind: 'captured' as const, workspace: captured.task.snapshot.workspace.cwd,
        submission: metadata(captured.task), edit: { instruction, ...(snapshot ? { snapshot: structuredClone(snapshot) } : {}) } }
    },

    async inspect(task: TemplateEditTaskSubmission, conversation: Conversation, command: string,
      instruction: string): Promise<WorkflowTemplateEditTaskInspection> {
      let edit: WorkflowTemplateEditTaskInspection['edit'] = { instruction }
      let reason: 'archived' | 'context_changed' | 'source_unavailable' | undefined
      const reference = { conversationId: task.conversationId, commandId: task.commandId }
      const [candidate, history] = await Promise.all([deps.candidates?.latest(reference), deps.candidates?.history(reference)])
      const applications = candidate ? await deps.applications?.history(reference, candidate.attemptId) : undefined
      if (conversation.archivedAt) reason = 'archived'
      else if (conversation.cwd !== task.snapshot.workspace.cwd ||
        await taskWorkspaceIdentity(conversation.cwd) !== task.snapshot.workspace.identity) reason = 'context_changed'
      else {
        const ref = task.snapshot.selection.kind === 'saved' ? task.snapshot.selection.ref : candidate?.sourceRef
        if (ref) {
          try {
            const snapshot = await deps.templates().revision(ref)
            if (snapshot) edit = { instruction, snapshot }
            else reason = 'source_unavailable'
          } catch { reason = 'source_unavailable' }
        }
      }
      return { task: workflowTaskSummary(task), command, instruction, workspace: task.snapshot.workspace.cwd,
        submission: metadata(task), edit, authoring: candidate ? { state: 'available', attempt: candidate, history: history ?? [], applications: applications ?? [] } : { state: 'none' },
        observedAt: Date.now(), outcome: reason ? { kind: 'blocked', reason } : { kind: 'configure' } }
    }
  }
}
