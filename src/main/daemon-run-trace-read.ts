import type { ActiveRun } from '../shared/trace'
import type { DesktopTraceCursor, DesktopRemoteTraceRead } from '../shared/desktop-remote'
import { DaemonRunError, fail, record } from './daemon-run-error'
import { assembleByteChunks } from './remote/desktop-byte-chunks'


export type DaemonTraceCall = (
  request: Record<string, unknown>,
  options?: { replayable?: boolean }
) => Promise<Record<string, unknown>>

export async function readDaemonTrace(
  call: DaemonTraceCall,
  input: { context: unknown; runId: string; after?: DesktopTraceCursor; archive?: true }
): Promise<DesktopRemoteTraceRead> {
  const query = {
    kind: 'trace', context: input.context, runId: input.runId, images: true, byteChunks: true,
    ...(input.archive ? { archive: true } : {}),
    ...(input.after ? { delta: { after: input.after } } : {})
  }
  const page = async (chunk?: { id: string; offset: number }): Promise<Record<string, unknown>> => {
    const reply = await call({ op: 'desktop', query: chunk ? { ...query, chunk } : query }, { replayable: true })
    return record(reply.desktop) ? reply.desktop : fail()
  }
  let desktop = await page()
  if (desktop.kind === 'history_chunk') desktop = await assembleByteChunks(desktop, page, fail)
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
