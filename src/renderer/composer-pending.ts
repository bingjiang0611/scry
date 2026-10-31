import type { ConversationPage, ConversationSendRequest } from '@shared/conversation-api'
import type { AgentInputAttachment } from '@shared/runtime'
import { updateComposerDraft, type ComposerDraft, type ComposerDraftAttachment, type ComposerDraftStore,
  type ComposerPendingSubmission } from './composer-drafts'

/**
 * What the durable record proves about one pending submission.
 *
 * `absent` is deliberately not `not_sent`: a read of the latest page cannot prove a
 * concurrent IPC never reached the host, so the renderer keeps it blocked.
 */
export type PendingResolution =
  | { kind: 'accepted' }
  | { kind: 'not_sent' }
  | { kind: 'pending' }
  | { kind: 'unknown'; reason?: string }
  | { kind: 'absent' }

/** Matches the command id the dispatch published, never a run id or a prompt guess. */
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

/**
 * The submitted content moves into the receipt; one copy of every byte stays in the
 * bounded draft entry. Anything the user typed or attached while the request was
 * being prepared is theirs and stays editable: only the exact submitted text and
 * the exact submitted attachments leave the composer.
 */
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

/** Only the matching command clears; a newer edit or another submission is untouched. */
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

/**
 * Only the named receipt may be settled by an answer that was read for it. A page read
 * before a newer submission existed cannot clear or relabel the newer one.
 */
export function settleOwnedPending(
  current: ComposerPendingSubmission | undefined,
  commandId: string
): ComposerPendingSubmission | undefined {
  return current && current.commandId === commandId ? current : undefined
}

/** Content a known-not-sent original may be resent with; a fresh command id is added by the caller. */
export interface PendingContent {
  prompt: string
  attachments: ComposerDraftAttachment[]
}

export function pendingContent(pending: ComposerPendingSubmission): PendingContent {
  return { prompt: pending.prompt, attachments: pending.attachments }
}

export type SubmissionResult =
  | { status: 'sent'; commandId: string; duplicate: boolean }
  | { status: 'unknown'; commandId: string; error: string }
  | { status: 'refused'; error: string }
  | { status: 'not-prepared'; error: string }
  /** The view or its submission was gone before anything was written or sent. */
  | { status: 'aborted' }

export interface SubmissionInput {
  prompt: string
  attachments: ComposerDraftAttachment[]
  /** Known-not-sent original this submission replaces; only that receipt is cleared. */
  replaceCommandId?: string
}

/**
 * One explicit send: prepare the exact request, move the content into a durable
 * pending receipt, then dispatch.
 *
 * Order matters. The receipt must be on disk before the send IPC, because a reply
 * lost afterwards can only be recovered from that record. If the durable write
 * fails the send is refused and the live draft is restored rather than dispatched
 * from memory. No path resends an unresolved command id by itself.
 */
export async function runSubmission({
  draftStore, draftKey, prepare, send, input, expectedRevision, isActive = () => true, now = Date.now()
}: {
  draftStore: Pick<ComposerDraftStore, 'getSnapshot' | 'update' | 'flushDrafts'>
  draftKey: string
  prepare: (prompt: string, attachments: AgentInputAttachment[], commandId: string) => Promise<ConversationSendRequest>
  send: (request: ConversationSendRequest) => Promise<{ disposition: 'created' | 'duplicate' }>
  input: SubmissionInput
  expectedRevision?: number
  /**
   * Owns this child draft right now. A closed view or a newer submission answers false,
   * and a preparation that answers late writes and sends nothing.
   */
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
  // Preparation is the only await before the receipt exists. Losing ownership here is
  // the close/reopen and supersession case: nothing has been written or dispatched.
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
    // Nothing is acknowledged yet: `unknown` is the honest durable state.
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
  // The pending reserve is full: refuse before dispatch and leave every draft intact.
  if (refused) return { status: 'refused', error: PENDING_CAPACITY_FULL }
  if (draftStore.flushDrafts() !== true) {
    // Undo only this child's entry, and only while it is still our receipt.
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
    draftStore.update(drafts => updateComposerDraft(drafts, draftKey,
      draft => updatePendingPhase(draft, request.commandId, 'dispatched')).drafts)
    draftStore.flushDrafts()
    return { status: 'sent', commandId: request.commandId, duplicate: result.disposition === 'duplicate' }
  } catch (error) {
    // The reply was lost or failed after dispatch: keep the receipt unresolved.
    draftStore.update(drafts => updateComposerDraft(drafts, draftKey,
      draft => updatePendingPhase(draft, request.commandId, 'unknown')).drafts)
    draftStore.flushDrafts()
    return { status: 'unknown', commandId: request.commandId,
      error: error instanceof Error ? error.message : String(error) }
  }
}

export const DURABLE_WRITE_FAILED = '本地存储不可用，发送状态与原文无法保存；本次没有发送。'
export const PENDING_CAPACITY_FULL =
  '待核对的发送已有 8 条；为避免覆盖最旧一条的原文，本次没有发送。请先核对其中一条的状态。'

/** Visible state of a pending receipt; copy lives in the constants module. */
export type PendingRecoveryState = 'not_sent' | 'unresolved'

/**
 * Which recovery state the user must see, if any.
 *
 * `waiting` (a recorded dispatch whose run is still open) needs no recovery block:
 * the run status already covers it. A missing record is shown as unresolved, never
 * as unsent, so nothing here can unlock an accidental duplicate send.
 */
export function pendingRecovery(
  pending: Pick<ComposerPendingSubmission, 'phase'>,
  health: PendingResolution | undefined
): { state: PendingRecoveryState; reason?: string } | undefined {
  if (health?.kind === 'not_sent') return { state: 'not_sent' }
  if (health?.kind === 'unknown') return { state: 'unresolved', ...(health.reason ? { reason: health.reason } : {}) }
  if (health?.kind === 'absent') return { state: 'unresolved' }
  if (health === undefined && pending.phase === 'unknown') return { state: 'unresolved' }
  return undefined
}
