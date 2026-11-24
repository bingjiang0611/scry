import type Database from 'better-sqlite3'
import type { OrchestrationEventRow } from './types'

/** D1: queue events only touch the queue columns; keeping them here keeps `projection.ts` in budget. */
export function applyQueueEvent(db: Database.Database, event: OrchestrationEventRow): boolean {
  if (event.type === 'run.queued') {
    const position = typeof event.payload?.queuePosition === 'number' ? event.payload.queuePosition : null
    db.prepare('UPDATE orch_p_run SET lifecycle = ?, queue_position = ?, rev_seq = ? WHERE run_id = ?').run(
      'queued',
      position,
      event.seq,
      event.runId
    )
    return true
  }
  if (event.type === 'run.queue_held') {
    db.prepare('UPDATE orch_p_run SET queue_held = 1, rev_seq = ? WHERE run_id = ?').run(event.seq, event.runId)
    return true
  }
  if (event.type === 'run.queue_released') {
    db.prepare(
      'UPDATE orch_p_run SET queue_held = 0, queue_position = NULL, rev_seq = ? WHERE run_id = ?'
    ).run(event.seq, event.runId)
    return true
  }
  return false
}
