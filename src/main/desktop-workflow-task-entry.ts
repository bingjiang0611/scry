import type { WorkflowPlanPreview } from '../shared/workflow'
import type { ProviderContext } from '../shared/provider'
import type { WorkflowTaskInspection, WorkflowTaskReference } from '../shared/workflow-api'
import { taskSubmissionCopy as copy, workflowShutdownCopy, workflowTemplateCopy } from '../shared/constants/copy'
import type { ConversationStore } from './conversation-store'
import type { WorkflowStore } from './workflow-store'
import type { WorkflowService } from './workflow-service'
import type { WorkflowPlanRequest } from './workflow-service-contracts'
import { CommandReceipts } from './command-receipts'
import { taskWorkspaceIdentity, type createDesktopTaskEntry } from './desktop-task-entry'
import { createDesktopTemplateTaskEntry } from './desktop-template-task-entry'
import { createDesktopTemplateEditTaskEntry } from './desktop-template-edit-task-entry'
import type { WorkflowTemplateStore } from './workflow-template-store'
import type { WorkflowTemplateEditCandidateStore } from './workflow-template-edit-candidate-store'
import type { WorkflowTemplateEditApplicationStore } from './workflow-template-edit-application-store'
import { prepareWorkflowTaskInput, taskDigest, taskSubmissionId, workflowTaskSummary, type WorkflowTaskSubmission } from './task-submission-record'
import { idPattern } from './conversation-record'

/** Captured chat intake joins the existing planner. Neither this lookup nor a
 * returned preview approves execution, settles an actor or resets its budget. */
