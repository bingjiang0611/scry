import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { DesktopRemoteContext, DesktopTraceCursor } from '../shared/desktop-remote'
import type { PerformanceTrace } from './performance-timing'
import { refusedView } from './daemon-run-admission'
import { isConversationRunId } from './daemon-run-evidence'

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
  /** Set once the intent or live trace establishes how to route the run. */
  scopedDelivery?: boolean
  // Latest output sequence observed on the subscription.
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
  // P4-3 subscribe-mode dedupe flags so snapshot resets never emit duplicate notices.
  settledNotified?: boolean
  notifiedSessionId?: string
  stopNotified?: boolean
}

export function usesScopedRunDelivery(cursor: RunCursor): boolean {
  return cursor.scopedDelivery === true || isConversationRunId(cursor.scryRunId, cursor.runId)
}

export function view(cursor: RunCursor): ActiveRun | null {
  // A run refused before the daemon registered it has no snapshot; its ledger failure is the view.
  if (!cursor.latest) return refusedView(cursor)
  const terminal = cursor.lifecycle === 'settled' || cursor.lifecycle === 'failed' || cursor.lifecycle === 'cancelled' || cursor.lifecycle === 'interrupted'
  return terminal && !cursor.latest.done ? { ...cursor.latest, done: true } : cursor.latest
}
