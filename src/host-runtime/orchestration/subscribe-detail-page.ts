import type { Database } from 'better-sqlite3'

/**
 * D6: the detail snapshot used to read every turn of a session. A long session therefore produced
 * one enormous reply that grew with the conversation, and the renderer had to parse all of it
 * before showing anything. One page now carries at most `DETAIL_PAGE_TURNS` turns and
 * `DETAIL_PAGE_BYTES` of serialized rows; `nextCursor` continues towards older turns.
 *
 * The cursor is an exclusive `ordinal` bound, not an offset: turns are appended, so an offset would
 * shift under a live session and repeat or skip turns.
 */
export const DETAIL_PAGE_TURNS = 10
export const DETAIL_PAGE_BYTES = 256 * 1024

export interface DetailPage {
  rows: Array<Record<string, unknown>>
  nextCursor?: string
  truncated?: true
}

const CURSOR_PREFIX = 'd6:'

export function encodeDetailCursor(beforeOrdinal: number): string {
  return `${CURSOR_PREFIX}${beforeOrdinal}`
}

/** A cursor that does not parse is a client bug: serve the first page instead of guessing. */
export function decodeDetailCursor(cursor: string | undefined): number | undefined {
  if (!cursor || !cursor.startsWith(CURSOR_PREFIX)) return undefined
  const value = Number(cursor.slice(CURSOR_PREFIX.length))
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function readDetailPage(
  db: Database,
  sessionKey: string,
  cursor?: string
): DetailPage {
  const before = decodeDetailCursor(cursor)
  const rows = (before === undefined
    ? db.prepare('SELECT * FROM orch_p_turn WHERE session_key = ? ORDER BY ordinal DESC LIMIT ?')
      .all(sessionKey, DETAIL_PAGE_TURNS + 1)
    : db.prepare('SELECT * FROM orch_p_turn WHERE session_key = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?')
      .all(sessionKey, before, DETAIL_PAGE_TURNS + 1)) as Array<Record<string, unknown>>

  const kept: Array<Record<string, unknown>> = []
  let bytes = 0
  let cutByBytes = false
  for (const row of rows.slice(0, DETAIL_PAGE_TURNS)) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8')
    if (kept.length > 0 && bytes + size > DETAIL_PAGE_BYTES) {
      cutByBytes = true
      break
    }
    kept.push(row)
    bytes += size
  }
  const hasMore = cutByBytes || rows.length > kept.length
  // Newest page first, ascending for the client, which renders in reading order.
  kept.reverse()
  const oldest = kept[0]?.ordinal
  return {
    rows: kept,
    ...(hasMore && typeof oldest === 'number' ? { nextCursor: encodeDetailCursor(oldest) } : {}),
    ...(cutByBytes ? { truncated: true as const } : {})
  }
}
