import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConversationPage } from '@shared/conversation-api'
import { applyViewRestore, type PendingViewRestore } from './conversation-view-restore'
import { MAX_RESTORE_PAGES } from './side-chat-view-state'

/** A page of `count` turns ending at `before`, mirroring the slice-end convention. */
function pageOf(count: number, before: number | undefined, nextBeforeOrdinal?: number): ConversationPage {
  const start = (before ?? count) - count
  return {
    turns: Array.from({ length: count }, (_, index) => ({ ordinal: start + index + 1 })),
    nextBeforeOrdinal,
  } as unknown as ConversationPage
}

interface FakeAnchor {
  dataset: Record<string, string>
  getBoundingClientRect: () => { top: number }
}

/** A scroll container whose querySelector only answers for the turns it holds. */
function elementWith(anchorRunId: string | null) {
  const scrollTop = { value: 0 }
  const anchor: FakeAnchor | undefined = anchorRunId
    ? { dataset: {}, getBoundingClientRect: () => ({ top: 340 }) }
    : undefined
  const element = {
    scrollTop: 0,
    scrollHeight: 2000,
    anchor,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector: (selector: string) => anchorRunId && selector.includes(anchorRunId)
      ? anchor
      : null,
  }
  return Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop.value,
    set: (next: number) => { scrollTop.value = next },
  }) as unknown as HTMLElement & { anchor?: FakeAnchor }
}

function pending(position: PendingViewRestore['position']): PendingViewRestore {
  return { conversationId: 'child', position, attempts: 0 }
}

const noop = () => undefined

beforeAll(() => {
  // The module escapes the anchor id; Node has no CSS object.
  Object.assign(globalThis, { CSS: { escape: (value: string) => value } })
})

describe('applyViewRestore', () => {
  it('ignores a commit of another conversation', () => {
    const requestBefore = vi.fn()
    const handled = applyViewRestore({ restore: pending({ atBottom: true, anchorOffset: 0, turnCount: 2 }), conversationId: 'parent',
      before: undefined, page: pageOf(2, undefined), element: elementWith(null), requestBefore,
      follow: noop, clear: noop })
    expect(handled).toBe(false)
    expect(requestBefore).not.toHaveBeenCalled()
  })

  it('keeps a reader who was at the bottom pinned there', () => {
    const clear = vi.fn()
    const follow = vi.fn()
    const element = elementWith(null)
    expect(applyViewRestore({ restore: pending({ atBottom: true, anchorOffset: 0, turnCount: 2 }), conversationId: 'child',
      before: undefined, page: pageOf(2, undefined), element, requestBefore: noop, follow, clear })).toBe(true)
    expect(follow).toHaveBeenCalledWith(true)
    expect(element.scrollTop).toBe(2000)
    expect(clear).toHaveBeenCalled()
  })

  it('positions a present anchor turn instead of an offset', () => {
    const element = elementWith('run-7')
    expect(applyViewRestore({ restore: pending({ atBottom: false, anchorRunId: 'run-7', anchorOffset: 40, turnCount: 2 }),
      conversationId: 'child', before: undefined, page: pageOf(2, undefined), element,
      requestBefore: noop, follow: noop, clear: noop })).toBe(true)
    // 340 - 100 - 40 moves the anchor to the remembered distance below the top edge.
    expect(element.scrollTop).toBe(200)
    // The transcript must not compensate this turn's own growth (transcript.tsx).
    expect(element.anchor?.dataset.restoreAnchor).toBe('true')
  })

  it('reads exactly one older page for a remembered ordinal', () => {
    const requestBefore = vi.fn()
    const restore = pending({ atBottom: false, anchorOrdinal: 5, anchorOffset: 0, turnCount: 4 })
    expect(applyViewRestore({ restore, conversationId: 'child', before: undefined, page: pageOf(4, undefined),
      element: elementWith(null), requestBefore, follow: noop, clear: noop })).toBe(true)
    // ordinal 5 at index 4 asks for the window that ends at slice end 8, which is the
    // anchor's own index plus this page's length, so a second read is never needed.
    expect(requestBefore).toHaveBeenCalledWith(8)
    expect(restore.requestedBefore).toBe(8)
  })

  it('does not apply the anchor to the window a read is still replacing', () => {
    const requestBefore = vi.fn()
    const restore = pending({ atBottom: false, anchorOrdinal: 5, anchorOffset: 0, turnCount: 4 })
    restore.attempts = 1
    restore.requestedBefore = 9
    const element = elementWith('run-9')
    expect(applyViewRestore({ restore, conversationId: 'child', before: 4, page: pageOf(4, 4, 4), element,
      requestBefore, follow: noop, clear: noop })).toBe(true)
    expect(requestBefore).not.toHaveBeenCalled()
    expect(element.scrollTop).toBe(0)
  })

  it('walks bounded older pages and gives up at the oldest turn', () => {
    const requestBefore = vi.fn()
    const clear = vi.fn()
    const restore = pending({ atBottom: false, anchorRunId: 'gone', anchorOffset: 12, turnCount: 4 })
    restore.attempts = 0
    for (let step = 0; step < MAX_RESTORE_PAGES; step += 1) {
      restore.requestedBefore = 20
      applyViewRestore({ restore, conversationId: 'child', before: 20, page: pageOf(4, 20, 20),
        element: elementWith(null), requestBefore, follow: noop, clear })
    }
    expect(requestBefore).toHaveBeenCalledTimes(MAX_RESTORE_PAGES)
    expect(restore.attempts).toBe(MAX_RESTORE_PAGES)
    const oldest = pageOf(4, 4, undefined)
    const element = elementWith(null)
    restore.requestedBefore = 4
    applyViewRestore({ restore, conversationId: 'child', before: 4, page: oldest, element,
      requestBefore, follow: noop, clear })
    expect(clear).toHaveBeenCalled()
    expect(element.scrollTop).toBe(0)
  })

  it('drops the restore when the reader paged somewhere by hand', () => {
    const clear = vi.fn()
    const restore = pending({ atBottom: false, anchorRunId: 'run-3', anchorOffset: 0, turnCount: 4 })
    restore.requestedBefore = 9
    expect(applyViewRestore({ restore, conversationId: 'child', before: 2, page: pageOf(2, 2, 2),
      element: elementWith('run-3'), requestBefore: vi.fn(), follow: noop, clear })).toBe(true)
    expect(clear).toHaveBeenCalled()
  })
})
