import type { DesktopLaneName } from './desktop-lane'

// Which lane each request takes (see the lane list in desktop-lane.ts), and which
// requests may be replayed after a lost reply.

// Writes stay on the control lane: cancelling a large read must never tear down an
// in-flight write, and a write is never replayed after its bytes were written.
const writeOperations = new Set([
  'answerQuestion', 'attachmentChunk', 'attachmentCommit', 'attachmentStart',
  'resolveIntent', 'sessionAction', 'sessionDelete', 'sessionFork', 'stop', 'submit'
])
const watchOperations = new Set(['watch'])
const statusOperations = new Set(['liveRuns'])
const eventOperations = new Set(['appEvents'])
// `desktop` carries its own kind; history/trace/image reads are the large ones.
const bulkDesktopKinds = new Set(['history', 'trace', 'trace_delta', 'image_chunk'])

export function laneForRequest(request: unknown): DesktopLaneName {
  const op = request && typeof request === 'object' ? (request as { op?: unknown }).op : undefined
  if (typeof op !== 'string') return 'control'
  if (writeOperations.has(op)) return 'control'
  if (watchOperations.has(op)) return 'watch'
  if (statusOperations.has(op)) return 'status'
  if (eventOperations.has(op)) return 'events'
  if (op === 'desktop') {
    const kind = (request as { query?: { kind?: unknown } }).query?.kind
    return typeof kind === 'string' && bulkDesktopKinds.has(kind) ? 'bulk' : 'control'
  }
  // Long reads and paged payloads: history, trace pages, downloads, file reads.
  return 'bulk'
}

export function replayableRequest(request: unknown): boolean {
  const op = request && typeof request === 'object' ? (request as { op?: unknown }).op : undefined
  return !(typeof op === 'string' && writeOperations.has(op))
}