export function createDesktopWorkflowTaskEntry(deps: {
  conversations: () => ConversationStore
  workflows: WorkflowStore
  service: Pick<WorkflowService, 'planCommand' | 'cancelPlanning' | 'observeCapturedPlanning' | 'instantiateTemplate' | 'observeCapturedTemplate'>
  templates: () => WorkflowTemplateStore
  candidates?: WorkflowTemplateEditCandidateStore
  applications?: WorkflowTemplateEditApplicationStore
  intake: Pick<ReturnType<typeof createDesktopTaskEntry>, 'captureTemplate' | 'captureEdit'>
  ownerEpoch: string
  resolveWorkspace: (cwd: string) => Promise<string>
  resolveContinuationKey: (context: ProviderContext) => Promise<string>
}) {
  const receipts = new CommandReceipts<WorkflowPlanPreview>()

  async function required(reference: WorkflowTaskReference): Promise<WorkflowTaskSubmission> {
    const task = await deps.conversations().readTaskSubmission(reference)
    if (task?.version !== 2) throw new Error(copy.branchConflict)
    return task
  }

  async function readConversation(id: string) {
    if (!idPattern.test(id)) throw new Error(copy.invalid)
    const conversation = await deps.conversations().read(id)
    if (!conversation || conversation.deletion || await deps.resolveWorkspace(conversation.cwd) !== conversation.cwd) throw new Error(copy.contextChanged)
    return conversation
  }

  async function assertWorkspace(task: WorkflowTaskSubmission): Promise<void> {
    if (await deps.resolveWorkspace(task.snapshot.workspace.cwd) !== task.snapshot.workspace.cwd) throw new Error(copy.contextChanged)
    if (await taskWorkspaceIdentity(task.snapshot.workspace.cwd) !== task.snapshot.workspace.identity) throw new Error(copy.contextChanged)
    const conversation = await deps.conversations().read(task.conversationId)
    if (!conversation || conversation.deletion || conversation.archivedAt || conversation.cwd !== task.snapshot.workspace.cwd) throw new Error(copy.contextChanged)
  }

  async function associate(task: WorkflowTaskSubmission, preview: WorkflowPlanPreview, hash: string): Promise<void> {
    const root = await deps.workflows.load(preview.workflowId)
    if (!root || root.planningRequestHash !== hash || root.preview.programRevision !== preview.programRevision ||
      root.preview.workspace !== task.snapshot.workspace.cwd) throw new Error(copy.receiptMissing)
    const latest = await required(task)
    const state = latest.state
    if (state.kind === 'captured' || state.branch !== 'workflow' || state.planningRequestHash !== hash) throw new Error(copy.branchConflict)
    if (state.kind === 'associated') {
      if (state.workflowId !== preview.workflowId) throw new Error(copy.receiptMissing)
      return
    }
    if (state.kind === 'unknown' && state.workflowId) {
      if (state.workflowId !== preview.workflowId) throw new Error(copy.receiptMissing)
      return
    }
    await deps.conversations().associateWorkflowTask(task, latest.revision, state.ownerEpoch,
      { workflowId: preview.workflowId, programRevision: preview.programRevision, planningRequestHash: hash })
  }

  async function execute(request: WorkflowPlanRequest, reference: WorkflowTaskReference): Promise<WorkflowPlanPreview> {
    const task = await required(reference)
    if (task.snapshot.operation !== 'workflow_run') throw new Error(copy.branchConflict)
    const input = prepareWorkflowTaskInput({ ...reference, prompt: request.command })
    if (request.commandId !== task.submissionId || request.workspace !== task.snapshot.workspace.cwd ||
      input.sha256 !== task.snapshot.input.sha256) throw new Error(copy.changedInput)
    if (task.snapshot.size.state !== 'available') throw new Error(task.snapshot.size.reason)
    const store = deps.conversations()
    const observeOnly = task.state.kind !== 'captured'
    if (task.state.kind === 'captured') {
      if (task.capturedBy !== deps.ownerEpoch) throw new Error(copy.interrupted)
      await assertWorkspace(task)
    } else {
      if (task.state.branch !== 'workflow') throw new Error(copy.branchConflict)
      if (!task.state.planningRequestHash) throw new Error(copy.unknown)
    }
    // Bind the configured planner's actual transport/auth scope, not a renderer
    // account label. Old intents only observe their original optional fence.
    const authoringContinuationKey = task.state.kind === 'captured'
      ? await deps.resolveContinuationKey({ providerId: request.orchestrator.providerId, agentProfileId: request.orchestrator.agentProfileId,
        cwd: task.snapshot.workspace.cwd })
      : task.state.branch === 'workflow' ? task.state.authoringContinuationKey : undefined
    const frozen: WorkflowPlanRequest = { command: request.command, commandId: task.submissionId, workspace: task.snapshot.workspace.cwd,
      orchestrator: request.orchestrator, roles: request.roles, capturedTask: {
        reference: { conversationId: task.conversationId, commandId: task.commandId }, inputSha256: task.snapshot.input.sha256,
        sizeGuideline: task.snapshot.size.snapshot, ...(authoringContinuationKey ? { authoringContinuationKey } : {}) } }
    const hash = taskDigest(JSON.stringify(frozen))
    if (task.state.kind !== 'captured' && task.state.planningRequestHash !== hash) throw new Error(copy.changedInput)

    try {
      if (!observeOnly) await store.claimTaskDispatch(task, task.revision, 'workflow', deps.ownerEpoch, hash, authoringContinuationKey)
      // The callback is private and deliberately absent from the JSON request
      // fingerprint. Recheck after native preparation, before dispatch markers.
      frozen.beforeProviderDispatch = async () => {
        await assertWorkspace(task)
        const latest = await required(reference)
        if (latest.snapshot.input.sha256 !== input.sha256 || latest.state.kind !== 'dispatch_intent' ||
          latest.state.branch !== 'workflow' || latest.state.ownerEpoch !== deps.ownerEpoch ||
          latest.state.planningRequestHash !== hash) throw new Error(copy.unknown)
      }
      const preview = await deps.service.planCommand(frozen, observeOnly)
      await associate(task, preview, hash)
      return preview
    } catch (error) {
      try {
        const latest = await required(reference)
        if (latest.state.kind === 'dispatch_intent' && latest.state.ownerEpoch === deps.ownerEpoch && latest.state.planningRequestHash === hash) {
          await store.markTaskDispatchUnknown(reference, latest.revision, deps.ownerEpoch, String(error).slice(0, 4096))
        }
      } catch (recordingError) { throw new AggregateError([error, recordingError], copy.recordingFailed) }
      throw error
    }
  }

  const templates = createDesktopTemplateTaskEntry({ ...deps, required, readConversation, assertWorkspace })
  const edits = createDesktopTemplateEditTaskEntry({ conversations: deps.conversations, templates: deps.templates, candidates: deps.candidates, applications: deps.applications, intake: deps.intake })
  return {
    captureTemplate: templates.capture,
    captureEdit: edits.capture,
    prepareTemplate: templates.prepare,
    async list(conversationId: string, cursor?: string) {
      await readConversation(conversationId)
      return deps.conversations().listWorkflowTasks(conversationId, { cursor })
    },
    async inspect(reference: WorkflowTaskReference): Promise<WorkflowTaskInspection> {
      taskSubmissionId(reference)
      const conversation = await readConversation(reference.conversationId)
      const recorded = await deps.conversations().readTaskSubmission(reference)
      if (recorded?.version === 3) {
        const { task, command, instruction } = await deps.conversations().readTemplateEditTaskInput(reference)
        return edits.inspect(task, conversation, command, instruction)
      }
      const { task, command } = await deps.conversations().readWorkflowTaskInput(reference)
      if (task.snapshot.operation === 'workflow_template') return templates.inspect(task, conversation, command)
      const state = task.state
      let outcome: WorkflowTaskInspection['outcome']
      if (state.kind === 'captured') {
        const reason = task.snapshot.size.state !== 'available' ? 'invalid_size' : conversation.archivedAt ? 'archived' :
          task.capturedBy !== deps.ownerEpoch ? 'interrupted' : conversation.cwd !== task.snapshot.workspace.cwd ||
          await taskWorkspaceIdentity(conversation.cwd) !== task.snapshot.workspace.identity ? 'context_changed' : undefined
        outcome = reason ? { kind: 'blocked', reason } : { kind: 'configure' }
      } else {
        const candidate = state.branch === 'workflow' && state.planningRequestHash
          ? await deps.service.observeCapturedPlanning(task.submissionId, state.planningRequestHash, command, task.snapshot.workspace.cwd) : null
        if (candidate && 'workflowId' in state && state.workflowId && state.workflowId !== candidate.preview.workflowId) throw new Error(copy.receiptMissing)
        outcome = candidate ? { kind: 'preview', ...candidate } : { kind: 'blocked', reason: 'unknown' }
      }
      return { task: workflowTaskSummary(task), command, workspace: task.snapshot.workspace.cwd,
        submission: { reference: { conversationId: task.conversationId, commandId: task.commandId },
          planningCommandId: task.submissionId, size: task.snapshot.size }, observedAt: Date.now(), outcome }
    },
    plan(request: WorkflowPlanRequest, reference: WorkflowTaskReference): Promise<WorkflowPlanPreview> {
      taskSubmissionId(reference)
      reference = { conversationId: reference.conversationId, commandId: reference.commandId }
      const frozen = structuredClone({ command: request.command, commandId: request.commandId, workspace: request.workspace,
        orchestrator: request.orchestrator, roles: request.roles })
      // Bounded coalescing only. Every cache miss still encounters the durable
      // branch/configuration fence; a cold intent can only observe a root.
      const key = `task:${taskDigest(JSON.stringify([reference, frozen]))}`
      return receipts.submit(key, () => execute(frozen, reference)).then(receipt =>
        receipt.status === 'duplicate' ? execute(frozen, reference) : receipt.result)
    },
    async cancel(commandId: string, reference: WorkflowTaskReference): Promise<boolean> {
      const task = await required(reference)
      if (commandId !== task.submissionId) throw new Error(copy.changedInput)
      // Like legacy cancelPlanning, trusted IPC may cancel only the registered
      // planning identity. Archiving or removing its workspace must not prevent
      // cancellation; admission/dispatch still require current workspace authority.
      const reason = task.snapshot.operation === 'workflow_template' ? workflowTemplateCopy.preparationCancelled : workflowShutdownCopy.planningCancelled
      let fenced = false
      if (task.state.kind === 'captured') {
        await deps.conversations().fenceCapturedWorkflow(task, task.revision, reason)
        fenced = true
      } else if (task.state.kind === 'dispatch_intent') {
        await deps.conversations().markTaskDispatchUnknown(task, task.revision, task.state.ownerEpoch, reason)
        fenced = true
      }
      // Fixed preparation has no registered planner to signal. This boolean is
      // durable-fence acknowledgement, never proof of physical process exit.
      return task.snapshot.operation === 'workflow_template' ? fenced : deps.service.cancelPlanning(commandId)
    }
  }
}
