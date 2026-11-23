import type { ConversationPage, ConversationSendRequest, ConversationSendResult } from '@shared/conversation-api'
import type { AgentInputAttachment } from '@shared/runtime'
import { NOT_SENT_REASON_LIMIT, updateComposerDraft, type ComposerDraft, type ComposerDraftAttachment,
  type ComposerDraftStore, type ComposerPendingSubmission } from './composer-drafts'

export type PendingResolution =
  | { kind: 'accepted' }
  | { kind: 'not_sent' }
  | { kind: 'pending' }
  | { kind: 'unknown'; reason?: string }
  | { kind: 'absent' }

export function resolvePendingSubmission(
  pending: Pick<ComposerPendingSubmission, 'commandId'>,
  turns: ConversationPage['turns']
): PendingResolution {
  const turn = turns.find(candidate => candidate.commandId === pending.commandId)
  if (!turn) return { kind: 'absent' }
  const delivery = turn.delivery
  if (delivery.status === 'accepted') return { kind: 'accepted' }
  if (delivery.status === 'not_sent') return { kind: 'not_sent' }
  if (delivery.status === 'pending') return { kind: 'pending' }
  if (delivery.status === 'unknown') return { kind: 'unknown', reason: delivery.reason }
  return { kind: 'absent' }
}

export function dispatchedDraft(
  draft: ComposerDraft,
  pending: ComposerPendingSubmission,
  submittedIds: ReadonlySet<string>
): ComposerDraft {
  const input = draft.input === pending.prompt ? '' : draft.input
  return {
    ...(draft.workspace ? { workspace: draft.workspace } : {}),
    input,
    attachments: draft.attachments.filter(attachment => !submittedIds.has(attachment.id)),
    pending
  }
}

export function clearPendingSubmission(draft: ComposerDraft, commandId: string): ComposerDraft {
  if (draft.pending?.commandId !== commandId) return draft
  const { pending: _pending, ...rest } = draft
  return rest
}

export function updatePendingPhase(
  draft: ComposerDraft,
  commandId: string,
  phase: ComposerPendingSubmission['phase']
): ComposerDraft {
  if (draft.pending?.commandId !== commandId) return draft
  return { ...draft, pending: { ...draft.pending, phase } }
}

export function settleOwnedPending(
  current: ComposerPendingSubmission | undefined,
  commandId: string
): ComposerPendingSubmission | undefined {
  return current && current.commandId === commandId ? current : undefined
}

export interface PendingContent {
  prompt: string
  attachments: ComposerDraftAttachment[]
}

export function pendingContent(pending: ComposerPendingSubmission): PendingContent {
  return { prompt: pending.prompt, attachments: pending.attachments }
}

export type SubmissionResult =
  | { status: 'sent'; commandId: string; duplicate: boolean }
  | { status: 'not-sent'; commandId: string; error: string }
  | { status: 'unknown'; commandId: string; error: string }
  | { status: 'refused'; error: string }
  | { status: 'not-prepared'; error: string }
  | { status: 'aborted' }

export interface SubmissionInput {
  prompt: string
  attachments: ComposerDraftAttachment[]
  replaceCommandId?: string
}

