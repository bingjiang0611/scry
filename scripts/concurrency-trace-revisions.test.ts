import { AssertionError, deepStrictEqual } from 'node:assert'
import { describe, expect, it } from 'vitest'
import { createTraceRuntime } from '../src/main/bootstrap/trace-runtime'
import { DockBadgeState } from '../src/main/dock-badge'
import { createTraceRevisions, type TraceDeltaAnswer } from '../src/main/remote/desktop-trace-delta'
import { sanitizeToolEvents } from '../src/core/turn-recorder/tool-content'
import { mergeRemoteTrace, type RemoteTraceView } from '../src/renderer/remote-trace'
import type { DesktopRemoteTraceRead, DesktopTraceCursor } from '../src/shared/desktop-remote'
import type { ActiveRun } from '../src/shared/trace'
import { applyWorkloadStep, createWorkloadRun, WORKLOAD_STEPS } from './fixtures/concurrency-trace-workload'

// Main projection/revision component test: the real boundedLiveRun and the real revision
// store, consumed through the production mergeRemoteTrace semantics. There is no
// DesktopRemoteClient, no TLS and no App composition here. DesktopRemoteClient caps one read
// at 10000 items (desktop-client-validation.ts), so the 50k case is deliberately a
// host/main-side projection claim and never a client-capability claim; 1k and 10k also run
// here as main-side claims.
//
// Coverage this file does not repeat: shrink, streamed-text replacement, unknown or
// forgotten cursors, the bounded run count, the 32-revision bound and the idle sweep are
// already covered by src/main/remote/desktop-trace-delta.test.ts, whose sweep check uses a
// logical clock and therefore validates the bound rather than real reader scheduling.

const LIVE_POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }
const BASE_TS = 1_800_000_000_000
let eventSeq = 0

const boundedRuntime = () => createTraceRuntime({
  getWindow: () => null,
  rendererCanReceive: () => false,
  activeRunSessionKey: () => null,
  dockBadge: new DockBadgeState(() => {}),
  mainEventId: (prefix, runId) => `${prefix}:${runId}:${++eventSeq}`
})

// Complete JSON visible semantics. Every caller passes a defined run or item list, so a
// non-serializable input is a bug in this file rather than something to coerce.
const projection = (value: unknown): unknown => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('projection input must be JSON-serializable')
  return JSON.parse(encoded)
}

// The peer holds decoded copies, never the host's live objects, so the mirrored envelope is
// round-tripped through JSON once before mergeRemoteTrace sees it. Without this a delivered
// view would share item objects with the run the host keeps mutating.
const transmit = (envelope: DesktopRemoteTraceRead): DesktopRemoteTraceRead => projection(envelope) as DesktopRemoteTraceRead

// Mirrors the host reader's trace branch: a reset answer travels as a full snapshot,
// otherwise only the listed indices travel.
function read(bounded: ActiveRun, answer: TraceDeltaAnswer, prior: RemoteTraceView | null): DesktopRemoteTraceRead {
  if (answer.reset) return transmit({ kind: 'snapshot', run: bounded, cursor: { revision: answer.revision, count: bounded.items.length } })
  const { items, ...meta } = bounded
  return transmit({
    kind: 'delta',
    run: meta,
    base: prior!.cursor!.revision,
    cursor: { revision: answer.revision, count: answer.count },
    changes: answer.changes.map((index) => ({ index, item: items[index] }))
  })
}

function follow(view: RemoteTraceView | null, next: DesktopRemoteTraceRead): RemoteTraceView {
  const merged = mergeRemoteTrace(view, next)
  if (merged.kind !== 'applied' || !merged.view) throw new Error('read did not apply')
  return merged.view
}

// Independent oracle for a whole run: the raw run plus the real bounded projection of its
// items, so the fixture's own runtime projection is never used as its own reference.
const oracleRun = (run: ActiveRun): unknown => projection({
  ...run,
  items: sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')
})

const DELIVERY_STEPS = ['seed', 'quiet', 'replace-stream', 'append'] as const

