import type { RemoteSessionRef } from '../../shared/desktop-remote'
import { fail, record, text, MAX_ITEMS, MAX_PAGES, validateSession } from './desktop-client-validation'

export async function readRemoteSessionPages(
  request: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
): Promise<RemoteSessionRef[]> {
  const sessions: RemoteSessionRef[] = []
  let cursor = 0
  let snapshot: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const envelope = await request({ op: 'sessionsPage', includeArchived: true, cursor, limit: 100, ...(snapshot ? { snapshot } : {}) })
    const response = envelope.sessionsPage
    if (!record(response) || !Array.isArray(response.sessions) || !Number.isSafeInteger(response.cursor) ||
      !Number.isSafeInteger(response.total) || typeof response.hasMore !== 'boolean' || !text(response.snapshot, 256))
      fail('invalid_catalog_response')
    if (snapshot !== undefined && response.snapshot !== snapshot) fail('catalog_snapshot_changed')
    if (response.sessions.length > 100 || sessions.length + response.sessions.length > MAX_ITEMS) fail('catalog_too_large')
    sessions.push(...response.sessions.map((item) => validateSession(item)))
    if (!response.hasMore) return sessions
    if ((response.cursor as number) <= cursor) fail('invalid_catalog_cursor')
    cursor = response.cursor as number
    snapshot = response.snapshot as string
  }
  fail('catalog_too_large')
}
