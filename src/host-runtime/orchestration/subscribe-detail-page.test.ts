import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from './event-sink'
import { DETAIL_PAGE_BYTES, DETAIL_PAGE_TURNS, decodeDetailCursor, readDetailPage } from './subscribe-detail-page'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function dbWithTurns(count: number, size = 16): { db: EventSink['handle']['db']; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'scry-d6-'))
  dirs.push(dir)
  const sink = EventSink.open({ userDataDir: dir })
  for (let index = 1; index <= count; index += 1) {
    sink.handle.db.prepare(
      `INSERT INTO orch_p_turn (session_key, ordinal, run_id, ordinal_origin, user_text_preview, delivery, rev_seq)
       VALUES (?, ?, ?, 'native', ?, 'sent', ?)`
    ).run('s1', index, `run-${index}`, 'x'.repeat(size), index)
  }
  return { db: sink.handle.db, close: () => sink.close() }
}

// D6: the detail snapshot grew with the conversation. A page must be bounded by turns and bytes,
// and continuing it must never repeat or skip a turn.

describe('D6: detail snapshot paging', () => {
  it('returns the newest page and a cursor for the older turns', () => {
    const { db, close } = dbWithTurns(DETAIL_PAGE_TURNS + 5)
    try {
      const page = readDetailPage(db, 's1')
      expect(page.rows).toHaveLength(DETAIL_PAGE_TURNS)
      expect(page.rows.at(-1)?.ordinal).toBe(DETAIL_PAGE_TURNS + 5)
      expect(page.rows[0]?.ordinal).toBe(6)
      expect(page.nextCursor).toBeDefined()
      expect(decodeDetailCursor(page.nextCursor)).toBe(6)
    } finally { close() }
  })

  it('continues without repeating or skipping and ends without a cursor', () => {
    const { db, close } = dbWithTurns(DETAIL_PAGE_TURNS + 5)
    try {
      const seen: number[] = []
      let cursor: string | undefined
      for (let guard = 0; guard < 10; guard += 1) {
        const page = readDetailPage(db, 's1', cursor)
        seen.unshift(...page.rows.map(row => Number(row.ordinal)))
        cursor = page.nextCursor
        if (!cursor) break
      }
      expect(seen).toEqual(Array.from({ length: DETAIL_PAGE_TURNS + 5 }, (_, index) => index + 1))
    } finally { close() }
  })

  it('cuts a page short on the byte budget and still continues from the oldest kept turn', () => {
    const { db, close } = dbWithTurns(DETAIL_PAGE_TURNS, DETAIL_PAGE_BYTES)
    try {
      const page = readDetailPage(db, 's1')
      expect(page.rows).toHaveLength(1)
      expect(page.truncated).toBe(true)
      expect(decodeDetailCursor(page.nextCursor)).toBe(DETAIL_PAGE_TURNS)
    } finally { close() }
  })

  it('serves the first page for a cursor it cannot parse', () => {
    const { db, close } = dbWithTurns(3)
    try {
      expect(readDetailPage(db, 's1', 'nonsense').rows).toHaveLength(3)
      expect(readDetailPage(db, 's1', 'd6:-4').rows).toHaveLength(3)
    } finally { close() }
  })
})
