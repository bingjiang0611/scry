import type { Conversation } from '../shared/conversation'
import type { ConversationSubmissionRequest } from '../shared/conversation-api'
import { SCRY_WORKFLOW_COMMAND_ID, type ScryTaskCommand } from '../shared/task-command'
import type { WorkflowPlanPreview, WorkflowRoleBinding } from '../shared/workflow'
import type { WorkflowCapturedTemplateTask, WorkflowTaskReference, WorkflowTemplateTaskInspection } from '../shared/workflow-api'
import type { WorkflowTemplateDefinition } from '../shared/workflow-template'
import { taskSubmissionCopy as copy } from '../shared/constants/copy'
import type { ConversationStore } from './conversation-store'
import type { createDesktopTaskEntry } from './desktop-task-entry'
import { taskWorkspaceIdentity } from './desktop-task-entry'
import { CommandReceipts } from './command-receipts'
import { createTaskCommandCatalog, resolveTaskCommand } from './task-command'
import { taskDigest, taskSubmissionId, workflowTaskSummary, type WorkflowTaskSubmission } from './task-submission-record'
import { WORKFLOW_ROLES } from './workflow-program'
import type { WorkflowService } from './workflow-service'
import { validateTemplateInstantiation } from './workflow-template-instance'
import { resolveWorkflowTemplateCommand } from './workflow-template-command'
import type { WorkflowTemplateStore } from './workflow-template-store'

/** Fixed-template intake/preparation only. The existing Service compiles the
 * frozen definition; this controller never invokes a planner or starts a run. */
