import { open, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomicExclusive, writeJsonAtomic } from '../core/turn-recorder/io'
import { readRecorderContentPage, writeRecorderContent } from '../core/turn-recorder/content-store'
import type { DispatchedConversationTurn } from '../shared/conversation'
import type { ConversationSendRequest, ConversationSubmissionRequest } from '../shared/conversation-api'
import { taskSubmissionCopy as copy } from '../shared/constants/copy'
import { workflowTaskCopy } from '../shared/constants/workflow-task-copy'
import type { WorkflowTaskPage } from '../shared/workflow-api'
import type { WorkflowTemplateRef } from '../shared/workflow-template'
import type { WorkflowTemplateEditTarget } from '../shared/workflow-route'
import { idPattern, maxBytes, object, requireValue } from './conversation-record'
import { ConversationStoreFoundation } from './conversation-store-foundation'
import {
  decodeTaskSubmission, taskSubmissionId, prepareTemplateEditTaskInput, prepareWorkflowTaskInput, workflowTaskSummary,
  type PreparedTaskInput, type TaskCapturedContext, type TaskDispatchBranch, type TemplateEditTaskContext,
  type TemplateEditTaskSelection, type TaskSubmission, type TaskSubmissionKey, type TaskSubmissionState, type WorkflowTaskContext
} from './task-submission-record'

type CaptureRequest = { prepared: PreparedTaskInput; ownerEpoch: string } & (
  { kind: 'direct'; request: ConversationSendRequest; context: TaskCapturedContext } |
  { kind: 'workflow'; request: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'expectedRevision'>; context: WorkflowTaskContext; template?: WorkflowTemplateRef } |
  { kind: 'template_edit'; request: Pick<ConversationSubmissionRequest, 'conversationId' | 'commandId' | 'expectedRevision' | 'prompt'>;
    context: TemplateEditTaskContext; instruction: string; target?: WorkflowTemplateEditTarget; selection: TemplateEditTaskSelection }
)

/** Same concrete ConversationStore, same admission and native ownership map.
 * Submission files are intake facts, not another scheduler or Provider ledger. */
export abstract class ConversationTaskStore extends ConversationStoreFoundation {
  protected abstract findDispatch(id: string, commandId: string): Promise<DispatchedConversationTurn | undefined>

  private submissionPath(key: TaskSubmissionKey): string {
    return join(this.userData, 'conversation-submissions-v1', key.conversationId, `${taskSubmissionId(key)}.json`)
  }

  private submissionInputRoot(key: TaskSubmissionKey): string {
    return join(this.userData, 'conversation-submissions-v1', key.conversationId, `${taskSubmissionId(key)}.input`)
  }

  async readTaskSubmission(key: TaskSubmissionKey): Promise<TaskSubmission | null> {
    let handle
    try { handle = await open(this.submissionPath(key), 'r') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      // All publishers replace the inode atomically; never append to metadata.
      requireValue((await handle.stat()).size <= maxBytes, copy.tooLarge)
      const task = decodeTaskSubmission(JSON.parse(await handle.readFile('utf8')))
      requireValue(task.conversationId === key.conversationId && task.commandId === key.commandId, copy.invalid)
      return task
    } finally { await handle.close() }
  }

  async readTaskInputPage(key: TaskSubmissionKey, options: { offset?: number; limit?: number } = {}) {
    const task = await this.readTaskSubmission(key)
    requireValue(task !== null, copy.missing)
    // Never accept a renderer-supplied body ref or arbitrary path.
    return readRecorderContentPage(this.submissionInputRoot(key), task.snapshot.input, options)
  }

