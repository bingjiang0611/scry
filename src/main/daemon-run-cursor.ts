import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { DesktopRemoteContext, DesktopTraceCursor } from '../shared/desktop-remote'
import type { PerformanceTrace } from './performance-timing'
import { refusedView } from './daemon-run-admission'

// One window's cursor for one daemon run: what it has been told, what it has already
// delivered, and what the window currently shows. Kept apart from the polling so the
// shape and the "is it finished" rule can be read on their own.

export interface RunCursor {
  runId: string
  // Unknown until the daemon reports the bind, which is the only place it names the
  // Provider and directory of a run this window did not start.
  context?: DesktopRemoteContext
  lifecycle: string | null
  after?: DesktopTraceCursor
  // Canonical run id the daemon bound to this ledger run, once it said so.
  scryRunId?: string
  // Last ledger position this run's watch has read. The ledger answers with one page
  // at a time from a global sequence, so a watch that keeps asking from 0 only ever
  // re-reads the session's first page; this is what lets it walk forward to its own
  // evidence (and past a page boundary at all).
  watch: number
  // How much run content this watch has seen. Content is what actually moves while the
  // Provider streams; the ledger only moves at lifecycle points.
  output: number
  latest?: ActiveRun
  // The item last delivered at each index: a text block the daemon rewrites as it
  // streams is an append of that item, not a rewrite of history.
  pushed: TraceEvent[]
  askedQuestions: Set<string>
  // The daemon dedupes an answer by its own id, so one is minted per question and
  // reused when the same answer is retried.
  answerIds: Map<string, string>
  resyncRequired: boolean
  pumping: boolean
  stopped: boolean
  // Where the wait before the first token actually goes. Only recorded when perf
  // logging is on; it answers "which hop?" instead of guessing.
  stamp?: PerformanceTrace
  sawText: boolean
  // Admission as the ledger states it (daemon-run-admission.ts): the daemon's `admitted`
  // marker, and the reason of a terminal failure. Unset means not read yet.
  admitted?: boolean
  failure?: string
  // The prompt this window submitted, for the view of a run refused before it had one.
  userText?: string
  // Whether start() gave this run's id to the renderer.
  handedOut?: boolean
}

// `bound` is the daemon's own marker, not a client guess; anything else in the
// progress detail stays opaque.
// The trace only reports `done` when a snapshot happens to be the read that carries
// it; after the first snapshot every read is a delta, so a run that stops would look
// alive forever. The ledger's terminal state is the authority on whether a daemon run
// finished, and it is what the window's stop control waits for.
export function view(cursor: RunCursor): ActiveRun | null {
  // A run refused before the daemon registered it has no snapshot; its ledger failure is the view.
  if (!cursor.latest) return refusedView(cursor)
  const terminal = cursor.lifecycle === 'settled' || cursor.lifecycle === 'failed' || cursor.lifecycle === 'cancelled'
  return terminal && !cursor.latest.done ? { ...cursor.latest, done: true } : cursor.latest
}
