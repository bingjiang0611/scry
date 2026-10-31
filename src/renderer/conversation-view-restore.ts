import type { ConversationPage } from '@shared/conversation-api'
import { MAX_RESTORE_PAGES, type SideChatViewPosition } from './side-chat-view-state'

/** A remembered reading position that is still waiting to be applied. */
export interface PendingViewRestore {
  conversationId: string
  position: SideChatViewPosition
  attempts: number
  /** The window this restore asked for, so a hand-paged window is not mistaken for it. */
  requestedBefore?: number
}

export interface ViewRestoreRequest {
  restore: PendingViewRestore
  conversationId: string
  /** The loaded window's slice end; `undefined` while the newest window is shown. */
  before: number | undefined
  page: ConversationPage
  element: HTMLElement
  requestBefore: (before: number) => void
  /** Once the restore commits, the transcript follows the latest turn again. */
  follow: (atBottom: boolean) => void
  clear: () => void
}

/**
 * One step of a remembered-view restore, applied against the window that is really loaded.
 *
 * The restore may once ask for its own older page, which is the only page read it is
 * allowed to make. Any other window means the reader paged somewhere by hand, and that
 * choice wins over the remembered position. While that read is still in flight the loaded
 * page is the previous window, so applying the anchor to it would move the restore one page
 * further back on every commit.
 *
 * Returns whether the restore handled this commit: `false` leaves the ordinary "stay on the
 * newest window" path in charge.
 */
export function applyViewRestore({ restore, conversationId, before, page, element, requestBefore, follow, clear }: ViewRestoreRequest): boolean {
  if (restore.conversationId !== conversationId) return false
  if (before !== undefined && restore.requestedBefore !== before) { clear(); return true }
  if (before !== undefined && page.turns.at(-1)?.ordinal !== before) return true
  follow(restore.position.atBottom)
  if (restore.position.atBottom) {
    // "Was at the bottom" stays pinned to the bottom, whatever arrived meanwhile.
    clear()
    element.scrollTop = element.scrollHeight
    return true
  }
  const anchor = restore.position.anchorRunId
    ? element.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(restore.position.anchorRunId)}"]`)
    : null
  if (anchor) {
    // The anchor is a turn, not an offset: the browser positions that turn relative to the
    // same top edge, so a longer or shorter newest window cannot move the reader.
    clear()
    const bounds = element.getBoundingClientRect()
    element.scrollTop += anchor.getBoundingClientRect().top - bounds.top - restore.position.anchorOffset
    // The reader is inside this turn on purpose, part-way above the edge. Its own growth
    // must not be compensated, or the reader leaves the turn this restore just anchored;
    // transcript.tsx consumes this marker on the row's next measurement.
    anchor.dataset.restoreAnchor = 'true'
    return true
  }
  const target = restore.position.anchorOrdinal === undefined ? undefined
    : restore.position.anchorOrdinal - 1 + page.turns.length
  if (restore.attempts === 0 && target !== undefined && target !== before) {
    // The remembered turn carries its own ordinal, so one bounded read is enough at any
    // transcript depth: the window ends one page past the anchor's own index, which puts the
    // anchor at its own reading position instead of scanning backwards a fixed number of
    // pages. `before` is a slice end while an ordinal is 1-based, so the anchor's own index
    // is `ordinal - 1`.
    restore.attempts = 1
    restore.requestedBefore = target
    requestBefore(target)
    return true
  }
  if (page.nextBeforeOrdinal !== undefined && restore.attempts < MAX_RESTORE_PAGES) {
    // No ordinal (a live placeholder turn, or an older record): walk bounded older pages
    // while the anchor is still missing, and let the caller run again on the new page.
    restore.attempts += 1
    restore.requestedBefore = page.nextBeforeOrdinal
    requestBefore(page.nextBeforeOrdinal)
    return true
  }
  // Not found in any window this view will read: land on the oldest loaded turn instead of
  // presenting a remembered offset as exact.
  clear()
  element.scrollTop = 0
  return true
}
