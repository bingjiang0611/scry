import { describe, expect, it } from 'vitest'
import { olderHistoryCursor } from './remote-history-cursor'

// D6: the renderer must not mix the two cursors, and it must not ask for a page it cannot name.

describe('older remote history cursor', () => {
  it('prefers the detail cursor over the trace-archive offset', () => {
    expect(olderHistoryCursor({ hasOlder: true, before: 12, snapshot: 's', detailCursor: 'd6:3' }))
      .toEqual({ detailCursor: 'd6:3' })
  })

  it('falls back to the offset pair', () => {
    expect(olderHistoryCursor({ hasOlder: true, before: 12, snapshot: 's' })).toEqual({ before: 12, snapshot: 's' })
    expect(olderHistoryCursor({ hasOlder: true, before: 12 })).toEqual({ before: 12 })
  })

  it('returns nothing when there is no older page or no cursor', () => {
    expect(olderHistoryCursor({ hasOlder: false, detailCursor: 'd6:3' })).toBeUndefined()
    expect(olderHistoryCursor({ hasOlder: true })).toBeUndefined()
    expect(olderHistoryCursor(null)).toBeUndefined()
  })
})
