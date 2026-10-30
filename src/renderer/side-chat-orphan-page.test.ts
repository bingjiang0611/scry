import { describe, expect, it } from 'vitest'
import { boundedPage, pruneRowPages } from './side-chat-orphan-page'

/** The two bounds the sidebar really uses: one page of groups, one page of rows. */
const GROUP_PAGE = 6
const ROW_PAGE = 20

describe('bounded orphan list pages', () => {
  it('replaces a row page instead of growing it', () => {
    const first = boundedPage(0, 21, ROW_PAGE)
    const second = boundedPage(1, 21, ROW_PAGE)
    expect([first.first, first.last]).toEqual([0, 20])
    expect([second.first, second.last]).toEqual([20, 21])
    // Two pages, never one list of 21 mounted rows.
    expect(second.last - second.first).toBeLessThanOrEqual(ROW_PAGE)
    expect(second.lastPage).toBe(1)
  })

  it('reaches the thirteenth group with one page mounted', () => {
    const total = 13
    const pages = [0, 1, 2].map(page => boundedPage(page, total, GROUP_PAGE))
    expect(pages.map(page => [page.first, page.last])).toEqual([[0, 6], [6, 12], [12, 13]])
    // The bound is per page, not per list: no page ever exceeds it, whatever the total.
    for (const page of pages) expect(page.last - page.first).toBeLessThanOrEqual(12)
    expect(pages.every(page => page.lastPage === 2)).toBe(true)
  })

  it('walks back to the previous page from the last one', () => {
    const fromLast = boundedPage(boundedPage(2, 13, GROUP_PAGE).lastPage, 13, GROUP_PAGE)
    const back = boundedPage(fromLast.page - 1, 13, GROUP_PAGE)
    expect([back.page, back.first, back.last]).toEqual([1, 6, 12])
  })

  it('clamps a page that the current list no longer has', () => {
    // The catalog shrank under the open page: show the last real page, not an empty one.
    expect(boundedPage(4, 7, GROUP_PAGE)).toMatchObject({ page: 1, first: 6, last: 7, lastPage: 1 })
    expect(boundedPage(-3, 7, GROUP_PAGE)).toMatchObject({ page: 0, first: 0, last: 6 })
  })

  it('has no rows for an empty list and one page for a single page', () => {
    expect(boundedPage(0, 0, ROW_PAGE)).toMatchObject({ page: 0, first: 0, last: 0, lastPage: 0 })
    expect(boundedPage(3, 20, ROW_PAGE)).toMatchObject({ page: 0, first: 0, last: 20, lastPage: 0 })
  })
})

/** The six group keys one catalog read shows on one group page. */
const shownKeys = (refresh: number): string[] =>
  Array.from({ length: GROUP_PAGE }, (_, slot) => `conversation:catalog-${refresh}-${slot}`)

describe('bounded orphan row page entries', () => {
  it('keeps the row page of a group that is still on screen', () => {
    const shown = shownKeys(0)
    const kept = pruneRowPages({ [shown[2]]: 1, 'conversation:replaced': 2 }, shown)
    expect(kept).toEqual({ [shown[2]]: 1 })
    const paged = { ...kept, [shown[0]]: 3 }
    // Prev/next of one shown group survives the update of another shown group.
    expect(paged).toEqual({ [shown[2]]: 1, [shown[0]]: 3 })
  })

  it('holds one group page of entries when a changed catalog replaces the shown groups', () => {
    let rows: Record<string, number> = {}
    for (let refresh = 0; refresh < 10; refresh += 1) {
      const shown = shownKeys(refresh)
      // The group page stays the same; the catalog under it is replaced every refresh.
      rows = pruneRowPages(rows, shown)
      rows[shown[0]] = 1
      expect(Object.keys(rows).length).toBeLessThanOrEqual(GROUP_PAGE)
    }
    // Only the groups currently on screen still hold an entry.
    expect(Object.keys(rows)).toEqual([shownKeys(9)[0]])

    // Negative control: the replaced spread form keeps one entry per evicted group, so
    // ten catalog refreshes leave ten entries for six mounted groups.
    let spread: Record<string, number> = {}
    for (let refresh = 0; refresh < 10; refresh += 1) spread = { ...spread, [shownKeys(refresh)[0]]: 1 }
    expect(Object.keys(spread).length).toBeGreaterThan(GROUP_PAGE)
  })
})