// One read/follow per step, exactly as the peer would consume them, returning the last
// delivered view.
function deliver(runtime: ReturnType<typeof boundedRuntime>, revisions: ReturnType<typeof createTraceRevisions>, run: ActiveRun, k: number): RemoteTraceView {
  let view: RemoteTraceView | null = null
  for (const step of DELIVERY_STEPS) {
    applyWorkloadStep(run, step, k)
    const bounded = runtime.boundedLiveRun(run)
    const answer = revisions.observe(run.runId, bounded.items, view?.cursor)
    view = follow(view, read(bounded, answer, view))
  }
  if (!view) throw new Error('delivery produced no view')
  return view
}

describe('concurrency trace revisions', () => {
  // The real command scales through the real projection and store. Each step is compared as
  // complete JSON: bodies, inputs, order and every metadata field. read() already delivers a
  // decoded copy, so the view can be compared with the projected oracle directly instead of
  // serializing the whole 50k run a second time. Node's strict JSON-object comparison avoids
  // the general matcher dispatch per field while still checking every item and metadata key.
  it.each([1000, 10000, 50000])('projects the whole workload through the real revision store at k=%i', (k) => {
    const runtime = boundedRuntime()
    const revisions = createTraceRevisions()
    const run = createWorkloadRun({ runId: `run-rv-${k}`, k })
    let view: RemoteTraceView | null = null
    for (const step of WORKLOAD_STEPS) {
      applyWorkloadStep(run, step, k)
      const bounded = runtime.boundedLiveRun(run)
      const answer = revisions.observe(run.runId, bounded.items, view?.cursor)
      view = follow(view, read(bounded, answer, view))
      deepStrictEqual(view.run, oracleRun(run))
    }
    expect(view!.run.done).toBe(true)
  })

  it('resets the least recently read cursor and keeps a quiet delta for a retained one', () => {
    const runtime = boundedRuntime()
    const revisions = createTraceRevisions()
    const oneItem = (runId: string): ActiveRun => ({
      runId, userText: 'lru', done: false,
      items: [{ id: `${runId}:0`, ts: new Date(BASE_TS).toISOString(), runId, kind: 'model', stage: 'text', text: 'a' }]
    })
    const readOnce = (store: ReturnType<typeof createTraceRevisions>, runId: string, after?: DesktopTraceCursor): TraceDeltaAnswer => {
      const bounded = runtime.boundedLiveRun(oneItem(runId))
      return store.observe(runId, bounded.items, after)
    }

    const cursors = new Map<string, DesktopTraceCursor>()
    for (let index = 0; index < 16; index++) {
      const runId = `run-lru-${index}`
      const answer = readOnce(revisions, runId)
      // A first read has no base, so a snapshot here says nothing about eviction.
      expect(answer.reset).toBe(true)
      cursors.set(runId, { revision: answer.revision, count: 1 })
    }
    // Sixteen runs through one store: the eight most recently read survive.
    expect(revisions.size()).toBe(8)

    // Nothing has read run-lru-0 since its own read, so it really is the oldest of the
    // sixteen: the most recently read run answers a quiet delta, that cursor must reset.
    const quiet = readOnce(revisions, 'run-lru-15', cursors.get('run-lru-15'))
    expect(quiet).toMatchObject({ reset: false, changes: [] })
    const evicted = readOnce(revisions, 'run-lru-0', cursors.get('run-lru-0'))
    expect(evicted.reset).toBe(true)

    // Control: four runs stay under the capacity, so the oldest cursor still continues.
    const small = createTraceRevisions()
    const smallCursors: DesktopTraceCursor[] = []
    for (let index = 0; index < 4; index++) {
      const answer = readOnce(small, `run-small-${index}`)
      expect(answer.reset).toBe(true)
      smallCursors.push({ revision: answer.revision, count: 1 })
    }
    expect(small.size()).toBe(4)
    expect(readOnce(small, 'run-small-0', smallCursors[0]).reset).toBe(false)
  })

  // Ten thousand items observed as whole snapshot generations: each observation is a new
  // generation supplied by this fixture, not a stream of per-event mutation notices. Every
  // generation changes all bounded items, so the store books exactly 10000 tracked changes
  // per generation.
  it('keeps a history at exactly 50000 tracked changes and releases only the oldest beyond it', () => {
    const runtime = boundedRuntime()
    const revisions = createTraceRevisions()
    const runId = 'run-budget'
    const run: ActiveRun = {
      runId, userText: 'budget', done: false,
      items: Array.from({ length: 10_000 }, (_, index) => ({
        id: `${runId}:${index}`, ts: new Date(BASE_TS + index).toISOString(), runId,
        kind: 'model' as const, stage: 'text_delta', text: 'x'
      }))
    }
    // A new generation is a new snapshot input: a fresh array of fresh events, never an
    // unannounced in-place rewrite of objects an earlier read already delivered.
    const stamp = (generation: number): void => {
      run.items = run.items.map((item, index) => ({ ...item, ts: new Date(BASE_TS + generation * 1_000_000 + index).toISOString() }))
    }
    const observe = (after?: DesktopTraceCursor): TraceDeltaAnswer => revisions.observe(runId, runtime.boundedLiveRun(run).items, after)

    const first = observe()
    expect(first.reset).toBe(true)
    const oldest: DesktopTraceCursor = { revision: first.revision, count: run.items.length }
    let second: DesktopTraceCursor | null = null
    for (let generation = 1; generation <= 4; generation++) {
      stamp(generation)
      const answer = observe()
      // No cursor passed: these are full snapshot generations.
      expect(answer.reset).toBe(true)
      if (generation === 1) second = { revision: answer.revision, count: run.items.length }
    }

    // One initial generation plus four rewrites = exactly 50000 tracked changes, the
    // retained limit, so the original cursor still continues.
    const continued = observe(oldest)
    expect(continued.reset).toBe(false)
    expect(continued.reset === false ? continued.changes.length : -1).toBe(10_000)

    // One further full rewrite crosses the limit and releases the oldest revision.
    stamp(5)
    expect(observe(oldest).reset).toBe(true)

    // Only that one revision is gone: the next-oldest cursor still continues. Six
    // observations in total cannot reach the 32-revision bound, so the release above is the
    // tracked-changes bound and nothing else.
    if (!second) throw new Error('the second generation cursor was not captured')
    expect(observe(second).reset).toBe(false)
  })

  // Regression for delivery isolation, and the test that was red before read() round-tripped
  // its envelope: sanitizeToolEvents reuses raw references for model events
  // (tool-content.ts:117) and appendCoalescedTrace mutates previous.text in place
  // (live-trace.ts:55), so handing those objects to mergeRemoteTrace let a later local
  // coalesce grow a view that was already delivered.
  it('keeps a delivered view unchanged when the live run is coalesced in place afterwards', () => {
    const runtime = boundedRuntime()
    const revisions = createTraceRevisions()
    const run = createWorkloadRun({ runId: 'run-isolation', k: 24 })
    const view = deliver(runtime, revisions, run, 24)
    const delivered = projection(view.run)
    const rawTail = run.items.at(-1)?.text
    // Only the raw run moves here; nothing is delivered again.
    applyWorkloadStep(run, 'coalesce', 24)
    // Anti-vacuity: the raw tail really grew, so the comparison below is not trivially true.
    expect(run.items.at(-1)?.text).not.toBe(rawTail)
    expect(projection(view.run)).toEqual(delivered)
  })

  // Negative control for the delta content: with the coalesce indices dropped, the projection
  // must stay short of an independent complete oracle. Before delivery was isolated this also
  // failed, because the aliased tail arrived already mutated and hid the missing changes.
  it('falls short of the oracle when the coalesce changes are dropped', () => {
    const runtime = boundedRuntime()
    const revisions = createTraceRevisions()
    const run = createWorkloadRun({ runId: 'run-dropped', k: 24 })
    const view = deliver(runtime, revisions, run, 24)
    const deliveredTail = view.run.items.at(-1)?.text
    applyWorkloadStep(run, 'coalesce', 24)
    const bounded = runtime.boundedLiveRun(run)
    const answer = revisions.observe(run.runId, bounded.items, view.cursor)
    const delta = read(bounded, answer, view)
    if (delta.kind !== 'delta') throw new Error('the coalesce step must stay a delta')
    const merged = follow(view, { ...delta, changes: [] })
    // The dropped read keeps the delivered text: this control is about the missing change,
    // not about unrelated drift between the view and the run.
    expect(merged.run.items.at(-1)?.text).toBe(deliveredTail)
    expect(() => deepStrictEqual(projection(merged.run), oracleRun(run))).toThrow(AssertionError)
  })
})
