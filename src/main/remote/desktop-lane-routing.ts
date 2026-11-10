import type { DesktopLaneName } from './desktop-lane'
import { DESKTOP_WORKBENCH_READ_METHODS } from '../../shared/desktop-workbench'

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
// Short and idempotent: on the control lane, and replayable because it changes nothing twice.
const idempotentControlOperations = new Set(['attentionViewed'])
// `desktop` carries its own kind; history/trace/image reads are the large ones.
const bulkDesktopKinds = new Set(['history', 'trace', 'trace_delta', 'image_chunk'])

// `desktopWorkbench` carries its own method: file writes, Git/PR mutations, drafts and
// PTY input are writes like the ones above, whichever device or App sends them.
function workbenchWrite(op: string, request: unknown): boolean {
  if (op !== 'desktopWorkbench') return false
  const method = (request as { query?: { method?: unknown } }).query?.method
  return typeof method !== 'string' || !DESKTOP_WORKBENCH_READ_METHODS.has(method)
}

export function laneForRequest(request: unknown): DesktopLaneName {
  const op = request && typeof request === 'object' ? (request as { op?: unknown }).op : undefined
  if (typeof op !== 'string') return 'control'
  if (writeOperations.has(op) || workbenchWrite(op, request)) return 'control'
  if (idempotentControlOperations.has(op)) return 'control'
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
  return !(typeof op === 'string' && (writeOperations.has(op) || workbenchWrite(op, request)))
}
