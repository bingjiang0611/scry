import { describe, expect, it } from 'vitest'
import type { ConversationSummary, SideChatList } from '@shared/conversation-api'
import {
  EMPTY_HISTORY_WINDOW, MAX_HISTORY_BACK, historyRowRange, historyWindowLoaded, nextHistoryLoad, previousHistoryLoad,
  type SideChatHistoryWindow
} from './side-chat-history-window'

const row = (index: number): ConversationSummary => ({
  id: `child-${index}`, cwd: '/repo', title: `child ${index}`, turnCount: 0, revision: index + 1
})

/**
 * A host with 205 children and the same cursor contract as `listSideChats`: a cursor
 * names the first row of the page it returns, and the first page has no cursor.
 */
const TOTAL = 205
const PAGE = 40
function host(cursor?: string, total = TOTAL): SideChatList {
  const start = cursor === undefined ? 0 : Number(cursor.slice(1))
  const items = Array.from({ length: Math.max(0, Math.min(PAGE, total - start)) }, (_, index) => row(start + index))
  const next = start + PAGE < total ? `c${start + PAGE}` : undefined
  return { items, total, ...(next ? { nextCursor: next } : {}) } as SideChatList
}

function load(window: SideChatHistoryWindow) {
  const next = nextHistoryLoad(window)
  const previous = previousHistoryLoad(window)
  return { next, previous }
}

describe('bounded side-chat history window', () => {
  it('reaches the oldest of 205 children page by page without keeping older pages', () => {
    let window = historyWindowLoaded(EMPTY_HISTORY_WINDOW, { direction: 'first' }, host())
    const sizes = [window.page.length]
    for (;;) {
      const { next } = load(window)
      if (!next) break
      window = historyWindowLoaded(window, next, host(next.cursor))
      sizes.push(window.page.length)
    }
    // Every child stayed reachable, and the oldest one is in the last page.
    expect(window.page.at(-1)?.id).toBe(`child-${TOTAL - 1}`)
    expect(window.page.length).toBe(TOTAL % PAGE)
    expect(window.back.length).toBe(Math.floor(TOTAL / PAGE))
    // Nothing grew: one page of rows at a time.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PAGE)
    expect(window.page.length).toBeLessThanOrEqual(PAGE)
    expect(historyRowRange(window)).toEqual({ first: 201, last: 205 })
  })

  it('walks back to the newest page and to the exact page it came from', () => {
    let window = historyWindowLoaded(EMPTY_HISTORY_WINDOW, { direction: 'first' }, host())
    window = historyWindowLoaded(window, { direction: 'next', cursor: 'c40' }, host('c40'))
    window = historyWindowLoaded(window, { direction: 'next', cursor: 'c80' }, host('c80'))
    expect(window.page[0]?.id).toBe('child-80')
    const first = previousHistoryLoad(window)!
    window = historyWindowLoaded(window, first, host(first.cursor))
    expect(window.page[0]?.id).toBe('child-40')
    expect(historyRowRange(window)).toEqual({ first: 41, last: 80 })
    const back = previousHistoryLoad(window)!
    expect(back).toEqual({ direction: 'previous' })
    window = historyWindowLoaded(window, back, host(undefined))
    expect(window.page[0]?.id).toBe('child-0')
    expect(previousHistoryLoad(window)).toBeUndefined()
    expect(historyRowRange(window)).toEqual({ first: 1, last: 40 })
  })

  it('stops offering older pages at the end and newer pages at the first', () => {
    const only = { items: [row(0), row(1)], total: 2 } as SideChatList
    const window = historyWindowLoaded(EMPTY_HISTORY_WINDOW, { direction: 'first' }, only)
    expect(nextHistoryLoad(window)).toBeUndefined()
    expect(previousHistoryLoad(window)).toBeUndefined()
  })

  it('bounds the cursor stack instead of growing with the source', () => {
    let window = historyWindowLoaded(EMPTY_HISTORY_WINDOW, { direction: 'first' }, host())
    for (let index = 0; index < MAX_HISTORY_BACK + 10; index++) {
      window = historyWindowLoaded(window, { direction: 'next', cursor: `c${index}` }, host(`c${index}`))
    }
    expect(window.back.length).toBe(MAX_HISTORY_BACK)
    expect(window.back.at(-1)?.cursor).toBe(`c${MAX_HISTORY_BACK + 8}`)
  })
})
