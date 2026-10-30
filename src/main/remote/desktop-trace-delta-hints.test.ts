import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRemoteTraceRead, DesktopTraceCursor } from '../../shared/desktop-remote'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import { mergeRemoteTrace, type RemoteTraceView } from '../../renderer/remote-trace'
import { appendCoalescedTrace, replaceTraceById, upsertTraceById } from '../live-trace'
import { ensureFailedTerminalResult } from '../run-outcome'
import { DockBadgeState } from '../dock-badge'
import { createTraceRuntime } from '../bootstrap/trace-runtime'
import { createTraceRevisions, type TraceDeltaAnswer } from './desktop-trace-delta'

// The store may reuse a hash only where the main-process projection stamp proves the bytes cannot
// differ. These tests keep the released store — full JSON + SHA over every item, no stamp — as the
// independent oracle: both stores answer the same projected arrays, and the merged peer view must
// agree after every step. `createHash` is instrumented so a claimed reuse is counted, not inferred
// from the source; the oracle runs outside every measured window.
const hashCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      hashCalls.count += 1
      return actual.createHash(...args)
    }
  }
})

const MAX_RUNS = 8
const MAX_REVISIONS = 32
const MAX_TRACKED_CHANGES = 50_000
const RUN = 'run-hint-1'
const hashAll = (item: TraceEvent): string => createHash('sha256').update(JSON.stringify(item)).digest('base64url')

interface OracleRevision { seq: number; count: number; changed: number[] }

// Independent oracle: hashes every item on every read and publishes revisions and reset decisions
// with the released rules. Revision strings carry a different epoch, so comparisons use counts,
// change indices and merged content.
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
      while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!)
      const hashes = items.map(hashAll)
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
    forget(runId: string): void { runs.delete(runId) },
    sweep(now: number, idleMs: number): void { for (const [runId, entry] of runs) if (now - entry.touched >= idleMs) runs.delete(runId) },
    size: (): number => runs.size
  }
}

let seq = 0
const runtime = () => createTraceRuntime({
  getWindow: () => null,
  rendererCanReceive: () => false,
  activeRunSessionKey: () => null,
  dockBadge: new DockBadgeState(() => { }),
  mainEventId: (prefix, runId) => `${prefix}:${runId}:${++seq}`
})
const run = (items: TraceEvent[] = []): ActiveRun => ({ runId: RUN, providerId: 'claude', userText: 'task', items, done: false })
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const toolResult = (id: string, body: string): TraceEvent => ({
  id, ts: 'T', runId: RUN, kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: id, output: body
})
const textDelta = (id: string, text: string): TraceEvent => ({
  id, ts: 'T', runId: RUN, kind: 'model', stage: 'text_delta', text, messageId: 'm-1'
})
const terminal = (id: string): TraceEvent => ({ id, ts: 'T', runId: RUN, kind: 'harness', stage: 'result', text: 'failed' })

interface Store {
  observe: (runId: string, items: readonly TraceEvent[], after?: DesktopTraceCursor, now?: number) => TraceDeltaAnswer
  forget: (runId: string) => void
}
interface World { store: Store; oracle: Store; view: RemoteTraceView | null; oracleView: RemoteTraceView | null }
const world = (): World => ({ store: createTraceRevisions(), oracle: createFullRevisions(), view: null, oracleView: null })

// The peer payload is cloned; only the store sees the stamped array, exactly like the host reader.
function respond(store: Store, items: readonly TraceEvent[], view: RemoteTraceView | null, done: boolean): DesktopRemoteTraceRead {
  const snapshot = wire(items) as TraceEvent[]
  const meta = { runId: RUN, userText: 'task', done }
  const answer = store.observe(RUN, items, view?.cursor)
  if (answer.reset) return { kind: 'snapshot', run: { ...meta, items: snapshot }, cursor: { revision: answer.revision, count: snapshot.length } }
  return { kind: 'delta', run: meta, base: view!.cursor!.revision, cursor: { revision: answer.revision, count: answer.count }, changes: answer.changes.map((index) => ({ index, item: snapshot[index] })) }
}
function follow(view: RemoteTraceView | null, read: DesktopRemoteTraceRead): RemoteTraceView | null {
  const merged = mergeRemoteTrace(view, read)
  if (merged.kind === 'gap') throw new Error('unexpected gap')
  return merged.view
}

