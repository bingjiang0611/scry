/**
 * One page of a bounded list that is replaced, not appended to.
 *
 * The orphan list has two levels (sources, then children of one source) and both need
 * the same three facts: which page is really shown, which slice it covers, and how many
 * pages exist. Keeping the arithmetic here means the component cannot mount more than a
 * page by accident, and the bound is provable without a DOM.
 */
export interface BoundedPage {
  /** Page index that is really shown after clamping to the current list length. */
  page: number
  /** 0-based start of this page's slice. */
  first: number
  /** 0-based end (exclusive) of this page's slice. */
  last: number
  /** Index of the last page; 0 for an empty or single-page list. */
  lastPage: number
}

export function boundedPage(page: number, total: number, size: number): BoundedPage {
  const lastPage = size > 0 && total > 0 ? Math.ceil(total / size) - 1 : 0
  const shown = Math.min(Math.max(0, Math.trunc(page)), lastPage)
  const first = Math.min(shown * size, Math.max(0, total))
  return { page: shown, first, last: Math.min(first + size, Math.max(0, total)), lastPage }
}

/**
 * Row page entries that still name a group on the currently shown group page.
 *
 * Group navigation clears the map, but a changed catalog can replace the shown groups
 * while the same group page stays selected; entries for the replaced groups would then be
 * kept forever. Pruning to the current keys on every row page update keeps the map at one
 * group page of entries whatever the catalog does.
 */
export function pruneRowPages(rows: Readonly<Record<string, number>>,
  groupKeys: readonly string[]): Record<string, number> {
  const pruned: Record<string, number> = {}
  for (const key of groupKeys) {
    const page = rows[key]
    if (page !== undefined) pruned[key] = page
  }
  return pruned
}
