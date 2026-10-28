import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationSendRequest, ConversationSubmissionRequest } from '../shared/conversation-api'
import type { Conversation } from '../shared/conversation'
import { SCRY_WORKFLOW_COMMAND_ID } from '../shared/task-command'
import { capabilityUnavailable, type CapabilityEnvelope, type ProviderCommand, type ProviderContext } from '../shared/provider'
import { taskSubmissionCopy as copy } from '../shared/constants/copy'
import { CommandReceipts } from './command-receipts'
import { assertConversationForSend } from './conversation-send'
import type { ConversationStore } from './conversation-store'
import type { ConversationService, ConversationServiceDeps } from './conversation-service'
import { assertPlainConversationInput, parseConversationSend, parseConversationTarget } from './conversation-request'
import { createTaskCommandCatalog } from './task-command'
import { PerformanceTrace } from './performance-timing'
import type { resolveWorkflowTemplateCommand } from './workflow-template-command'
import type { WorkflowTemplateEditTarget } from '../shared/workflow-route'
import { readWorkflowSize } from './workflow-size-guideline'
import {
  prepareTaskInput, prepareTemplateEditTaskInput, prepareWorkflowTaskInput, taskDigest, taskSubmissionId,
  type PreparedTaskInput, type TaskSizeSnapshot, type DirectTaskSubmission, type TaskSubmissionKey,
  type TemplateEditTaskSelection
} from './task-submission-record'

export async function taskWorkspaceIdentity(cwd: string): Promise<string> {
  const canonical = await realpath(cwd)
  const info = await stat(cwd)
  if (canonical !== cwd || !info.isDirectory()) throw new Error(copy.contextChanged)
  return taskDigest(JSON.stringify([canonical, info.dev, info.ino]))
}

/** Desktop intake authority, composed explicitly in main before direct run
 * reservation. Workspace-only intake does not grant authoring, fees or execution;
 * preparation and execution remain owned by the existing Workflow Service. */
