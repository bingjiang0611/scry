import type { ConversationSummary, SideChatList } from '@shared/conversation-api'

/** A page walked past: the cursor that fetched it (absent for the first page) and its row offset. */
export interface HistoryBack {
  cursor?: string
  offset: number
}

/**
 * One bounded page of the child history of a source, plus how to walk back and forth.
 *
 * History is replaced page by page instead of appended, so the dialog holds at most one
 * page of rows. The stack of pages walked past is what makes every older child reachable
 * and every newer one recoverable — including children beyond the first few pages —
 * without an ever-growing array. The host's own cursor identifies each page.
 */
export interface SideChatHistoryWindow {
  /** Pages walked past towards older rows; the last entry is the previous page. */
  back: readonly HistoryBack[]
  /** Cursor that fetched this page; absent for the first (newest) page. */
  cursor?: string
  /** Index of this page's first row inside the whole history. */
  offset: number
  page: readonly ConversationSummary[]
  /** Cursor of the next (older) page; absent means this is the oldest page. */
  next?: string
  total?: number
}

export const EMPTY_HISTORY_WINDOW: SideChatHistoryWindow = { back: [], offset: 0, page: [] }

/** Pages are short, but the stack is still bounded instead of growing with the source. */
export const MAX_HISTORY_BACK = 64

/** The page a load is about to ask for; identity is the cursor, not a row offset. */
export type HistoryLoad =
  | { direction: 'first' }
  | { direction: 'next'; cursor: string }
  | { direction: 'previous'; cursor?: string }

export function nextHistoryLoad(window: SideChatHistoryWindow): Extract<HistoryLoad, { direction: 'next' }> | undefined {
  return window.next === undefined ? undefined : { direction: 'next', cursor: window.next }
}

export function previousHistoryLoad(window: SideChatHistoryWindow): Extract<HistoryLoad, { direction: 'previous' }> | undefined {
  if (window.back.length === 0) return undefined
  const cursor = window.back.at(-1)?.cursor
  return cursor === undefined ? { direction: 'previous' } : { direction: 'previous', cursor }
}

/**
 * Apply one answered page. Only the direction that asked for it decides how the stack and
 * the row offset change, so a late answer cannot invent a neighbour that was never read.
 */
export function historyWindowLoaded(
  window: SideChatHistoryWindow,
  load: HistoryLoad,
  list: Pick<SideChatList, 'items' | 'nextCursor' | 'total'>
): SideChatHistoryWindow {
  const rest = {
    page: list.items,
    ...(list.nextCursor === undefined ? {} : { next: list.nextCursor }),
    ...(list.total === undefined ? {} : { total: list.total })
  }
  if (load.direction === 'first') return { back: [], offset: 0, ...rest }
  if (load.direction === 'next') {
    const back = [...window.back, { ...(window.cursor ? { cursor: window.cursor } : {}), offset: window.offset }]
      .slice(-MAX_HISTORY_BACK)
    return { back, cursor: load.cursor, offset: window.offset + window.page.length, ...rest }
  }
  const previous = window.back.at(-1)
  return {
    back: window.back.slice(0, -1),
    ...(previous?.cursor ? { cursor: previous.cursor } : {}),
    offset: previous?.offset ?? 0,
    ...rest
  }
}

/** Where this page starts inside the whole history, for honest page labelling. */
export function historyRowRange(window: SideChatHistoryWindow): { first: number; last: number } | undefined {
  if (window.page.length === 0) return undefined
  return { first: window.offset + 1, last: window.offset + window.page.length }
}