// One peer poll: both stores answer the same array, both views must end identical, and only the
// incremental store's `createHash` calls are counted.
function advance(target: World, items: readonly TraceEvent[], done = false): { read: DesktopRemoteTraceRead; calls: number } {
  hashCalls.count = 0
  const read = respond(target.store, items, target.view, done)
  const calls = hashCalls.count
  const oracleRead = respond(target.oracle, items, target.oracleView, done)
  target.view = follow(target.view, read)
  target.oracleView = follow(target.oracleView, oracleRead)
  expect(wire(target.view!.run.items)).toEqual(wire(target.oracleView!.run.items))
  expect(target.view!.cursor!.count).toBe(target.oracleView!.cursor!.count)
  expect(read.kind).toBe(oracleRead.kind)
  if (read.kind === 'delta' && oracleRead.kind === 'delta') expect(wire(read.changes)).toEqual(wire(oracleRead.changes))
  return { read, calls }
}
const itemsOf = (target: World): TraceEvent[] => target.view!.run.items

describe('incremental hashing against projection stamps', () => {
  it('hashes nothing on a tracked quiet read', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'hello'))
    appendCoalescedTrace(state.items, toolResult('t-1', 'ok'))
    const first = trace.boundedLiveRun(state).items
    const target = world()
    expect(advance(target, first).read.kind).toBe('snapshot')
    const quiet = advance(target, first)
    expect(quiet.calls).toBe(0)
    expect(quiet.read.kind === 'delta' && quiet.read.changes).toEqual([])
  })

  it('follows a merged tail, an append and an early rewrite with suffix hashing only', () => {
    const trace = runtime()
    const state = run()
    const target = world()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    expect(advance(target, trace.boundedLiveRun(state).items).calls).toBe(1)
    // Same messageId: the writer rewrites the tail in place, so only that item is re-projected.
    appendCoalescedTrace(state.items, textDelta('d-2', 'b'))
    const mergedTail = advance(target, trace.boundedLiveRun(state).items)
    expect(mergedTail.calls).toBe(1)
    expect(itemsOf(target)[0].text).toBe('ab')
    appendCoalescedTrace(state.items, toolResult('t-1', 'ok'))
    const appended = advance(target, trace.boundedLiveRun(state).items)
    expect(appended.calls).toBe(1)
    // Index 0 changes, so the whole 128 KiB-budgeted suffix has to be hashed again.
    replaceTraceById(state.items, { ...state.items[0], text: 'rewritten' })
    const early = advance(target, trace.boundedLiveRun(state).items)
    expect(early.calls).toBe(2)
    expect(early.read.kind === 'delta' && early.read.changes.map((change) => change.index)).toEqual([0])
  })

  it('re-projects the rest of a turn when an early body frees tool budget', () => {
    const trace = runtime()
    const state = run()
    const target = world()
    const body = (marker: string): string => `${marker}${'x'.repeat(8192 - marker.length)}`
    for (let index = 0; index < 17; index++) appendCoalescedTrace(state.items, toolResult(`t-${index}`, body(`b${index}-`)))
    const first = trace.boundedLiveRun(state).items
    advance(target, first)
    // Sixteen full 8 KiB bodies spend the 128 KiB turn budget, so the seventeenth keeps metadata only.
    expect(first[16].outputContent?.storage).toBe('omitted')
    expect(first[16].output).toBeUndefined()
    // Freeing bytes in the first body has to reach the last one: this is a suffix rebuild, not a patch.
    replaceTraceById(state.items, { ...state.items[0], output: 'tiny' })
    const second = trace.boundedLiveRun(state).items
    expect(advance(target, second).calls).toBe(17)
    expect(second[16].outputContent?.storage).toBe('truncated')
    expect(second[16].output).toBeDefined()
    expect(itemsOf(target)[16].output).toBe(second[16].output)
    // Spending the budget again takes it back.
    replaceTraceById(state.items, { ...state.items[0], output: body('b0-') })
    const third = trace.boundedLiveRun(state).items
    advance(target, third)
    expect(third[16].outputContent?.storage).toBe('omitted')
    expect(itemsOf(target)[16].output).toBeUndefined()
  })

  it('reads done metadata fresh while reusing the projection and its hashes', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    const first = trace.boundedLiveRun(state).items
    const target = world()
    advance(target, first)
    advance(target, first)
    state.done = true
    const finished = trace.boundedLiveRun(state)
    expect(finished.done).toBe(true)
    expect(finished.items).toBe(first)
    const quiet = advance(target, finished.items, true)
    expect(quiet.calls).toBe(0)
    expect(target.view!.run.done).toBe(true)
  })

  it('detects a same-length body rewrite and a real duplicate failed terminal', () => {
    const trace = runtime()
    const state = run()
    const target = world()
    appendCoalescedTrace(state.items, toolResult('t-1', 'aaaa'))
    advance(target, trace.boundedLiveRun(state).items)
    replaceTraceById(state.items, { ...state.items[0], output: 'bbbb' })
    const rewritten = advance(target, trace.boundedLiveRun(state).items)
    expect(rewritten.calls).toBe(1)
    expect(itemsOf(target)[0].output).toBe('bbbb')

    const duplicated = run()
    upsertTraceById(duplicated.items, terminal('old-result'))
    upsertTraceById(duplicated.items, { ...terminal('final-result'), tokensIn: 7 })
    const failed = world()
    advance(failed, trace.boundedLiveRun(duplicated).items)
    ensureFailedTerminalResult(duplicated.items, {
      runId: RUN, message: 'network exploded', providerId: 'codex', runtimeProvider: 'codex_cli', id: 'failure-1', ts: 'T'
    })
    const corrected = advance(failed, trace.boundedLiveRun(duplicated).items)
    expect(corrected.calls).toBeGreaterThan(0)
    expect(itemsOf(failed).filter((event) => event.kind === 'harness' && event.stage === 'result_superseded')).toHaveLength(1)
  })

  it('keeps the public revision when a recorded write changes no bytes', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    const target = world()
    advance(target, trace.boundedLiveRun(state).items)
    const before = target.view!.cursor!.revision
    // A recorded write that reproduces the same content: the projection is rebuilt, so the bytes
    // still have to be hashed once to prove they match. No public revision follows.
    replaceTraceById(state.items, { ...state.items[0] })
    const noop = advance(target, trace.boundedLiveRun(state).items)
    expect(noop.read.kind).toBe('delta')
    expect(noop.calls).toBe(1)
    expect(target.view!.cursor!.revision).toBe(before)
    // The private hint moved with the rebuilt projection, so the same projection costs nothing now.
    expect(advance(target, trace.boundedLiveRun(state).items).calls).toBe(0)
    // And the next append is still seen, not skipped.
    appendCoalescedTrace(state.items, toolResult('t-1', 'ok'))
    const appended = advance(target, trace.boundedLiveRun(state).items)
    expect(appended.read.kind === 'delta' && appended.read.changes.map((change) => change.index)).toEqual([1])
  })

  it('falls back to hashing everything when a projection was skipped between reads', () => {
    const trace = runtime()
    const state = run()
    const target = world()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    advance(target, trace.boundedLiveRun(state).items)
    appendCoalescedTrace(state.items, toolResult('t-1', 'one'))
    trace.boundedLiveRun(state) // intermediate projection the peer never saw
    appendCoalescedTrace(state.items, toolResult('t-2', 'two'))
    const skipped = advance(target, trace.boundedLiveRun(state).items)
    expect(skipped.calls).toBe(3)
    expect(skipped.read.kind === 'delta' && skipped.read.changes.map((change) => change.index)).toEqual([1, 2])
  })

  it('hashes everything when the items generation changes under the same run id', () => {
    const trace = runtime()
    const first = run()
    appendCoalescedTrace(first.items, textDelta('d-1', 'a'))
    const target = world()
    advance(target, trace.boundedLiveRun(first).items)
    const replacement = run()
    appendCoalescedTrace(replacement.items, textDelta('d-1', 'a'))
    appendCoalescedTrace(replacement.items, toolResult('r-1', 'x'))
    const next = advance(target, trace.boundedLiveRun(replacement).items)
    expect(next.calls).toBe(2)
    expect(itemsOf(target)).toHaveLength(2)
  })

  it('does not reuse hashes across two runtimes reading the same run', () => {
    const left = runtime()
    const right = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    appendCoalescedTrace(state.items, toolResult('t-1', 'ok'))
    const target = world()
    advance(target, left.boundedLiveRun(state).items)
    expect(advance(target, right.boundedLiveRun(state).items).calls).toBe(2)
    expect(advance(target, left.boundedLiveRun(state).items).calls).toBe(2)
    expect(itemsOf(target)).toHaveLength(2)
  })

  it('hashes everything when an unhinted array lands between two hinted reads', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    const projected = trace.boundedLiveRun(state).items
    const target = world()
    advance(target, projected)
    // The unhinted copy carries a body the projection never had; its hashes must not survive into
    // the hinted read that follows, or the peer would keep the copy's text.
    const clone = wire(projected) as TraceEvent[]
    clone[0].text = 'unhinted body'
    expect(advance(target, clone).calls).toBe(1)
    expect(itemsOf(target)[0].text).toBe('unhinted body')
    expect(advance(target, projected).calls).toBe(1)
    expect(itemsOf(target)[0].text).toBe('a')
  })

  it('still detects an in-place nested edit on an array no writer ever marked', () => {
    const target = world()
    const raw: TraceEvent[] = [{ ...toolResult('r-1', 'before'), runtimeMetadata: { nested: { value: 1 } } }]
    advance(target, raw)
    // Same array, same top-level fields: only a nested value moves, and no writer recorded it.
    const seeded = raw[0].runtimeMetadata as { nested: { value: number } }
    seeded.nested.value = 2
    const edited = advance(target, raw)
    expect(edited.calls).toBe(1)
    const peer = itemsOf(target)[0].runtimeMetadata as { nested: { value: number } }
    expect(peer.nested.value).toBe(2)
  })

  it('keeps the old reset boundaries for forget, run count and revision count', () => {
    const store = createTraceRevisions()
    const runs = Array.from({ length: MAX_RUNS + 1 }, (_, index) => `${RUN}-${index}`)
    for (const runId of runs) store.observe(runId, [toolResult('r-0', 'x')])
    expect(store.size()).toBe(MAX_RUNS)

    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    const target = world()
    advance(target, trace.boundedLiveRun(state).items)
    const oldestReal = target.view!.cursor!
    const oldestOracle = target.oracleView!.cursor!
    for (let round = 0; round < MAX_REVISIONS + 8; round++) {
      appendCoalescedTrace(state.items, toolResult(`t-${round}`, `body ${round}`))
      advance(target, trace.boundedLiveRun(state).items)
    }
    // Older than the kept revision window: the peer must resync rather than receive a partial delta.
    expect(target.store.observe(RUN, trace.boundedLiveRun(state).items, oldestReal).reset).toBe(true)
    expect(target.oracle.observe(RUN, trace.boundedLiveRun(state).items, oldestOracle).reset).toBe(true)
    target.store.forget(RUN)
    target.oracle.forget(RUN)
    expect(advance(target, trace.boundedLiveRun(state).items).read.kind).toBe('snapshot')
  })
})
