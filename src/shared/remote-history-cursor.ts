/**
 * D6: older turns can be read two ways — the host's detail cursor (exclusive turn ordinal) or the
 * older trace-archive offset. The detail cursor wins when present because appended turns never
 * repeat or skip with it, and the two cursors are not interchangeable.
 */
export interface OlderHistoryCursor {
  before?: number
  snapshot?: string
  detailCursor?: string
}

export function olderHistoryCursor(evidence: {
  hasOlder: boolean
  before?: number
  snapshot?: string
  detailCursor?: string
} | null | undefined): OlderHistoryCursor | undefined {
  if (!evidence?.hasOlder) return undefined
  if (evidence.detailCursor) return { detailCursor: evidence.detailCursor }
  if (evidence.before === undefined) return undefined
  return { before: evidence.before, ...(evidence.snapshot === undefined ? {} : { snapshot: evidence.snapshot }) }
}
