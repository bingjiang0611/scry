import type { ActiveRun } from '../shared/trace'
import type { DesktopTraceCursor, DesktopRemoteTraceRead } from '../shared/desktop-remote'
import { DaemonRunError, fail, record } from './daemon-run-error'
import { assembleByteChunks } from './remote/desktop-byte-chunks'

// The App's canonical trace read against its own daemon: the `desktop` trace frame and
// the parse of its `trace` / `trace_delta` answer. The caller supplies the call, which
// already maps transport failures and daemon error codes to named rejections.
//
// The read asks for `byteChunks`: a trace whose JSON is past the host's single-response
// limit (4 MiB - 1 KiB) comes back as `history_chunk` pages. The live projection bounds
// tool bodies, not the model's text or thinking, nor the number of steps, so a long run
// (or the snapshot after a reopen or resync) can be that large.

export type DaemonTraceCall = (
  request: Record<string, unknown>,
  options?: { replayable?: boolean }
) => Promise<Record<string, unknown>>

/**
 * One canonical trace read for a live run; the delta cursor is the caller's.
 * `settledTail`: the read after `run_settled` still gets the run's final trace.
 */
export async function readDaemonTrace(
  call: DaemonTraceCall,
  input: { context: unknown; runId: string; after?: DesktopTraceCursor }
): Promise<DesktopRemoteTraceRead> {
  const query = {
    kind: 'trace', context: input.context, runId: input.runId, images: true, byteChunks: true, settledTail: true,
    ...(input.after ? { delta: { after: input.after } } : {})
  }
  const page = async (chunk?: { id: string; offset: number }): Promise<Record<string, unknown>> => {
    // The host keys a page on the whole query (context, run, delta cursor, settledTail),
    // so each continuation repeats it unchanged and adds only `chunk`. Every page is a
    // read of bytes the host already cut: a replay returns the same page, or for a page
    // the host has since dropped an explicit error, which fails this read closed.
    const reply = await call({ op: 'desktop', query: chunk ? { ...query, chunk } : query }, { replayable: true })
    return record(reply.desktop) ? reply.desktop : fail()
  }
  let desktop = await page()
  if (desktop.kind === 'history_chunk') desktop = await assembleByteChunks(desktop, page, fail)
  // The wire says `trace`/`trace_delta`; the renderer contract says
  // snapshot/delta. A wire shape that names neither is refused, not guessed.
  if (desktop.kind === 'trace') {
    const run = desktop.run === null ? null : record(desktop.run) && typeof desktop.run.runId === 'string' ? desktop.run as unknown as ActiveRun : fail()
    const cursor = traceCursor(desktop.cursor)
    return { kind: 'snapshot', run, ...(cursor ? { cursor } : {}) }
  }
  if (desktop.kind === 'trace_delta') {
    const base = typeof desktop.base === 'string' ? desktop.base : fail()
    const cursor = traceCursor({ revision: desktop.revision, count: desktop.count })
    if (!record(desktop.run) || !Array.isArray(desktop.changes)) throw new DaemonRunError('invalid_daemon_response')
    return {
      kind: 'delta', run: desktop.run as unknown as Omit<ActiveRun, 'items'>,
      base, cursor: cursor ?? fail(), changes: desktop.changes as never
    }
  }
  throw new DaemonRunError('invalid_daemon_response')
}

function traceCursor(value: unknown): DesktopTraceCursor | undefined {
  if (value === undefined) return undefined
  if (!record(value) || typeof value.revision !== 'string' || !Number.isSafeInteger(value.count)) return undefined
  return { revision: value.revision, count: value.count as number }
}