export async function runSubmission({
  draftStore, draftKey, prepare, send, input, expectedRevision, isActive = () => true, now = Date.now()
}: {
  draftStore: Pick<ComposerDraftStore, 'getSnapshot' | 'update' | 'flushDrafts'>
  draftKey: string
  prepare: (prompt: string, attachments: AgentInputAttachment[], commandId: string) => Promise<ConversationSendRequest>
  send: (request: ConversationSendRequest) => Promise<ConversationSendResult>
  input: SubmissionInput
  expectedRevision?: number
  isActive?: () => boolean
  now?: number
}): Promise<SubmissionResult> {
  if (!isActive()) return { status: 'aborted' }
  let request: ConversationSendRequest
  try {
    request = await prepare(input.prompt, input.attachments.map(({ previewUrl: _preview, id: _id, ...rest }) => ({ ...rest })),
      globalThis.crypto.randomUUID())
  } catch (error) {
    return { status: 'not-prepared', error: error instanceof Error ? error.message : String(error) }
  }
  if (!isActive()) return { status: 'aborted' }
  const submission: ComposerPendingSubmission = {
    commandId: request.commandId,
    conversationId: request.conversationId,
    prompt: input.prompt,
    attachments: input.attachments,
    target: {
      providerId: request.providerId,
      ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {}),
      ...(request.model ? { model: { ...request.model } } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      permissionMode: request.permissionMode ?? 'default'
    },
    selectedItems: request.selectedItems.map(item => ({ ...item })),
    expectedRevision: expectedRevision ?? request.expectedRevision,
    expectedContinuationKey: request.expectedContinuationKey,
    phase: 'unknown',
    submittedAt: now
  }
  const previousDraft = draftStore.getSnapshot().get(draftKey)
  const submittedIds = new Set(input.attachments.map(attachment => attachment.id))
  let refused: boolean = false
  draftStore.update(drafts => {
    const result = updateComposerDraft(drafts, draftKey, draft => dispatchedDraft(
      input.replaceCommandId ? clearPendingSubmission(draft, input.replaceCommandId) : draft, submission, submittedIds))
    if (result.refused) { refused = true; return drafts }
    return result.drafts
  })
  if (refused) return { status: 'refused', error: PENDING_CAPACITY_FULL }
  if (draftStore.flushDrafts() !== true) {
    draftStore.update(drafts => {
      if (drafts.get(draftKey)?.pending?.commandId !== submission.commandId) return drafts
      const restored = new Map(drafts)
      if (previousDraft) restored.set(draftKey, previousDraft)
      else restored.delete(draftKey)
      return restored
    })
    return { status: 'refused', error: DURABLE_WRITE_FAILED }
  }
  try {
    const result = await send(request)
    if (result.status === 'not_sent') {
      draftStore.update(drafts => updateComposerDraft(drafts, draftKey,
        draft => markPendingNotSent(draft, request.commandId, result.reason)).drafts)
      draftStore.flushDrafts()
      return { status: 'not-sent', commandId: request.commandId, error: result.reason }
    }
    draftStore.update(drafts => updateComposerDraft(drafts, draftKey,
      draft => updatePendingPhase(draft, request.commandId, 'dispatched')).drafts)
    draftStore.flushDrafts()
    return { status: 'sent', commandId: request.commandId, duplicate: result.disposition === 'duplicate' }
  } catch (error) {
    draftStore.update(drafts => updateComposerDraft(drafts, draftKey,
      draft => updatePendingPhase(draft, request.commandId, 'unknown')).drafts)
    draftStore.flushDrafts()
    return { status: 'unknown', commandId: request.commandId,
      error: error instanceof Error ? error.message : String(error) }
  }
}

export function markPendingNotSent(draft: ComposerDraft, commandId: string, reason: string): ComposerDraft {
  if (draft.pending?.commandId !== commandId) return draft
  return { ...draft, pending: { ...draft.pending, notSent: { reason: reason.slice(0, NOT_SENT_REASON_LIMIT) } } }
}

export const DURABLE_WRITE_FAILED = '本地存储不可用，发送状态与原文无法保存；本次没有发送。'
export const PENDING_CAPACITY_FULL =
  '待核对的发送已有 8 条；为避免覆盖最旧一条的原文，本次没有发送。请先核对其中一条的状态。'

export type PendingRecoveryState = 'not_sent' | 'unresolved'

export function pendingRecovery(
  pending: Pick<ComposerPendingSubmission, 'phase' | 'notSent'>,
  health: PendingResolution | undefined
): { state: PendingRecoveryState; reason?: string } | undefined {
  if (health?.kind === 'not_sent') return { state: 'not_sent' }
  if (health?.kind === 'unknown') return { state: 'unresolved', ...(health.reason ? { reason: health.reason } : {}) }
  if (pending.notSent !== undefined) return { state: 'not_sent', reason: pending.notSent.reason }
  if (health?.kind === 'absent') return { state: 'unresolved' }
  if (health?.kind === 'pending' && pending.phase === 'unknown') return { state: 'unresolved' }
  if (health === undefined && pending.phase === 'unknown') return { state: 'unresolved' }
  return undefined
}
