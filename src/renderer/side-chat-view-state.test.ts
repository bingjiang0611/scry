import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_RESTORE_PAGES, isSideChatAtBottom, readSideChatViewPosition, rememberSideChatViewPosition,
  resetSideChatViewPositions, sideChatViewPosition
} from './side-chat-view-state'

afterEach(() => resetSideChatViewPositions())

/**
 * The anchor reader only needs bounding boxes and the run ids the transcript already
 * renders; this fake is that surface, not a browser.
 */
function scroller(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  turns: Array<{ runId: string; top: number; height: number; ordinal?: number }>
}): HTMLElement {
  return {
    scrollTop: input.scrollTop,
    scrollHeight: input.scrollHeight,
    clientHeight: input.clientHeight,
    getBoundingClientRect: () => ({ top: 0, bottom: input.clientHeight, left: 0, right: 800, height: input.clientHeight, width: 800 }),
    querySelectorAll: () => input.turns.map(turn => ({
      dataset: { runId: turn.runId, ...(turn.ordinal === undefined ? {} : { turnOrdinal: String(turn.ordinal) }) },
      getBoundingClientRect: () => ({ top: turn.top, bottom: turn.top + turn.height, left: 0, right: 800, height: turn.height, width: 800 })
    }))
  } as unknown as HTMLElement
}

describe('side-chat scroll anchor', () => {
  it('carries the anchor ordinal so a deep transcript restores in one bounded read', () => {
    // A 130-turn child cannot be reached by a fixed three-page budget; the ordinal of the
    // remembered turn is what lets the restore ask for that exact window instead.
    const position = sideChatViewPosition(scroller({
      scrollTop: 900, scrollHeight: 9000, clientHeight: 600,
      turns: [
        { runId: 'turn-4', top: -60, height: 200, ordinal: 4 },
        { runId: 'turn-5', top: 190, height: 300, ordinal: 5 }
      ]
    }))
    // The first turn still visible at the top edge is the anchor, with its own ordinal.
    expect(position).toMatchObject({ atBottom: false, anchorRunId: 'turn-4', anchorOrdinal: 4 })
  })

  it('omits the ordinal when the rendered turn does not expose one', () => {
    const position = sideChatViewPosition(scroller({
      scrollTop: 0, scrollHeight: 900, clientHeight: 600,
      turns: [{ runId: 'live-placeholder', top: 10, height: 100 }]
    }))
    expect(position.anchorRunId).toBe('live-placeholder')
    expect(position.anchorOrdinal).toBeUndefined()
  })

  it('remembers the turn at the top edge, not an absolute offset', () => {
    const position = sideChatViewPosition(scroller({
      scrollTop: 420, scrollHeight: 2000, clientHeight: 600,
      turns: [
        { runId: 'turn-a', top: -500, height: 300 },
        { runId: 'turn-b', top: -40, height: 200 },
        { runId: 'turn-c', top: 180, height: 400 }
      ]
    }))
    // The turn covering the top edge is the anchor: a turn fully above it is not on screen.
    expect(position).toEqual({ atBottom: false, anchorRunId: 'turn-b', anchorOffset: -40, turnCount: 3 })
  })

  it('keeps a bottom-pinned child pinned instead of recording a stale row', () => {
    const position = sideChatViewPosition(scroller({
      scrollTop: 1400, scrollHeight: 2000, clientHeight: 600, turns: [{ runId: 'turn-a', top: -1300, height: 300 }]
    }))
    expect(position.atBottom).toBe(true)
    expect(position.anchorRunId).toBeUndefined()
  })

  it('does not treat the bottom of an older page as the bottom of the conversation', () => {
    // The reader sits at the end of an older bounded window. Restoring "at the bottom"
    // would jump to the newest turn of the child, which is not where they were.
    const position = sideChatViewPosition(scroller({
      scrollTop: 1400, scrollHeight: 2000, clientHeight: 600,
      turns: [
        { runId: 'turn-1', top: -1300, height: 300, ordinal: 1 },
        { runId: 'turn-2', top: -1000, height: 300, ordinal: 2 },
        { runId: 'turn-3', top: -120, height: 300, ordinal: 3 }
      ]
    }), false)
    expect(position).toEqual({ atBottom: false, anchorRunId: 'turn-3', anchorOffset: -120, turnCount: 3, anchorOrdinal: 3 })
  })

  it('reports no anchor for a child with no rendered turn yet', () => {
    const position = sideChatViewPosition(scroller({ scrollTop: 0, scrollHeight: 600, clientHeight: 600, turns: [] }))
    expect(position).toEqual({ atBottom: true, anchorOffset: 0, turnCount: 0 })
  })

  it('bounds how many older pages a restore may read', () => {
    expect(MAX_RESTORE_PAGES).toBe(3)
    expect(isSideChatAtBottom({ scrollTop: 592, scrollHeight: 1200, clientHeight: 600 } as HTMLElement)).toBe(true)
    expect(isSideChatAtBottom({ scrollTop: 500, scrollHeight: 1200, clientHeight: 600 } as HTMLElement)).toBe(false)
  })

  it('keeps only the last sixteen children', () => {
    for (let index = 0; index < 20; index++) {
      rememberSideChatViewPosition(`child-${index}`, { atBottom: true, anchorOffset: 0, turnCount: 1 })
    }
    expect(readSideChatViewPosition('child-19')).toBeDefined()
    // The oldest entries leave the window instead of growing the map forever.
    expect(readSideChatViewPosition('child-0')).toBeUndefined()
    expect(readSideChatViewPosition('child-4')).toBeDefined()
    expect(readSideChatViewPosition('child-3')).toBeUndefined()
  })
})
