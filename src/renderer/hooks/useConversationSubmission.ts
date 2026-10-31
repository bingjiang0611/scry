import { useCallback, useRef, useState } from 'react'
import type { ConversationApi, ConversationPage, ConversationSendRequest } from '@shared/conversation-api'
import type { AgentInputAttachment } from '@shared/runtime'
import { CONVERSATION_COPY } from '../constants/conversation-copy'
import { updateComposerDraft, type ComposerDraftAttachment, type ComposerDraftStore,
  type ComposerPendingSubmission } from '../composer-drafts'
import {
  clearPendingSubmission, resolvePendingSubmission, runSubmission, settleOwnedPending,
  type PendingResolution
} from '../composer-pending'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export interface ConversationSubmission {
  /** Matching pending receipt of this draft, if any. Its content is the durable copy. */
  pending?: ComposerPendingSubmission
  /** Last read-back answer; absent until the durable record was checked. */
  pendingHealth?: PendingResolution
  working: boolean
  /** Explicit send of the editable draft, or of a replaced known-not-sent original. */
  submit: (options?: SubmitOptions) => Promise<void>
  /** Read-only check of the exact command id; never dispatches. */
  checkPending: () => Promise<PendingResolution | undefined>
  /** Settles against an already-read page for exactly this command id. */
  settlePending: (commandId: string, turns: ConversationPage['turns']) => void
}

export interface SubmitOptions {
  /** Known-not-sent original this send replaces; only that receipt is cleared. */
  replaceCommandId?: string
  content?: { prompt: string; attachments: ComposerDraftAttachment[] }
}

/** Known-not-sent content, resent only after the user explicitly asks for it. */
export function resendContent(pending: ComposerPendingSubmission): SubmitOptions {
  return { replaceCommandId: pending.commandId,
    content: { prompt: pending.prompt, attachments: pending.attachments } }
}

/**
 * Instance-owned submission state for one conversation draft key.
 *
 * The exact prompt, images and command identity move into the bounded draft entry and
 * must be durable before any send IPC. A lost reply keeps that entry as `unknown` and
 * is resolved only by reading the authoritative record — never by resending the same
 * command id and never by assuming `not_sent`.
 */
export function useConversationSubmission({ api, draftStore, draftKey, expectedRevision, prepare,
  mounted, onError, onNotice, onSubmitted }: {
  api: ConversationApi
  draftStore: ComposerDraftStore
  draftKey: string
  /** Revision recorded with the receipt for provenance; the host re-verifies it. */
  expectedRevision: () => number | undefined
  prepare: (prompt: string, attachments: AgentInputAttachment[], commandId: string) => Promise<ConversationSendRequest>
  mounted: { current: boolean }
  onError: (error: string | undefined) => void
  onNotice: (notice: string | undefined) => void
  onSubmitted: () => void
}): ConversationSubmission {
  const busy = useRef(false)
  // Every explicit send takes the next sequence; a result from an older sequence (or a
  // closed view) may not write this child's draft entry any more.
  const sequence = useRef(0)
  const [working, setWorking] = useState(false)
  const [health, setHealth] = useState<PendingResolution>()
  const pending = draftStore.getSnapshot().get(draftKey)?.pending

  const settlePending = useCallback((commandId: string, turns: ConversationPage['turns']): void => {
    // A stale lookup or an older page settles nothing: only the named receipt may clear.
    const current = settleOwnedPending(draftStore.getSnapshot().get(draftKey)?.pending, commandId)
    if (!current) return
    const resolution = resolvePendingSubmission(current, turns)
    setHealth(resolution)
    if (resolution.kind !== 'accepted') return
    // Clearing the receipt is the only write. The draft store owns preview lifetime and
    // releases just the blob URLs nothing references any more, so a URL another draft
    // still uses survives; a second revoke here would break that shared reference.
    draftStore.update(drafts => updateComposerDraft(drafts, draftKey,
      draft => clearPendingSubmission(draft, current.commandId)).drafts)
    draftStore.flushDrafts()
    onNotice(CONVERSATION_COPY.pendingSettledAccepted)
  }, [draftKey, draftStore, onNotice])

  const checkPending = useCallback(async (): Promise<PendingResolution | undefined> => {
    const current = draftStore.getSnapshot().get(draftKey)?.pending
    if (!current) return undefined
    const commandId = current.commandId
    try {
      const page = await api.read(current.conversationId)
      // Read-only: this never sends, and a receipt that changed while the page was
      // loading is left for its own owner.
      settlePending(commandId, page.turns)
      return resolvePendingSubmission(current, page.turns)
    } catch (error) {
      // A failed read proves nothing about the submission and unlocks nothing.
      if (mounted.current) onError(CONVERSATION_COPY.pendingCheckFailed(message(error)))
      return undefined
    }
  }, [api, draftKey, draftStore, mounted, onError, settlePending])

  const submit = useCallback(async (options?: SubmitOptions): Promise<void> => {
    if (busy.current || !mounted.current) return
    const draft = draftStore.getSnapshot().get(draftKey)
    const input = options?.content ?? { prompt: draft?.input ?? '', attachments: draft?.attachments ?? [] }
    if (!input.prompt.trim() && input.attachments.length === 0) return
    const mine = ++sequence.current
    busy.current = true
    setWorking(true)
    setHealth(undefined)
    onError(undefined)
    onNotice(undefined)
    try {
      const result = await runSubmission({
        draftStore, draftKey, prepare,
        send: request => api.send(request),
        input: { ...input, ...(options?.replaceCommandId ? { replaceCommandId: options.replaceCommandId } : {}) },
        expectedRevision: expectedRevision(),
        isActive: () => mounted.current && sequence.current === mine
      })
      if (!mounted.current || sequence.current !== mine) return
      if (result.status === 'aborted') return
      if (result.status === 'sent') {
        onNotice(result.duplicate ? CONVERSATION_COPY.pendingDuplicate : undefined)
        onSubmitted()
      } else if (result.status === 'unknown') {
        onError(result.error)
        onNotice(CONVERSATION_COPY.pendingDispatchUnknown)
      } else onError(result.error)
    } finally {
      busy.current = false
      if (mounted.current) setWorking(false)
    }
  }, [api, draftKey, draftStore, expectedRevision, mounted, onError, onNotice, onSubmitted, prepare])

  return { pending, pendingHealth: health, working, submit, checkPending, settlePending }
}
