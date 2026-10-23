import type { DesktopRemoteTraceRead, DesktopTraceCursor } from '../shared/desktop-remote'
import type { ActiveRun } from '../shared/trace'

// The remote run shown by RemoteChat plus the host revision it was built from.
// `cursor` is absent for older hosts (full snapshots only).
export interface RemoteTraceView { run: ActiveRun; cursor?: DesktopTraceCursor }
export type RemoteTraceMerge =
  | { kind: 'applied'; view: RemoteTraceView | null; changed: boolean }
  // The delta does not continue from the shown revision: the caller must read
  // a full snapshot. A partially applied run would hide events.
  | { kind: 'gap' }

function sameMeta(left: ActiveRun, right: Omit<ActiveRun, 'items'>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  keys.delete('items')
  keys.delete('attachments')
  for (const key of keys) {
    const a = (left as unknown as Record<string, unknown>)[key]
    const b = (right as unknown as Record<string, unknown>)[key]
    if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) return false
  }
  return true
}

// Index-based like the host projection: the host already coalesced and
// replaced events, so re-applying applyTraceBatch's coalescing here could
// diverge from host truth. Unchanged items keep their object identity, and a
// read with no change returns the previous view so React can skip the render.
export function mergeRemoteTrace(previous: RemoteTraceView | null, read: DesktopRemoteTraceRead): RemoteTraceMerge {
  const prior = previous && previous.run.runId === read.run?.runId ? previous : null
  if (read.kind === 'snapshot') {
    if (!read.run) return { kind: 'applied', view: null, changed: previous !== null }
    // An unchanged image count returns no attachments: keep the ones shown.
    const run = read.run.attachments === undefined && prior?.run.attachments ? { ...read.run, attachments: prior.run.attachments } : read.run
    return { kind: 'applied', view: { run, ...(read.cursor ? { cursor: read.cursor } : {}) }, changed: true }
  }
  if (!prior?.cursor || prior.cursor.revision !== read.base || prior.cursor.count !== prior.run.items.length) return { kind: 'gap' }
  const { count } = read.cursor
  // Every index the client did not hold must be listed; otherwise events are missing.
  const covered = new Set(read.changes.map((change) => change.index))
  for (let index = Math.min(prior.run.items.length, count); index < count; index++) if (!covered.has(index)) return { kind: 'gap' }
  let items = prior.run.items
  if (read.changes.length > 0 || count !== items.length) {
    items = items.slice(0, count)
    for (const change of read.changes) items[change.index] = change.item
  }
  const incoming = read.run.attachments
  // An unchanged image count yields no attachments, or a fresh empty list when there are none.
  const attachments = incoming === undefined || (incoming.length === 0 && prior.run.attachments?.length === 0) ? prior.run.attachments : incoming
  const changed = items !== prior.run.items || attachments !== prior.run.attachments || !sameMeta(prior.run, read.run)
  if (!changed) return { kind: 'applied', view: prior.cursor.revision === read.cursor.revision ? prior : { run: prior.run, cursor: read.cursor }, changed: false }
  return { kind: 'applied', view: { run: { ...read.run, ...(attachments ? { attachments } : {}), items }, cursor: read.cursor }, changed: true }
}
