import { PerformanceTrace } from './performance-timing'
import type { DesktopRemoteTraceRead } from '../shared/desktop-remote'
import { noteWatchEvents, type RunCursor } from './daemon-run-cursor'
import type { DaemonRunTransport } from './daemon-run-transport'

export const DEFAULT_WATCH_WAIT_MS = 15_000

/** Legacy per-run `watch` + `trace` step (used ONLY when daemon is in off/shadow mode). */
export async function stepLegacyWatchRun(input: {
  cursor: RunCursor
  runId: string
  waitMs: number
  transport: Pick<DaemonRunTransport, 'watch' | 'trace'>
  onSeen: (cursor: number) => void
  apply: (read: DesktopRemoteTraceRead, cursor: RunCursor) => boolean
  publishQuestions: (cursor: RunCursor) => Promise<void>
  flush: () => void
}): Promise<{ changed: boolean; lifecycle: string | null }> {
  const { cursor, runId } = input
  const trace = new PerformanceTrace('daemon.run.pump', cursor.context ? { provider: cursor.context.providerId } : {})
  let changed = false
  try {
    const watch = await input.transport.watch({
      runId, cursor: cursor.watch, outputCursor: cursor.output,
      waitMs: input.waitMs, output: 'wake'
    })
    cursor.watch = Math.max(cursor.watch, watch.cursor)
    input.onSeen(watch.cursor)
    if (watch.output.count > 0) {
      cursor.output = Math.max(cursor.output, watch.output.cursor)
      changed = true
    }
    if (watch.state !== cursor.lifecycle) changed = true
    noteWatchEvents(cursor, watch.events)
    if (cursor.context === undefined) { cursor.lifecycle = watch.state; return { changed, lifecycle: cursor.lifecycle } }
    const read = await input.transport.trace({
      context: cursor.context, runId: cursor.scryRunId ?? runId, ...(cursor.after ? { after: cursor.after } : {})
    })
    if (cursor.stamp && cursor.latest === undefined && read.kind === 'snapshot' && read.run) cursor.stamp.mark('firstTrace')
    if (input.apply(read, cursor)) changed = true
    await input.publishQuestions(cursor)
    if (changed) input.flush()
    cursor.lifecycle = watch.state
    if (watch.state === 'settled' || watch.state === 'failed' || watch.state === 'cancelled') cursor.stopped = true
    return { changed, lifecycle: cursor.lifecycle }
  } finally {
    trace.finish({ bufferedEvents: changed ? 1 : 0 })
  }
}