export function createDesktopTaskEntry(deps: {
  store: () => ConversationStore
  service: () => ConversationService
  getUserData: () => string
  resolveContinuationKey: ConversationServiceDeps['resolveContinuationKey']
  discoverCommands: (context: ProviderContext) => Promise<CapabilityEnvelope<ProviderCommand[]>>
}) {
  const ownerEpoch = randomUUID()
  const receipts = new CommandReceipts<{ runId: string; disposition: 'created' | 'duplicate' }>()

  async function sizeSnapshot(): Promise<TaskSizeSnapshot> {
    try {
      const { snapshot } = await readWorkflowSize(join(deps.getUserData(), 'workflows'))
      return { state: 'available', snapshot, readAt: Date.now() }
    } catch (error) {
      // Invalid workflow settings must not redirect or block ordinary off-mode
      // chat. Retain unavailable evidence; do not manufacture medium/default.
      return { state: 'unavailable', reason: String(error).slice(0, 4096), readAt: Date.now() }
    }
  }

  async function assertContext(task: DirectTaskSubmission): Promise<void> {
    const snapshot = task.snapshot
    const identity = await taskWorkspaceIdentity(snapshot.workspace.cwd)
    const continuationKey = await deps.resolveContinuationKey({
      providerId: snapshot.target.providerId,
      agentProfileId: snapshot.target.agentProfileId,
      cwd: snapshot.workspace.cwd
    })
    if (identity !== snapshot.workspace.identity || continuationKey !== snapshot.target.continuationKey) {
      throw new Error(copy.contextChanged)
    }
  }

  async function observeExisting(request: ConversationSendRequest, task: DirectTaskSubmission) {
    const state = task.state
    if (state.kind === 'captured') throw new Error(copy.interrupted)
    if (state.branch !== 'direct') throw new Error(copy.branchConflict)
    const store = deps.store()
    // Only append-only canonical turn evidence permits this validation call.
    // Without it, send() could allocate a fresh attempt: never replay an intent.
    const turn = await store.findDispatch(request.conversationId, request.commandId)
    if (!turn) throw new Error(copy.unknown)
    const result = await deps.service().send(request)
    if (state.kind === 'associated' || (state.kind === 'unknown' && state.runId !== undefined)) {
      if (state.runId !== result.runId) throw new Error(copy.receiptMissing)
    } else {
      await store.associateDirectTask(task, task.revision, state.ownerEpoch, result.runId)
    }
    return result
  }

  async function execute(request: ConversationSendRequest, prepared: PreparedTaskInput) {
    const store = deps.store()
    const key: TaskSubmissionKey = { conversationId: request.conversationId, commandId: request.commandId }
    let task = await store.readTaskSubmission(key)
    if (task && task.version !== 1) throw new Error(copy.branchConflict)
    if (!task) {
      // A pre-upgrade durable command remains historical. Do not fabricate a
      // submission/policy/size snapshot or charge routing on its replay.
      if (await store.findDispatch(key.conversationId, key.commandId)) return deps.service().send(request)
      const { conversation, target } = await deps.service().prepareSubmission(request)
      const context = {
        conversationRevision: conversation.revision,
        target,
        workspace: { cwd: conversation.cwd, identity: await taskWorkspaceIdentity(conversation.cwd) },
        size: await sizeSnapshot()
      }
      // All values are frozen before waiting for the Store's shared admission.
      const captured = await store.captureTaskSubmission({ request, prepared, context, ownerEpoch })
      task = captured.task
    }
    if (task.snapshot.input.sha256 !== prepared.sha256) throw new Error(copy.changedInput)
    if (task.state.kind !== 'captured' || task.capturedBy !== ownerEpoch) return observeExisting(request, task)
    await assertContext(task)
    const claimed = await store.claimTaskDispatch(key, task.revision, 'direct', ownerEpoch)
    if (claimed.version !== 1) throw new Error(copy.branchConflict)
    try {
      const result = await deps.service().send({
        ...request,
        expectedRevision: claimed.snapshot.conversationRevision,
        expectedContinuationKey: claimed.snapshot.target.continuationKey,
        confirmFresh: claimed.snapshot.confirmFresh
      }, async (actualRunId) => {
        await assertContext(claimed)
        const latest = await store.readTaskSubmission(key)
        // startAppRun returns the reservation while Provider preparation is
        // still asynchronous. A known association is not a finished attempt.
        const state = latest?.state
        const open = state?.kind === 'dispatch_intent' ||
          (state?.kind === 'associated' && state.branch === 'direct' && state.runId === actualRunId)
        if (!open || state.branch !== 'direct' || state.ownerEpoch !== ownerEpoch ||
          latest?.snapshot.input.sha256 !== claimed.snapshot.input.sha256) throw new Error(copy.wrongOwner)
      })
      await store.associateDirectTask(key, claimed.revision, ownerEpoch, result.runId)
      return result
    } catch (error) {
      try {
        const latest = await store.readTaskSubmission(key)
        if (latest?.state.kind === 'dispatch_intent' && latest.state.ownerEpoch === ownerEpoch) {
          await store.markTaskDispatchUnknown(key, latest.revision, ownerEpoch, String(error).slice(0, 4096))
        }
      } catch (recordingError) {
        throw new AggregateError([error, recordingError], copy.recordingFailed, { cause: error })
      }
      throw error
    }
  }

  async function captureWorkspaceTask(conversation: Conversation,
    input: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'expectedRevision' | 'prompt'>,
    resolveTemplate?: () => ReturnType<typeof resolveWorkflowTemplateCommand>) {
    const request = { ...input }, key = { conversationId: request.conversationId, commandId: request.commandId }
    const cwd = conversation.cwd, revision = conversation.revision, archived = conversation.archivedAt
    const store = deps.store()
    let task = await store.readTaskSubmission(key)
    let resolvedTemplate: Awaited<ReturnType<typeof resolveWorkflowTemplateCommand>> | undefined
    if (task) {
      if (task.version !== 2 || task.snapshot.operation !== (resolveTemplate ? 'workflow_template' : 'workflow_run')) throw new Error(copy.changedInput)
      const template = task.snapshot.operation === 'workflow_template' ? task.snapshot.template : undefined
      if (task.snapshot.input.sha256 !== prepareWorkflowTaskInput(request, template).sha256) throw new Error(copy.changedInput)
      if (task.snapshot.workspace.cwd !== cwd) throw new Error(copy.contextChanged)
    } else {
      if (archived) return { kind: 'rejected' as const, error: copy.conversationArchived }
      if (revision !== request.expectedRevision) return { kind: 'rejected' as const, error: copy.conversationChanged }
      if (await store.findDispatch(key.conversationId, key.commandId)) throw new Error(copy.branchConflict)
      // Resolve only a fresh task. Reopening a captured command must not consult
      // its mutable catalogue source or silently replace the frozen revision.
      resolvedTemplate = await resolveTemplate?.()
      if (resolvedTemplate?.kind === 'rejected') return resolvedTemplate
      const template = resolvedTemplate ? structuredClone(resolvedTemplate.ref) : undefined
      const prepared = prepareWorkflowTaskInput(request, template)
      const context = { conversationRevision: revision,
        workspace: { cwd, identity: await taskWorkspaceIdentity(cwd) }, size: await sizeSnapshot() }
      task = (await store.captureWorkflowTask({ request, prepared, context, template, ownerEpoch })).task
    }
    return { kind: 'captured' as const, task, resolvedTemplate }
  }

  async function captureTemplateEdit(conversation: Conversation,
    input: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'expectedRevision' | 'prompt'>,
    instruction: string,
    target: WorkflowTemplateEditTarget | undefined,
    selection: TemplateEditTaskSelection) {
    const request = structuredClone(input), frozenTarget = target ? structuredClone(target) : undefined
    const frozenSelection = structuredClone(selection), key = { conversationId: request.conversationId, commandId: request.commandId }
    const prepared = prepareTemplateEditTaskInput(request, instruction, frozenTarget, frozenSelection)
    const cwd = conversation.cwd, revision = conversation.revision, archived = conversation.archivedAt
    const store = deps.store()
    let task = await store.readTaskSubmission(key)
    if (task) {
      if (task.version !== 3 || task.snapshot.input.sha256 !== prepared.sha256 || task.snapshot.workspace.cwd !== cwd) {
        throw new Error(copy.changedInput)
      }
    } else {
      if (archived) return { kind: 'rejected' as const, error: copy.conversationArchived }
      if (revision !== request.expectedRevision) return { kind: 'rejected' as const, error: copy.conversationChanged }
      if (await store.findDispatch(key.conversationId, key.commandId)) throw new Error(copy.branchConflict)
      const context = { conversationRevision: revision, workspace: { cwd, identity: await taskWorkspaceIdentity(cwd) } }
      task = (await store.captureTemplateEditTask({ request, prepared, context, instruction,
        ...(frozenTarget ? { target: frozenTarget } : {}), selection: frozenSelection, ownerEpoch })).task
    }
    if (task.version !== 3) throw new Error(copy.branchConflict)
    return { kind: 'captured' as const, task }
  }

  return {
    ownerEpoch,
    captureEdit: captureTemplateEdit,
    async captureTemplate(conversation: Conversation,
      request: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'expectedRevision' | 'prompt'>,
      resolveTemplate: () => ReturnType<typeof resolveWorkflowTemplateCommand>) {
      return captureWorkspaceTask(conversation, request, resolveTemplate)
    },
    async captureWorkflow(conversation: Conversation, request: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'expectedRevision' | 'prompt'>) {
      const result = await captureWorkspaceTask(conversation, request)
      if (result.kind === 'rejected') return result
      const { task } = result
      return { kind: 'captured' as const, workspace: task.snapshot.workspace.cwd,
        submission: { reference: { conversationId: task.conversationId, commandId: task.commandId }, planningCommandId: task.submissionId, size: task.snapshot.size } }
    },
    async commands(conversation: Pick<Conversation, 'id' | 'cwd'>, input?: unknown) {
      const scope = { conversationId: conversation.id, cwd: conversation.cwd }
      // Reading known Scry metadata does not implicitly launch a Provider CLI.
      // Native metadata remains unknown until explicitly requested.
      if (input === undefined) return createTaskCommandCatalog(scope)
      const request = parseConversationTarget(input)
      const context = { providerId: request.providerId, agentProfileId: request.agentProfileId, cwd: conversation.cwd }
      const trace = new PerformanceTrace('conversation.command_catalog')
      try {
        const continuationKey = await deps.resolveContinuationKey(context)
        trace.mark('native_identity')
        const native = await deps.discoverCommands(context)
        trace.mark('native_catalogue')
        // Discovery is asynchronous. Never bind old metadata to a newly selected
        // account/profile identity or silently retry the discovery.
        if (await deps.resolveContinuationKey(context) !== continuationKey) throw new Error(copy.contextChanged)
        trace.mark('identity_revalidated')
        const result = createTaskCommandCatalog({ ...scope, target: { providerId: context.providerId,
          agentProfileId: context.agentProfileId, continuationKey } }, native)
        trace.finish(undefined, result.provider.state === 'unknown' ? 'error' : 'completed')
        return result
      } catch (error) {
        trace.finish(undefined, 'error')
        return createTaskCommandCatalog(scope, capabilityUnavailable(context, 'unknown', String(error)))
      }
    },
    async submit(input: unknown, directGoal?: string): Promise<{ runId: string; disposition: 'created' | 'duplicate' }> {
      const original = parseConversationSend(input)
      // The optional goal is supplied only by main's resolved Scry dispatcher,
      // never forwarded from an IPC payload. Keep the complete command as the
      // immutable original goal while the normal executor receives its body.
      const request = directGoal === undefined ? original : { ...original, prompt: directGoal }
      assertPlainConversationInput(request)
      const key = { conversationId: request.conversationId, commandId: request.commandId }
      const prepared = prepareTaskInput(original, directGoal === undefined ? undefined : {
        id: SCRY_WORKFLOW_COMMAND_ID, origin: 'scry_workflow', operation: 'direct'
      })
      const receiptKey = `task:${taskDigest(JSON.stringify([taskSubmissionId(key), prepared.sha256]))}`
      // In-process coalescing is not authority. Failure eviction and pending
      // cache eviction still encounter the durable per-task branch fence.
      // Register before the first await: a slower metadata read must not let
      // a later replay replace the first request's fresh-context acknowledgement.
      const receipt = await receipts.submit(receiptKey, () => execute(request, prepared))
      // A cached response is not current conversation authority. Recheck the
      // durable deletion/archive fence without replaying the cached dispatch.
      if (receipt.status === 'duplicate') assertConversationForSend(await deps.store().read(request.conversationId))
      return { ...receipt.result, disposition: receipt.status === 'duplicate' ? 'duplicate' : receipt.result.disposition }
    }
  }
}
