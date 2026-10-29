import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { DesktopTraceCursor } from '../../shared/desktop-remote'
import { appendCoalescedTrace, replaceTraceById } from '../live-trace'
import { DockBadgeState } from '../dock-badge'
import { createTraceRuntime } from '../bootstrap/trace-runtime'
import { createTraceRevisions, type TraceDeltaAnswer } from './desktop-trace-delta'

// Bounds and reset semantics on stamped arrays. The released limits (MAX_RUNS, MAX_REVISIONS,
// MAX_TRACKED_CHANGES) and reset rules must keep their meaning now that the store can reuse hashes,
// so each case is compared with an independent full-hash store that ignores projection stamps.
const MAX_REVISIONS = 32
const MAX_TRACKED_CHANGES = 50_000
const RUN = 'run-bounds-1'

interface OracleRevision { seq: number; count: number; changed: number[] }

function createFullRevisions() {
  const runs = new Map<string, { epoch: string; hashes: string[]; revisions: OracleRevision[]; trackedChanges: number; touched: number }>()
  let epoch = 0
  const name = (entry: { epoch: string }, revision: OracleRevision): string => `${entry.epoch}:${revision.seq}`
  return {
    observe(runId: string, items: readonly TraceEvent[], after?: DesktopTraceCursor, now = Date.now()): TraceDeltaAnswer {
      let entry = runs.get(runId)
      if (entry) runs.delete(runId)
      entry ??= { epoch: `oracle-${++epoch}`, hashes: [], revisions: [{ seq: 0, count: 0, changed: [] }], trackedChanges: 0, touched: now }
      entry.touched = now
      runs.set(runId, entry)
      const hashes = items.map((item) => createHashAll(item))
      const changed: number[] = []
      for (let index = 0; index < hashes.length; index++) if (entry.hashes[index] !== hashes[index]) changed.push(index)
      const current = entry.revisions.at(-1)!
      if (changed.length > 0 || hashes.length !== entry.hashes.length) {
        entry.revisions.push({ seq: current.seq + 1, count: hashes.length, changed })
        entry.trackedChanges += changed.length
        entry.hashes = hashes
        while (entry.revisions.length > MAX_REVISIONS || (entry.trackedChanges > MAX_TRACKED_CHANGES && entry.revisions.length > 1)) {
          entry.trackedChanges -= entry.revisions.shift()!.changed.length
        }
      }
      const latest = entry.revisions.at(-1)!
      const revision = name(entry, latest)
      if (!after) return { reset: true, revision }
      const base = entry.revisions.findIndex((candidate) => name(entry, candidate) === after.revision)
      if (base < 0 || entry.revisions[base].count !== after.count) return { reset: true, revision }
      const indices = new Set<number>()
      for (const step of entry.revisions.slice(base + 1)) for (const index of step.changed) if (index < latest.count) indices.add(index)
      return { reset: false, revision, count: latest.count, changes: [...indices].sort((left, right) => left - right) }
    },
    sweep(now: number, idleMs: number): void { for (const [runId, entry] of runs) if (now - entry.touched >= idleMs) runs.delete(runId) },
    size: (): number => runs.size
  }
}
// Separate from the incremental store's hashing on purpose: this oracle is the released rule.
const createHashAll = (item: TraceEvent): string => createHash('sha256').update(JSON.stringify(item)).digest('base64url')

let seq = 0
const runtime = () => createTraceRuntime({
  getWindow: () => null,
  rendererCanReceive: () => false,
  activeRunSessionKey: () => null,
  dockBadge: new DockBadgeState(() => { }),
  mainEventId: (prefix, runId) => `${prefix}:${runId}:${++seq}`
})
const run = (): ActiveRun => ({ runId: RUN, providerId: 'claude', userText: 'task', items: [], done: false })
// Lightweight events that the append helper pushes without scanning the list.
const note = (index: number): TraceEvent => ({ id: `n-${index}`, ts: 'T', runId: RUN, kind: 'harness', stage: 'note' })

