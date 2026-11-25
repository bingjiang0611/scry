import type { ConversationSummary, SideChatList } from '@shared/conversation-api'

export interface HistoryBack {
  cursor?: string
  offset: number
}

export interface SideChatHistoryWindow {
  back: readonly HistoryBack[]
  cursor?: string
  offset: number
  page: readonly ConversationSummary[]
  next?: string
  total?: number
}

export const EMPTY_HISTORY_WINDOW: SideChatHistoryWindow = { back: [], offset: 0, page: [] }

export const MAX_HISTORY_BACK = 64

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

export function historyRowRange(window: SideChatHistoryWindow): { first: number; last: number } | undefined {
  if (window.page.length === 0) return undefined
  return { first: window.offset + 1, last: window.offset + window.page.length }
}
