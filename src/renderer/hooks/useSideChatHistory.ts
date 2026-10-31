import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import type { SideChatSource } from '@shared/conversation'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import { listSideChatPage } from '../side-chat-create'
import {
  EMPTY_HISTORY_WINDOW, historyRowRange, historyWindowLoaded, nextHistoryLoad, previousHistoryLoad,
  type HistoryLoad, type SideChatHistoryWindow
} from '../side-chat-history-window'
import { sideChatSourceKey, type SideChatApi, type SideChatHistory } from './useSideChatWorkspace'

const HISTORY_PAGE = 40
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The bounded history dialog of one source.
 *
 * Resetting, paging and every answered page are owned here, together with the source the
 * request was made for: a page that answers after the visible parent changed is dropped
 * instead of being written into another parent's dialog. The dialog holds one page of
 * rows; the cursor stack is what reaches children beyond it.
 */
export function useSideChatHistory({
  api, source, scopeKey, select, fenceHolds
}: {
  api?: SideChatApi
  source?: SideChatSource
  scopeKey: string
  /** Opening a row is a tab action; the workspace owns what it does to the layout. */
  select: (conversation: ConversationSummary) => void
  fenceHolds: (pinnedScope: string, pinnedSource: string) => boolean
}): SideChatHistory {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [window, setWindow] = useState<SideChatHistoryWindow>(EMPTY_HISTORY_WINDOW)
  /** Monotonic token of the newest read; an older answer is discarded, not merged. */
  const request = useRef(0)
  const sourceKey = sideChatSourceKey(source)
  const selectRef = useRef(select)
  selectRef.current = select

  useEffect(() => {
    // Another parent has another history. Nothing of the previous one stays on screen.
    request.current += 1
    setWindow(EMPTY_HISTORY_WINDOW)
    setOpen(false)
    setLoading(false)
    setError(undefined)
  }, [scopeKey, sourceKey])

  const load = useCallback(async (load: HistoryLoad): Promise<void> => {
    if (!api || !source) return
    const pinned = { scopeKey, sourceKey: sideChatSourceKey(source) }
    const token = ++request.current
    const live = (): boolean => token === request.current && fenceHolds(pinned.scopeKey, pinned.sourceKey)
    setLoading(true)
    setError(undefined)
    try {
      const cursor = 'cursor' in load ? load.cursor : undefined
      const page = await listSideChatPage(api, source,
        { limit: HISTORY_PAGE, ...(cursor === undefined ? {} : { cursor }) })
      if (!live()) return
      setWindow(previous => historyWindowLoaded(previous, load, page))
    } catch (failure) {
      if (!live()) return
      setError(SIDE_CHAT_COPY.historyLoadFailed(message(failure)))
    } finally {
      if (live()) setLoading(false)
    }
  }, [api, fenceHolds, scopeKey, source])

  return useMemo<SideChatHistory>(() => {
    const range = historyRowRange(window)
    return {
      open,
      loading,
      ...(error ? { error } : {}),
      ...(window.total === undefined ? {} : { total: window.total }),
      items: window.page,
      canLoadMore: window.next !== undefined,
      canLoadPrevious: window.back.length > 0,
      ...(range ? { range } : {}),
      show: () => {
        setOpen(true)
        setWindow(EMPTY_HISTORY_WINDOW)
        void load({ direction: 'first' })
      },
      close: () => {
        request.current += 1
        setOpen(false)
      },
      loadMore: () => {
        const next = nextHistoryLoad(window)
        if (next) void load(next)
      },
      loadPrevious: () => {
        const previous = previousHistoryLoad(window)
        if (previous) void load(previous)
      },
      select: (conversation: ConversationSummary) => {
        setOpen(false)
        selectRef.current(conversation)
      }
    }
  }, [error, load, loading, open, window])
}