  async listWorkflowTasks(conversationId: string, options: { cursor?: string; limit?: number } = {}): Promise<WorkflowTaskPage> {
    const { cursor, limit = 10 } = options
    requireValue(idPattern.test(conversationId) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 10 &&
      (cursor === undefined || /^submission-[a-f0-9]{64}$/.test(cursor)), copy.invalid)
    let directory
    try { directory = await opendir(join(this.userData, 'conversation-submissions-v1', conversationId)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], observedAt: Date.now() }
      throw error
    }
    const names: string[] = []
    let scanned = 0
    for await (const entry of directory) {
      requireValue(++scanned <= 8192, workflowTaskCopy.tooManyEntries)
      if (!/^submission-[a-f0-9]{64}\.json$/.test(entry.name)) continue
      requireValue(entry.isFile(), copy.invalid)
      const id = entry.name.slice(0, -5)
      if (cursor !== undefined && id <= cursor) continue
      names.push(id)
      names.sort()
      if (names.length > limit + 1) names.pop()
    }
    // Hash ordering is stable, not creation order. New names before the cursor
    // appear on refresh. A page is an observation, not a global snapshot.
    const items: WorkflowTaskPage['items'] = []
    for (const id of names.slice(0, limit)) {
      const handle = await open(join(this.userData, 'conversation-submissions-v1', conversationId, `${id}.json`), 'r')
      try {
        requireValue((await handle.stat()).size <= maxBytes, copy.tooLarge)
        const task = decodeTaskSubmission(JSON.parse(await handle.readFile('utf8')))
        requireValue(task.conversationId === conversationId && task.submissionId === id, copy.invalid)
        if (task.version === 2 || task.version === 3) items.push(workflowTaskSummary(task))
      } finally { await handle.close() }
    }
    return { items, ...(names.length > limit ? { nextCursor: names[limit - 1] } : {}), observedAt: Date.now() }
  }

  async readTemplateEditTaskInput(key: TaskSubmissionKey) {
    const task = await this.readTaskSubmission(key)
    requireValue(task?.version === 3, copy.branchConflict)
    const page = await readRecorderContentPage(this.submissionInputRoot(key), task.snapshot.input, { limit: 256 * 1024 })
    requireValue(!page.hasMore, copy.tooLarge)
    const raw = object(JSON.parse(Buffer.from(page.dataBase64, 'base64').toString('utf8')))
    requireValue(typeof raw.originalGoal === 'string' && typeof raw.instruction === 'string', copy.invalid)
    requireValue(prepareTemplateEditTaskInput({ ...key, prompt: raw.originalGoal }, raw.instruction,
      task.snapshot.target, task.snapshot.selection).sha256 === task.snapshot.input.sha256, copy.changedInput)
    return { task, command: raw.originalGoal, instruction: raw.instruction }
  }

  async readWorkflowTaskInput(key: TaskSubmissionKey) {
    const task = await this.readTaskSubmission(key)
    requireValue(task?.version === 2, copy.branchConflict)
    // Current workflow intake is bounded to 16K characters. Read one complete,
    // integrity-checked page; never parse a clipped prefix or accept a body ref.
    const page = await readRecorderContentPage(this.submissionInputRoot(key), task.snapshot.input, { limit: 256 * 1024 })
    requireValue(!page.hasMore, copy.tooLarge)
    const raw = object(JSON.parse(Buffer.from(page.dataBase64, 'base64').toString('utf8')))
    requireValue(typeof raw.originalGoal === 'string', copy.invalid)
    requireValue(prepareWorkflowTaskInput({ ...key, prompt: raw.originalGoal }, task.snapshot.operation === 'workflow_template' ? task.snapshot.template : undefined).sha256 === task.snapshot.input.sha256, copy.changedInput)
    return { task, command: raw.originalGoal }
  }

  private async publishSubmission(task: TaskSubmission, exclusive = false): Promise<TaskSubmission> {
    const checked = decodeTaskSubmission(task)
    const bytes = Buffer.from(`${JSON.stringify(checked)}\n`)
    requireValue(bytes.length <= maxBytes, copy.tooLarge)
    if (exclusive) await writeFileAtomicExclusive(this.submissionPath(task), bytes)
    else await writeJsonAtomic(this.submissionPath(task), checked)
    return checked
  }

  async captureTaskSubmission(input: {
    request: ConversationSendRequest
    prepared: PreparedTaskInput
    context: TaskCapturedContext
    ownerEpoch: string
  }) {
    const result = await this.captureSubmission({ ...input, kind: 'direct' })
    requireValue(result.task.version === 1, copy.branchConflict)
    return { task: result.task, disposition: result.disposition }
  }

  async captureWorkflowTask(input: Omit<Extract<CaptureRequest, { kind: 'workflow' }>, 'kind'>) {
    const result = await this.captureSubmission({ ...input, kind: 'workflow' })
    requireValue(result.task.version === 2, copy.branchConflict)
    return { task: result.task, disposition: result.disposition }
  }

  async captureTemplateEditTask(input: Omit<Extract<CaptureRequest, { kind: 'template_edit' }>, 'kind'>) {
    const result = await this.captureSubmission({ ...input, kind: 'template_edit' })
    requireValue(result.task.version === 3, copy.branchConflict)
    return { task: result.task, disposition: result.disposition }
  }

  private async captureSubmission(input: CaptureRequest): Promise<{ task: TaskSubmission; disposition: 'created' | 'duplicate' }> {
    const { prepared, ownerEpoch } = input
    const { conversationId, commandId, expectedRevision } = input.request
    const native = input.kind === 'direct' ? { providerId: input.request.providerId, agentProfileId: input.request.agentProfileId,
      expectedContinuationKey: input.request.expectedContinuationKey, confirmFresh: input.request.confirmFresh } : undefined
    // Own the small authority snapshot before the first asynchronous boundary.
    const directContext = input.kind === 'direct' ? structuredClone(input.context) : undefined
    const workflowContext = input.kind === 'workflow' ? structuredClone(input.context) : undefined
    const editContext = input.kind === 'template_edit' ? structuredClone(input.context) : undefined
    const context = directContext ?? workflowContext ?? editContext!
    const template = input.kind === 'workflow' && input.template ? structuredClone(input.template) : undefined
    const edit = input.kind === 'template_edit' ? {
      instruction: input.instruction,
      ...(input.target ? { target: structuredClone(input.target) } : {}),
      selection: structuredClone(input.selection)
    } : undefined
    const createdAt = Date.now()
    const key = { conversationId, commandId }
    taskSubmissionId(key)
    // Seal the immutable input before queuing for shared Store admission. Large
    // body IO does not hold up unrelated native ownership publication. A losing
    // duplicate may leave an unreferenced blob, never an execution authority.
    const inputRef = await writeRecorderContent(this.submissionInputRoot(key), prepared.serialized, 'json')
    requireValue(inputRef.sha256 === prepared.sha256, copy.changedInput)
    return this.admission.run('ownership', async () => {
      const existing = await this.readTaskSubmission(key)
      if (existing) {
        requireValue(existing.snapshot.input.sha256 === prepared.sha256, copy.changedInput)
        return { task: existing, disposition: 'duplicate' }
      }
      const conversation = await this.required(key.conversationId)
      requireValue(!conversation.deletion && conversation.cwd === context.workspace.cwd &&
        conversation.revision === expectedRevision && context.conversationRevision === expectedRevision, copy.staleConversation)
      const header = { submissionId: taskSubmissionId(key), ...key, revision: 0, createdAt, capturedBy: ownerEpoch,
        state: { kind: 'captured' } as const }
      let task: TaskSubmission
      if (input.kind === 'direct') {
        requireValue(directContext!.target.providerId === native!.providerId && directContext!.target.agentProfileId === native!.agentProfileId &&
          directContext!.target.continuationKey === native!.expectedContinuationKey, copy.contextChanged)
        task = await this.publishSubmission({ ...header, version: 1,
          snapshot: { ...directContext!, source: 'desktop_conversation_send', policy: { mode: 'off', revision: 0 },
            input: inputRef, confirmFresh: native!.confirmFresh } }, true)
      } else if (input.kind === 'workflow') {
        task = await this.publishSubmission({ ...header, version: 2,
          snapshot: { ...workflowContext!, source: 'desktop_conversation_submit',
            ...(template ? { operation: 'workflow_template' as const, template } : { operation: 'workflow_run' as const }),
            policy: { mode: 'off', revision: 0 }, input: inputRef } }, true)
      } else {
        task = await this.publishSubmission({ ...header, version: 3,
          snapshot: { ...editContext!, source: 'desktop_conversation_submit', operation: 'template_edit',
            policy: { mode: 'off', revision: 0 }, input: inputRef,
            ...(edit?.target ? { target: edit.target } : {}), selection: edit!.selection } }, true)
      }
      return { task, disposition: 'created' }
    })
  }

  private async changeSubmission(key: TaskSubmissionKey, expectedRevision: number,
    change: (task: TaskSubmission) => Promise<TaskSubmissionState> | TaskSubmissionState): Promise<TaskSubmission> {
    return this.admission.run('ownership', async () => {
      const task = await this.readTaskSubmission(key)
      requireValue(task !== null, copy.missing)
      requireValue(task.revision === expectedRevision, copy.staleTask)
      if (task.version === 3) throw new Error(copy.branchConflict)
      const state = await change(task)
      return this.publishSubmission({ ...task, revision: task.revision + 1, state })
    })
  }

  async claimTaskDispatch(key: TaskSubmissionKey, expectedRevision: number, branch: TaskDispatchBranch, ownerEpoch: string, planningRequestHash?: string, authoringContinuationKey?: string): Promise<TaskSubmission> {
    return this.changeSubmission(key, expectedRevision, task => {
      requireValue(task.state.kind === 'captured' && (task.version === 1 || branch === 'workflow'), copy.branchConflict)
      requireValue(task.capturedBy === ownerEpoch, copy.interrupted)
      return { kind: 'dispatch_intent', branch, ownerEpoch,
        ...(task.version === 2 ? { planningRequestHash, ...(authoringContinuationKey ? { authoringContinuationKey } : {}) } : {}) }
    })
  }

  async associateDirectTask(key: TaskSubmissionKey, expectedRevision: number, ownerEpoch: string, runId: string): Promise<TaskSubmission> {
    return this.changeSubmission(key, expectedRevision, async task => {
      const state = task.state
      requireValue((state.kind === 'dispatch_intent' || state.kind === 'unknown') && state.branch === 'direct', copy.branchConflict)
      requireValue(state.ownerEpoch === ownerEpoch, copy.wrongOwner)
      const turn = await this.findDispatch(key.conversationId, key.commandId)
      requireValue(turn?.runId === runId, copy.receiptMissing)
      // Observing a canonical run never reopens an unknown dispatch fence.
      if (state.kind === 'unknown') {
        requireValue(state.runId === undefined || state.runId === runId, copy.receiptMissing)
        return { ...state, runId }
      }
      return { kind: 'associated', branch: 'direct', ownerEpoch, runId }
    })
  }

  async associateWorkflowTask(key: TaskSubmissionKey, expectedRevision: number, ownerEpoch: string,
    receipt: { workflowId: string; programRevision: string; planningRequestHash: string }): Promise<TaskSubmission> {
    return this.changeSubmission(key, expectedRevision, task => {
      const state = task.state
      requireValue(task.version === 2 && (state.kind === 'dispatch_intent' || state.kind === 'unknown') && state.branch === 'workflow', copy.branchConflict)
      requireValue(state.ownerEpoch === ownerEpoch && state.planningRequestHash === receipt.planningRequestHash, copy.receiptMissing)
      requireValue(state.kind !== 'unknown' || state.workflowId === undefined || state.workflowId === receipt.workflowId, copy.receiptMissing)
      // The main workflow entry resolves this receipt from the canonical root.
      // This is historical association, never execution approval or settlement.
      return state.kind === 'unknown' ? { ...state, ...receipt } : { kind: 'associated', branch: 'workflow', ownerEpoch, ...receipt,
        ...(state.authoringContinuationKey ? { authoringContinuationKey: state.authoringContinuationKey } : {}) }
    })
  }

  async fenceCapturedWorkflow(key: TaskSubmissionKey, expectedRevision: number, reason: string): Promise<TaskSubmission> {
    return this.changeSubmission(key, expectedRevision, task => {
      requireValue(task.version === 2 && task.state.kind === 'captured', copy.branchConflict)
      return { kind: 'unknown', branch: 'workflow', ownerEpoch: task.capturedBy, reason }
    })
  }

  async markTaskDispatchUnknown(key: TaskSubmissionKey, expectedRevision: number, ownerEpoch: string, reason: string): Promise<TaskSubmission> {
    return this.changeSubmission(key, expectedRevision, task => {
      const state = task.state
      requireValue(state.kind === 'dispatch_intent' || state.kind === 'associated', copy.branchConflict)
      requireValue(state.ownerEpoch === ownerEpoch, copy.wrongOwner)
      return { kind: 'unknown', branch: state.branch, ownerEpoch, reason,
        ...(state.branch === 'workflow' && state.planningRequestHash ? { planningRequestHash: state.planningRequestHash,
          ...(state.authoringContinuationKey ? { authoringContinuationKey: state.authoringContinuationKey } : {}) } : {}),
        ...(state.kind === 'associated' ? state.branch === 'direct' ? { runId: state.runId }
          : { workflowId: state.workflowId, programRevision: state.programRevision } : {}) }
    })
  }
}
