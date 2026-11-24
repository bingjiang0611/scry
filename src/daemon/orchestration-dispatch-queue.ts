import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { TERMINAL_LIFECYCLE_SQL } from '../host-runtime/orchestration/run-transitions'

/**
 * D1: a run may not dispatch while another run of the same session is still live. The caller turns
 * this into a policy deferral, so the queued effect keeps its attempts and drains after the head.
 */
export function sessionQueueBlocksDispatch(sink: EventSink, runId: string): boolean {
  const run = sink.getRun(runId)
  if (!run?.sessionKey) return false
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
