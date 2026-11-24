import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { TERMINAL_LIFECYCLE_SQL } from '../host-runtime/orchestration/run-transitions'

/**
 * D1: a run may not dispatch while another run of the same session is still live, and a held run does
 * not dispatch at all — that is what "挂起" promises. The caller turns both into a policy deferral, so
 * the queued effect keeps its attempts and drains after the head (or after the hold is released).
 */
export function sessionQueueBlocksDispatch(sink: EventSink, runId: string): boolean {
  const run = sink.getRun(runId)
  if (!run?.sessionKey) return false
  if (run.queueHeld === true) return true
  const row = sink.handle.db
    .prepare(
      `SELECT 1 FROM orch_p_run
       WHERE session_key = ? AND run_id <> ?
         AND lifecycle NOT IN ${TERMINAL_LIFECYCLE_SQL}
       LIMIT 1`
    )
    .get(run.sessionKey, runId)
  return Boolean(row)
}
