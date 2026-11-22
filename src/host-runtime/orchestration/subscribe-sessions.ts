import type { SessionCatalogMetadata, SubscribeSessionRow, SubscribeSnapshot } from '../../shared/orchestration-subscribe'
import type { EventSink } from './event-sink'
import { mapSessionRow } from './projection-mappers'

export function visibleCatalog(
  catalog: SessionCatalogMetadata,
  canReadCwd: (cwd: string | null) => boolean
): SessionCatalogMetadata {
  const { projectCwd } = catalog
  return projectCwd && !canReadCwd(projectCwd) ? { ...catalog, projectCwd: null } : catalog
}

interface SessionsKeysetCursor {
  archivedAt: number | null
  ts: number
  sessionKey: string
}

function encodeSessionsCursor(cursor: SessionsKeysetCursor): string {
  return Buffer.from(JSON.stringify([cursor.archivedAt, cursor.ts, cursor.sessionKey]), 'utf8').toString('base64url')
}

function decodeSessionsCursor(raw: string): SessionsKeysetCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined
    const [archivedAt, ts, sessionKey] = parsed
    if ((archivedAt !== null && !Number.isSafeInteger(archivedAt)) || !Number.isSafeInteger(ts) || typeof sessionKey !== 'string') {
      return undefined
    }
    return { archivedAt: archivedAt as number | null, ts: ts as number, sessionKey }
  } catch {
    return undefined
  }
}

export function readSessionsSnapshot(
  db: EventSink['handle']['db'],
  canReadCwd: (cwd: string | null) => boolean,
  scope: 'local' | 'remote',
  pageSize: number,
  cursorToken?: string
): NonNullable<SubscribeSnapshot['sessions']> {
  const cursor = cursorToken ? decodeSessionsCursor(cursorToken) : undefined
  const allRows = (
    cursor
      ? cursor.archivedAt === null
        ? db
            .prepare(
              `SELECT * FROM orch_p_session
               WHERE (archived_at IS NULL AND (ts < ? OR (ts = ? AND session_key > ?)))
                  OR archived_at IS NOT NULL
               ORDER BY archived_at ASC, ts DESC, session_key ASC`
            )
            .iterate(cursor.ts, cursor.ts, cursor.sessionKey)
        : db
            .prepare(
              `SELECT * FROM orch_p_session
               WHERE archived_at > ?
                  OR (archived_at = ? AND (ts < ? OR (ts = ? AND session_key > ?)))
               ORDER BY archived_at ASC, ts DESC, session_key ASC`
            )
            .iterate(cursor.archivedAt, cursor.archivedAt, cursor.ts, cursor.ts, cursor.sessionKey)
      : scope === 'local'
        ? db
            .prepare('SELECT * FROM orch_p_session ORDER BY archived_at ASC, ts DESC, session_key ASC LIMIT ?')
            .iterate(pageSize + 1)
        : db
            .prepare('SELECT * FROM orch_p_session ORDER BY archived_at ASC, ts DESC, session_key ASC')
            .iterate()
  ) as Iterable<Record<string, unknown>>

  const visible: SubscribeSessionRow[] = []
  let hasMore = false
  for (const raw of allRows) {
    if (!canReadCwd(raw.cwd as string | null)) continue
    if (visible.length >= pageSize) {
      hasMore = true
      break
    }
    const mapped = mapSessionRow(raw)
    visible.push({
      sessionKey: mapped.sessionKey,
      conversationId: mapped.conversationId,
      provider: mapped.provider,
      profile: mapped.profile,
      cwd: mapped.cwd,
      title: mapped.title,
      ts: mapped.ts,
      pinnedAt: mapped.pinnedAt,
      archivedAt: mapped.archivedAt,
      lastRunId: mapped.lastRunId,
      lastRunOutcome: mapped.lastRunOutcome,
      activeRunId: mapped.activeRunId,
      pendingQuestions: mapped.pendingQuestions,
      legacy: mapped.legacy,
      revSeq: mapped.revSeq,
      ...(mapped.catalog ? { catalog: visibleCatalog(mapped.catalog, canReadCwd) } : {})
    })
  }

  let total: number | 'unavailable' = 'unavailable'
  if (scope === 'local') {
    total = Number((db.prepare('SELECT COUNT(*) AS c FROM orch_p_session').get() as { c: number }).c)
  } else {
    const cwds = db.prepare('SELECT cwd FROM orch_p_session').iterate() as Iterable<{ cwd: string | null }>
    total = 0
    for (const row of cwds) if (canReadCwd(row.cwd)) total++
  }

  const last = visible[visible.length - 1]
  const nextCursor =
    hasMore && last
      ? encodeSessionsCursor({ archivedAt: last.archivedAt, ts: last.ts, sessionKey: last.sessionKey })
      : undefined
  return { rows: visible, total, ...(nextCursor ? { nextCursor } : {}) }
}