export function createDesktopTemplateTaskEntry(deps: {
  conversations: () => ConversationStore
  templates: () => WorkflowTemplateStore
  intake: Pick<ReturnType<typeof createDesktopTaskEntry>, 'captureTemplate'>
  service: Pick<WorkflowService, 'instantiateTemplate' | 'observeCapturedTemplate'>
  ownerEpoch: string
  required: (reference: WorkflowTaskReference) => Promise<WorkflowTaskSubmission>
  readConversation: (id: string) => Promise<Conversation>
  assertWorkspace: (task: WorkflowTaskSubmission) => Promise<void>
}) {
  const receipts = new CommandReceipts<WorkflowPlanPreview>()
  const message = (error: unknown) => error instanceof Error ? error.message : String(error)

  async function metadata(task: WorkflowTaskSubmission, definition?: WorkflowTemplateDefinition): Promise<WorkflowCapturedTemplateTask> {
    if (task.snapshot.operation !== 'workflow_template') throw new Error(copy.branchConflict)
    const ref = task.snapshot.template
    const common = { reference: { conversationId: task.conversationId, commandId: task.commandId }, instanceCommandId: task.submissionId, size: task.snapshot.size }
    try {
      const frozen = definition ?? await deps.templates().frozen(ref)
      const roles = WORKFLOW_ROLES.filter(role => role === 'orchestrator' || frozen.roles.some(binding => binding.role === role))
      return { ...common, template: { ref, state: 'available', name: frozen.name, roles } }
    } catch (error) {
      // An unavailable retained definition is read-only evidence, not an empty
      // role set or permission to re-resolve a newer catalogue revision.
      return { ...common, template: { ref, state: 'unavailable', reason: message(error) } }
    }
  }

  async function associate(task: WorkflowTaskSubmission, preview: WorkflowPlanPreview, hash: string): Promise<void> {
    const latest = await deps.required(task), state = latest.state
    if (state.kind === 'captured' || state.branch !== 'workflow' || state.planningRequestHash !== hash) throw new Error(copy.branchConflict)
    if (state.kind === 'associated' || (state.kind === 'unknown' && state.workflowId)) {
      if (state.workflowId !== preview.workflowId) throw new Error(copy.receiptMissing)
      return
    }
    await deps.conversations().associateWorkflowTask(task, latest.revision, state.ownerEpoch,
      { workflowId: preview.workflowId, programRevision: preview.programRevision, planningRequestHash: hash })
  }

  async function execute(reference: WorkflowTaskReference, orchestrator: WorkflowRoleBinding, roles: WorkflowRoleBinding[]): Promise<WorkflowPlanPreview> {
    await deps.readConversation(reference.conversationId)
    const store = deps.conversations(), { task, command } = await store.readWorkflowTaskInput(reference)
    if (task.snapshot.operation !== 'workflow_template') throw new Error(copy.branchConflict)
    const ref = task.snapshot.template
    const resolved = resolveTaskCommand(command, createTaskCommandCatalog({ conversationId: task.conversationId, cwd: task.snapshot.workspace.cwd }), SCRY_WORKFLOW_COMMAND_ID)
    if (resolved.kind !== 'scry_workflow' || resolved.command.kind !== 'template' || resolved.command.templateId !== ref.templateId ||
      (resolved.command.scope && resolved.command.scope !== ref.scope.kind)) throw new Error(copy.changedInput)
    const request = validateTemplateInstantiation({ source: { kind: 'saved', ref }, commandId: task.submissionId, cwd: task.snapshot.workspace.cwd,
      userGoal: command, parameters: JSON.parse(resolved.command.input), orchestrator, roles })
    // This existing journal field is a configuration hash. Fixed templates have
    // no PlanningIntent, model result or authoring-continuation identity.
    const hash = taskDigest(JSON.stringify(request)), state = task.state
    if (state.kind !== 'captured') {
      if (state.branch !== 'workflow' || state.planningRequestHash !== hash) throw new Error(copy.changedInput)
      const observed = await deps.service.observeCapturedTemplate(task.submissionId, hash, ref, command, task.snapshot.workspace.cwd)
      if (!observed) throw new Error(copy.unknown)
      await associate(task, observed.preview, hash)
      return observed.preview
    }
    if (task.capturedBy !== deps.ownerEpoch) throw new Error(copy.interrupted)
    await deps.assertWorkspace(task)
    try {
      await store.claimTaskDispatch(task, task.revision, 'workflow', deps.ownerEpoch, hash)
      const beforePrepare = async () => {
        await deps.assertWorkspace(task)
        const latest = await deps.required(task)
        if (latest.state.kind !== 'dispatch_intent' || latest.state.branch !== 'workflow' || latest.state.ownerEpoch !== deps.ownerEpoch ||
          latest.state.planningRequestHash !== hash) throw new Error(copy.unknown)
      }
      await deps.service.instantiateTemplate(request, { frozenSource: true, beforePrepare })
      const observed = await deps.service.observeCapturedTemplate(task.submissionId, hash, ref, command, task.snapshot.workspace.cwd)
      if (!observed) throw new Error(copy.receiptMissing)
      await associate(task, observed.preview, hash)
      return observed.preview
    } catch (error) {
      try {
        const latest = await deps.required(task)
        if (latest.state.kind === 'dispatch_intent' && latest.state.ownerEpoch === deps.ownerEpoch && latest.state.planningRequestHash === hash) {
          await store.markTaskDispatchUnknown(task, latest.revision, deps.ownerEpoch, message(error).slice(0, 4096))
        }
      } catch (recordingError) { throw new AggregateError([error, recordingError], copy.recordingFailed, { cause: error }) }
      throw error
    }
  }

  return {
    async capture(conversation: Conversation, request: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'expectedRevision' | 'prompt'>,
      command: Extract<ScryTaskCommand, { kind: 'template' }>) {
      const frozen = { request: { ...request }, command: { ...command }, cwd: conversation.cwd }
      const captured = await deps.intake.captureTemplate(conversation, frozen.request, () => resolveWorkflowTemplateCommand(deps.templates(), frozen.cwd, frozen.command))
      if (captured.kind === 'rejected') return captured
      return { kind: 'captured' as const, workspace: captured.task.snapshot.workspace.cwd,
        submission: await metadata(captured.task, captured.resolvedTemplate?.kind === 'resolved' ? captured.resolvedTemplate.definition : undefined) }
    },
    prepare(reference: WorkflowTaskReference, orchestrator: WorkflowRoleBinding, roles: WorkflowRoleBinding[]) {
      const frozen = structuredClone({ reference, orchestrator, roles })
      taskSubmissionId(frozen.reference)
      const key = `template-task:${taskDigest(JSON.stringify(frozen))}`
      return receipts.submit(key, () => execute(frozen.reference, frozen.orchestrator, frozen.roles)).then(receipt =>
        receipt.status === 'duplicate' ? execute(frozen.reference, frozen.orchestrator, frozen.roles) : receipt.result)
    },
    async inspect(task: WorkflowTaskSubmission, conversation: Conversation, command: string): Promise<WorkflowTemplateTaskInspection> {
      if (task.snapshot.operation !== 'workflow_template') throw new Error(copy.branchConflict)
      const submission = await metadata(task), state = task.state
      let outcome: WorkflowTemplateTaskInspection['outcome']
      if (submission.template.state !== 'available') outcome = { kind: 'blocked', reason: 'unknown' }
      else if (state.kind === 'captured') {
        const reason = conversation.archivedAt ? 'archived' : task.capturedBy !== deps.ownerEpoch ? 'interrupted' :
          conversation.cwd !== task.snapshot.workspace.cwd || await taskWorkspaceIdentity(conversation.cwd) !== task.snapshot.workspace.identity ? 'context_changed' : undefined
        outcome = reason ? { kind: 'blocked', reason } : { kind: 'configure' }
      } else {
        const candidate = state.branch === 'workflow' && state.planningRequestHash
          ? await deps.service.observeCapturedTemplate(task.submissionId, state.planningRequestHash, task.snapshot.template, command, task.snapshot.workspace.cwd) : null
        if (candidate && 'workflowId' in state && state.workflowId && state.workflowId !== candidate.preview.workflowId) throw new Error(copy.receiptMissing)
        outcome = candidate ? { kind: 'preview', ...candidate } : { kind: 'blocked', reason: 'unknown' }
      }
      return { task: workflowTaskSummary(task), command, workspace: task.snapshot.workspace.cwd, submission, observedAt: Date.now(), outcome }
    }
  }
}
