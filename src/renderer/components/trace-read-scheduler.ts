import { TRACE_REFRESH_FLOOR_MS } from './RemoteChatShared'

// Content reads are coalesced on a floor, not followed report by report: an active
// run emits a ledger batch every few hundred milliseconds and reading each one cost
// six times the pre-long-poll rate (measured, see scripts/remote-trace-read-frequency.mjs).
//
// Coalescing alone loses content. The host long poll returns as soon as the run
// changes and then waits up to 15 s, so a batch skipped inside the floor would sit
// unread until the window expires. A run followed from another device is worse: the
// live-run set only carries the run and its state, so its content had no reader at
// all. This scheduler owns both edges:
//   - a change skipped inside the floor arms one tail read at floor expiry;
//   - a followed run that is live is read on the floor, independent of any poll.
// Both paths go through one floor check, so a run is still read at most once per
// floor however many reports and ticks arrive.
export interface TraceReadEnvironment {
  now: () => number
  isHidden: () => boolean
  setTimeout: (callback: () => void, delay: number) => number
  clearTimeout: (handle: number) => void
}

const browserEnvironment = (): TraceReadEnvironment => ({
  now: () => Date.now(),
  isHidden: () => document.hidden,
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => window.clearTimeout(handle)
})

export type TraceReadReason = 'change' | 'tail' | 'live'

export interface TraceReadScheduler {
  // A change report for the run on screen. The caller performs a read on
  // 'read-now' and reports it back with markRead(); on 'coalesced' a tail read is
  // armed and the caller does nothing.
  decide(runId: string): 'read-now' | 'coalesced'
  markRead(at?: number): void
  // The run on screen is followed from another device and still live. Reads its
  // content on the floor until called again with undefined.
  setLive(runId: string | undefined): void
  dispose(): void
}

export function createTraceReadScheduler(
  // The read may be asynchronous; while it is in flight no second read starts.
  read: (runId: string, reason: TraceReadReason) => void | Promise<void>,
  environment: TraceReadEnvironment = browserEnvironment()
): TraceReadScheduler {
  let lastReadAt = Number.NEGATIVE_INFINITY
  let lastRunId: string | undefined
  let decidedRunId: string | undefined
  let inFlight = false
  let pending: string | undefined
  let tail: number | undefined
  let liveRunId: string | undefined
  let live: number | undefined

  const remaining = (): number => Math.max(0, lastReadAt + TRACE_REFRESH_FLOOR_MS - environment.now())
  const clearTail = (): void => {
    if (tail === undefined) return
    environment.clearTimeout(tail)
    tail = undefined
  }
  const clearLive = (): void => {
    if (live === undefined) return
    environment.clearTimeout(live)
    live = undefined
  }
  // A hidden page keeps no timer: reading a run nobody can see is wasted work, and
  // the next visible report reads immediately.
  const perform = (runId: string, reason: TraceReadReason): boolean => {
    if (environment.isHidden()) return false
    // One read at a time: a slow read keeps its turn instead of racing the next
    // tick, which would merge two patches onto the same stale view.
    if (inFlight) { pending = runId; return false }
    if (runId === lastRunId && environment.now() - lastReadAt < TRACE_REFRESH_FLOOR_MS) return false
    lastReadAt = environment.now()
    lastRunId = runId
    const result = read(runId, reason)
    if (result && typeof result.then === 'function') {
      inFlight = true
      const settle = (): void => {
        inFlight = false
        const next = pending
        pending = undefined
        if (next) perform(next, 'tail')
        else armLive()
      }
      void result.then(settle, settle)
    }
    return true
  }
  const armTail = (): void => {
    // While a read is in flight the tail waits for it to settle instead of arming
    // a timer that would fire into the same guard.
    if (tail !== undefined || !pending || inFlight) return
    tail = environment.setTimeout(() => {
      tail = undefined
      const runId = pending
      pending = undefined
      if (runId) perform(runId, 'tail')
    }, remaining())
  }
  // A followed run reads at once when it appears, then on the floor. Re-arming for
  // the remaining part of the floor keeps the cadence without double reading; while
  // the page is hidden the timer keeps spinning but performs no read.
  const armLive = (): void => {
    // Blocked reads resume from settle()/markRead(), so a chain never spins while
    // one read is still outstanding.
    if (live !== undefined || !liveRunId || inFlight) return
    live = environment.setTimeout(() => {
      live = undefined
      if (!liveRunId) return
      // Hidden: stop the chain instead of spinning. The next visible poll (or
      // report) re-arms it, so nothing is read while the page is invisible.
      if (environment.isHidden()) return
      perform(liveRunId, 'live')
      armLive()
    }, Math.max(0, remaining()))
  }

  return {
    decide(runId) {
      // A different run is read at once: moving from run A to run B in one session
      // must not wait for A's floor to expire.
      const differentRun = runId !== lastRunId
      if (!environment.isHidden() && !inFlight && (differentRun || environment.now() - lastReadAt >= TRACE_REFRESH_FLOOR_MS)) {
        clearTail()
        pending = undefined
        decidedRunId = runId
        // The caller owns this read; it clears the slot with markRead().
        inFlight = true
        return 'read-now'
      }
      pending = runId
      armTail()
      return 'coalesced'
    },
    markRead(at) {
      lastReadAt = at ?? environment.now()
      lastRunId = decidedRunId ?? lastRunId
      decidedRunId = undefined
      inFlight = false
      clearTail()
      const next = pending
      pending = undefined
      if (next) perform(next, 'tail')
      else armLive()
    },
    setLive(runId) {
      // Same run with the chain still armed is a no-op; same run with no timer
      // (page was hidden, or the tick stopped it) re-arms.
      if (runId === liveRunId && (live !== undefined || !runId)) return
      liveRunId = runId
      clearLive()
      if (runId) armLive()
    },
    dispose() {
      clearTail()
      clearLive()
      pending = undefined
      liveRunId = undefined
    }
  }
}
