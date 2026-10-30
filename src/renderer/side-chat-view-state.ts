/**
 * Bounded memory of one side chat's own scroll position.
 *
 * Only mounted child views record here, and only the last sixteen children are kept.
 * The remembered value is an anchor — the turn at the top edge plus its distance from
 * that edge — not an absolute offset: a child left at the bottom of the newest window
 * stays pinned to the bottom, and a child the reader left mid-transcript returns to that
 * same turn even when the newest page changed while its tab was hidden. If the anchor turn
 * is not inside the loaded page, the conversation reads one bounded older page before
 * giving up, so an old offset is never presented as exact.
 */
export interface SideChatViewPosition {
  atBottom: boolean
  /** Run id of the turn at the top edge; absent when nothing was rendered. */
  anchorRunId?: string
  /**
   * Conversation ordinal of that same turn. A remembered ordinal lets a restore ask for the
   * exact bounded window in one read instead of walking back a fixed page budget, which
   * silently stopped reaching a reader deeper than that budget allowed.
   */
  anchorOrdinal?: number
  /** Scroller top → anchor turn top. Positive when the turn starts below the edge. */
  anchorOffset: number
  /** Turn count of the window this anchor was recorded against. */
  turnCount: number
}

const MAX_TRACKED = 16
const positions = new Map<string, SideChatViewPosition>()
/** Older pages a restore may read before it settles for the oldest loaded turn. */
export const MAX_RESTORE_PAGES = 3

export function rememberSideChatViewPosition(conversationId: string, position: SideChatViewPosition): void {
  positions.delete(conversationId)
  positions.set(conversationId, position)
  while (positions.size > MAX_TRACKED) {
    const oldest = positions.keys().next().value
    if (oldest === undefined) break
    positions.delete(oldest)
  }
}

export function readSideChatViewPosition(conversationId: string): SideChatViewPosition | undefined {
  return positions.get(conversationId)
}

export function isSideChatAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 8
}

/**
 * The anchor to remember for this scroller right now.
 *
 * `atNewestWindow` says whether this scroller shows the newest bounded window. The bottom
 * of a lower page is not the bottom of the conversation: only the newest window may be
 * remembered as "pinned to the bottom", or a reader who scrolled to the end of an older
 * page would be restored at the newest turn instead of where they were.
 */
export function sideChatViewPosition(element: HTMLElement, atNewestWindow = true): SideChatViewPosition {
  const bounds = element.getBoundingClientRect()
  const atBottom = atNewestWindow && isSideChatAtBottom(element)
  const turns = element.querySelectorAll<HTMLElement>('[data-run-id]')
  const turnCount = turns.length
  if (atBottom || turnCount === 0) return { atBottom, anchorOffset: 0, turnCount }
  for (const turn of turns) {
    const rect = turn.getBoundingClientRect()
    if (rect.bottom <= bounds.top) continue
    return {
      atBottom: false,
      anchorOffset: Math.round(rect.top - bounds.top),
      turnCount,
      ...(turn.dataset.runId ? { anchorRunId: turn.dataset.runId } : {}),
      ...(Number.isInteger(Number(turn.dataset.turnOrdinal)) ? { anchorOrdinal: Number(turn.dataset.turnOrdinal) } : {})
    }
  }
  return { atBottom: false, anchorOffset: 0, turnCount }
}

export function resetSideChatViewPositions(): void {
  positions.clear()
}
