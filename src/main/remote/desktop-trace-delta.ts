import { createHash, randomUUID } from 'node:crypto'
import { projectionStamp } from '../live-trace'
import type { DesktopTraceCursor } from '../../shared/desktop-remote'
import type { TraceEvent } from '../../shared/trace'

// Bounds for host-side delta state. It holds item hashes and changed indices,
// never trace content. State is keyed by live run (not by peer) because a
// revision is a function of the run's item list; every authorized peer reading
// the same run shares it. Entries are dropped when the run leaves the live set,
// when no peer has read them for the idle window (disconnected clients stop
// reading; the sweep runs on the next desktop read), and least-recently-read
// beyond MAX_RUNS. An evicted or unknown revision only costs that client one
// full snapshot (reset).
const MAX_RUNS = 8
const MAX_REVISIONS = 32
const MAX_TRACKED_CHANGES = 50_000

interface Revision { seq: number; count: number; changed: number[] }
/** The projection generation this store last hashed for a run, if the input carried a stamp. */
interface ProjectionHint {
  generation: object
  revision: number
}

interface RunRevisions {
  epoch: string
  hashes: string[]
  revisions: Revision[]
  trackedChanges: number
  touched: number
  hint: ProjectionHint | null
}

const hashItem = (item: TraceEvent): string => createHash('sha256').update(JSON.stringify(item)).digest('base64url')

export type TraceDeltaAnswer =
  | { reset: true; revision: string }
  | { reset: false; revision: string; count: number; changes: number[] }

// Live items are mutated in place (coalesced text, persisted tool content,
// result_superseded, replaced streamed text), so neither object identity nor an
// append-only sequence number can tell what changed. Hash bounded items — in full
// unless the main-process projection stamp proves which suffix can still differ —
// and record the indices that differ between consecutive reads.
export function createTraceRevisions() {
  const runs = new Map<string, RunRevisions>()
  const name = (entry: RunRevisions, revision: Revision): string => `${entry.epoch}:${revision.seq}`
  return {
    observe(runId: string, items: readonly TraceEvent[], after?: DesktopTraceCursor, now = Date.now()): TraceDeltaAnswer {
      let entry = runs.get(runId)
      if (entry) runs.delete(runId)
      entry ??= { epoch: randomUUID(), hashes: [], revisions: [{ seq: 0, count: 0, changed: [] }], trackedChanges: 0, touched: now, hint: null }
      entry.touched = now
      runs.set(runId, entry)
      while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!)
      // Reuse only what the stamp proves: nothing (no stamp, another generation, a projection this
      // store never hashed, an inconsistent hint), the whole list (this exact projection was hashed
      // already), or a suffix (the projection it hashed is the one this one was rebuilt from).
      const stamp = projectionStamp(items)
      const previous = stamp && entry.hint && entry.hint.generation === stamp.generation ? entry.hint : null
      const hashed = (revision: number | null): boolean => revision !== null && previous !== null && previous.revision === revision
      const unchanged = stamp !== undefined && hashed(stamp.revision) && entry.hashes.length === items.length
      // Compare start: the whole list when it is unchanged (so the loop does not run), the rebuilt
      // suffix otherwise, and nothing when the kept hashes cannot line up with this list. The
      // reused prefix is copied and every hash is written into this call's list once, compared once.
      const suffix = stamp !== undefined && hashed(stamp.baseRevision) ? Math.min(stamp.dirtyFrom, items.length) : 0
      const compareFrom = unchanged ? items.length : suffix <= entry.hashes.length ? suffix : 0
      const hashes = unchanged ? entry.hashes : compareFrom === 0 ? [] : entry.hashes.slice(0, compareFrom)
      const changed: number[] = []
      for (let index = compareFrom; index < items.length; index++) {
        const hash = hashItem(items[index])
        hashes.push(hash)
        if (entry.hashes[index] !== hash) changed.push(index)
      }
      const current = entry.revisions.at(-1)!
      if (changed.length > 0 || hashes.length !== entry.hashes.length) {
        entry.revisions.push({ seq: current.seq + 1, count: hashes.length, changed })
        entry.trackedChanges += changed.length
        entry.hashes = hashes
        while (entry.revisions.length > MAX_REVISIONS || (entry.trackedChanges > MAX_TRACKED_CHANGES && entry.revisions.length > 1)) {
          entry.trackedChanges -= entry.revisions.shift()!.changed.length
        }
      }
      // Remember what this call actually hashed. An input without a stamp clears the hint, so an
      // unhinted read between two hinted ones cannot let the next read skip a real hash.
      entry.hint = stamp ? { generation: stamp.generation, revision: stamp.revision } : null
      const latest = entry.revisions.at(-1)!
      const revision = name(entry, latest)
      if (!after) return { reset: true, revision }
      const base = entry.revisions.findIndex((candidate) => name(entry, candidate) === after.revision)
      // Unknown epoch, evicted revision or a client count that does not match
      // the named revision: the client copy cannot be proven complete.
      if (base < 0 || entry.revisions[base].count !== after.count) return { reset: true, revision }
      const indices = new Set<number>()
      for (const step of entry.revisions.slice(base + 1)) for (const index of step.changed) if (index < latest.count) indices.add(index)
      return { reset: false, revision, count: latest.count, changes: [...indices].sort((left, right) => left - right) }
    },
    forget(runId: string): void { runs.delete(runId) },
    sweep(now: number, idleMs: number): void { for (const [runId, entry] of runs) if (now - entry.touched >= idleMs) runs.delete(runId) },
    size: (): number => runs.size
  }
}
