import { hostQueueEntries, type HostQueueRow } from '../../shared/host-queue'
import type { DaemonLocalOpGroup } from './deps'

/**
 * D1: the queue lives on the host, so the App reads it here instead of reconstructing it from
 * whatever it happens to have sent. The op is read-only: it answers with the rows the host is
 * holding for one session, in the order it will dispatch them.
 *
 * A session the projection does not know answers with an empty queue rather than an error: "nothing
 * queued" is the truth for a session that has not been used yet.
 */
export const hostQueueLocalOps: DaemonLocalOpGroup = (deps) => ({
  'agent:hostQueue': async (input: unknown) => {
    const value = (input ?? {}) as { sessionKey?: unknown }
    if (typeof value.sessionKey !== 'string' || value.sessionKey.length === 0) throw new Error('invalid_session_key')
    const db = deps.orchestrationDb?.()
    if (!db) throw new Error('orchestration_unavailable')
    const rows = db.prepare(
      `SELECT run_id AS runId, session_key AS sessionKey, lifecycle, queue_position AS queuePosition,
              queue_held AS queueHeld, origin, prompt_preview AS promptPreview
         FROM orch_p_run
        WHERE session_key = ? AND lifecycle = 'queued'
        ORDER BY queue_position IS NULL, queue_position, intent_seq`
    ).all(value.sessionKey) as (Omit<HostQueueRow, 'queueHeld'> & { queueHeld: number | null })[]
    return hostQueueEntries(rows.map((row) => ({ ...row, queueHeld: row.queueHeld === 1 })), value.sessionKey)
  }
})