describe('revision store bounds on stamped arrays', () => {
  it('trims history once 50_000 changed indices accumulate, far below the revision bound', () => {
    const trace = runtime()
    const state = run()
    for (let index = 0; index < MAX_TRACKED_CHANGES; index++) appendCoalescedTrace(state.items, note(index))
    const store = createTraceRevisions()
    const oracle = createFullRevisions()
    const first = trace.boundedLiveRun(state).items
    const snapshot = store.observe(RUN, first)
    const oracleSnapshot = oracle.observe(RUN, first)
    expect(snapshot.reset).toBe(true)
    // One real change on top of the 50_000 already tracked pushes the budget over its limit while
    // publishing the second revision, so the revision those 50_000 changes belong to is evicted in
    // the same call. A peer holding it must resync instead of receiving a delta.
    replaceTraceById(state.items, { ...state.items[0], stage: 'note-updated' })
    const second = trace.boundedLiveRun(state).items
    const evicted = store.observe(RUN, second, { revision: snapshot.revision, count: MAX_TRACKED_CHANGES })
    const oracleEvicted = oracle.observe(RUN, second, { revision: oracleSnapshot.revision, count: MAX_TRACKED_CHANGES })
    expect(evicted.reset).toBe(true)
    expect(oracleEvicted.reset).toBe(true)
    // Only index 0 moved: the two projections are byte-identical everywhere else.
    expect(second[0].stage).toBe('note-updated')
    expect(first[0].stage).toBe('note')
    expect(JSON.stringify(second.slice(1))).toBe(JSON.stringify(first.slice(1)))
    // The current revision still serves deltas: a cursor on it gets a quiet, valid answer, and the
    // independent oracle agrees. Two revisions exist, so nothing here is revision-bound eviction.
    const quiet = store.observe(RUN, second, { revision: evicted.revision, count: MAX_TRACKED_CHANGES })
    const oracleQuiet = oracle.observe(RUN, second, { revision: oracleEvicted.revision, count: MAX_TRACKED_CHANGES })
    expect(quiet.reset).toBe(false)
    expect(quiet.reset === false && quiet.changes).toEqual([])
    expect(oracleQuiet.reset).toBe(false)
    expect(oracleQuiet.reset === false && oracleQuiet.changes).toEqual([])
  })

  it('resets a stale cursor after the idle sweep drops a stamped run', () => {
    const trace = runtime()
    const state = run()
    const store = createTraceRevisions()
    const oracle = createFullRevisions()
    appendCoalescedTrace(state.items, note(0))
    const first = trace.boundedLiveRun(state).items
    const snapshot = store.observe(RUN, first, undefined, 1_000)
    const oracleSnapshot = oracle.observe(RUN, first, undefined, 1_000)
    expect(store.size()).toBe(1)
    store.sweep(2_000, 500)
    oracle.sweep(2_000, 500)
    expect(store.size()).toBe(0)
    // The projection is reused from the cache, so this read really does carry a stamp.
    const cursor = { revision: snapshot.revision, count: 1 }
    expect(store.observe(RUN, trace.boundedLiveRun(state).items, cursor, 2_000).reset).toBe(true)
    expect(oracle.observe(RUN, trace.boundedLiveRun(state).items, { revision: oracleSnapshot.revision, count: 1 }, 2_000).reset).toBe(true)
  })

  it('resets a cursor whose count does not match, even with a stamp present', () => {
    const trace = runtime()
    const state = run()
    const store = createTraceRevisions()
    const oracle = createFullRevisions()
    appendCoalescedTrace(state.items, note(0))
    const projected = trace.boundedLiveRun(state).items
    const snapshot = store.observe(RUN, projected)
    const oracleSnapshot = oracle.observe(RUN, projected)
    expect(store.observe(RUN, projected, { revision: snapshot.revision, count: 0 }).reset).toBe(true)
    expect(store.observe(RUN, projected, { revision: snapshot.revision, count: 2 }).reset).toBe(true)
    expect(store.observe(RUN, projected, { revision: snapshot.revision, count: 1 }).reset).toBe(false)
    expect(oracle.observe(RUN, projected, { revision: oracleSnapshot.revision, count: 1 }).reset).toBe(false)
  })
})
