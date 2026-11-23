import type { EventSink } from './event-sink'
import { mapRunRow } from './projection-mappers'
import type { RunProjectionRow } from './types'

const SUBSCRIBE_ACTIVE_RUN_RETENTION_MS = 24 * 60 * 60 * 1000
const SUBSCRIBE_TERMINAL_RUN_SNAPSHOT_LIMIT = 256

export function readSubscribedRuns(sink: EventSink, now: number, tracked?: string[]): RunProjectionRow[] {
  if (tracked) return tracked.flatMap(id => {
    const row = sink.getRun(id)
    return row ? [row] : []
  })
  const db = sink.handle.db
  const cutoff = now - SUBSCRIBE_ACTIVE_RUN_RETENTION_MS
  const live = db
    .prepare(
      `SELECT * FROM orch_p_run
       WHERE lifecycle IN ('recorded', 'admitted', 'dispatched')
       ORDER BY intent_seq DESC`
    )
    .all() as Array<Record<string, unknown>>
  const recentTerminal = db
    .prepare(
      `SELECT * FROM orch_p_run
       WHERE lifecycle NOT IN ('recorded', 'admitted', 'dispatched')
         AND COALESCE(settled_at, recovered_at, 0) >= ?
       ORDER BY intent_seq DESC
       LIMIT ?`
    )
    .all(cutoff, SUBSCRIBE_TERMINAL_RUN_SNAPSHOT_LIMIT) as Array<Record<string, unknown>>
  return [...live, ...recentTerminal].map(mapRunRow)
}
