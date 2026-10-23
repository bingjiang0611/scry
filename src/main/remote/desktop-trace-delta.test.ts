import { describe, expect, it } from 'vitest'
import { createTraceRevisions } from './desktop-trace-delta'
import { appendCoalescedTrace } from '../live-trace'
import { mergeRemoteTrace, type RemoteTraceView } from '../../renderer/remote-trace'
import type { DesktopRemoteTraceRead } from '../../shared/desktop-remote'
import type { ActiveRun, TraceEvent } from '../../shared/trace'

const RUN = 'run-delta-1'
let seq = 0
const event = (fields: Partial<TraceEvent>): TraceEvent => ({ id: `ev-${++seq}`, ts: '2026-10-23T00:00:00.000Z', runId: RUN, kind: 'model', stage: 'text', ...fields } as TraceEvent)
const meta = { runId: RUN, userText: 'prompt', done: false }

// Simulates what the host reader does with an answer: reset → full snapshot,
// otherwise only the listed indices travel.
function respond(revisions: ReturnType<typeof createTraceRevisions>, items: TraceEvent[], view: RemoteTraceView | null): DesktopRemoteTraceRead {
  const snapshot = JSON.parse(JSON.stringify(items)) as TraceEvent[]
  const answer = revisions.observe(RUN, snapshot, view?.cursor)
  if (answer.reset) return { kind: 'snapshot', run: { ...meta, items: snapshot }, cursor: { revision: answer.revision, count: snapshot.length } }
  return { kind: 'delta', run: meta, base: view!.cursor!.revision, cursor: { revision: answer.revision, count: answer.count }, changes: answer.changes.map((index) => ({ index, item: snapshot[index] })) }
}

function follow(view: RemoteTraceView | null, read: DesktopRemoteTraceRead): RemoteTraceView | null {
  const merged = mergeRemoteTrace(view, read)
  if (merged.kind === 'gap') throw new Error('unexpected gap')
  return merged.view
}

describe('desktop trace revisions', () => {
  it('reproduces the host list through appends, in-place edits, streamed-text replacement and shrink', () => {
    // Deterministic LCG so a failure is reproducible.
    let state = 7
    const random = (limit: number): number => { state = (state * 1103515245 + 12345) % 2147483648; return state % limit }
    const revisions = createTraceRevisions()
    const host: TraceEvent[] = []
    let view: RemoteTraceView | null = null
    let deltas = 0
    for (let poll = 0; poll < 400; poll++) {
      for (let step = random(6); step > 0; step--) {
        const action = random(10)
        if (action < 4) appendCoalescedTrace(host, event({ stage: 'text_delta', messageId: `m-${random(3)}`, text: `t${poll}` }))
        else if (action < 6) appendCoalescedTrace(host, event({ kind: 'tool', stage: 'tool:Bash', toolUseId: `tool-${poll}` }))
        else if (action < 7 && host.length > 0) { const index = random(host.length); host[index] = { ...host[index], durationMs: poll } }
        else if (action < 8 && host.length > 0) host[random(host.length)].stage = 'result_superseded'
        else if (action < 9) appendCoalescedTrace(host, event({ stage: 'text', messageId: `m-${random(3)}`, text: `final ${poll}`, runtimeMetadata: { replacesStreamedText: true } }))
        else if (host.length > 2) host.splice(random(host.length), 1)
      }
      const read = respond(revisions, host, view)
      if (read.kind === 'delta') deltas++
      view = follow(view, read)
      expect(view?.run.items).toEqual(host)
    }
    expect(deltas).toBeGreaterThan(390)
  })

  it('keeps unchanged reads at the same revision and object identity', () => {
    const revisions = createTraceRevisions()
    const host = [event({ text: 'a' }), event({ text: 'b' })]
    const first = follow(null, respond(revisions, host, null))!
    const quiet = mergeRemoteTrace(first, respond(revisions, host, first))
    expect(quiet).toEqual({ kind: 'applied', view: first, changed: false })
    if (quiet.kind !== 'applied') throw new Error('unreachable')
    expect(quiet.view).toBe(first)
    host.push(event({ text: 'c' }))
    const grown = follow(first, respond(revisions, host, first))!
    expect(grown.run.items[0]).toBe(first.run.items[0])
    expect(grown.run.items).toHaveLength(3)
  })

  it('answers a reset for unknown, evicted or inconsistent cursors', () => {
    const revisions = createTraceRevisions()
    const items = [event({ text: 'a' })]
    const first = revisions.observe(RUN, items)
    expect(first.reset).toBe(true)
    expect(revisions.observe(RUN, items, { revision: first.revision, count: 1 })).toMatchObject({ reset: false, changes: [] })
    expect(revisions.observe(RUN, items, { revision: first.revision, count: 2 }).reset).toBe(true)
    expect(revisions.observe(RUN, items, { revision: 'other-epoch:1', count: 1 }).reset).toBe(true)
    // Thirty-three later revisions push the first one out of the bounded history.
    for (let index = 0; index < 33; index++) { items.push(event({ text: String(index) })); revisions.observe(RUN, items) }
    expect(revisions.observe(RUN, items, { revision: first.revision, count: 1 }).reset).toBe(true)
    // Forgetting a finished run starts a new epoch.
    const before = revisions.observe(RUN, items)
    revisions.forget(RUN)
    expect(revisions.observe(RUN, items, { revision: before.revision, count: items.length }).reset).toBe(true)
  })

  it('bounds tracked runs and releases runs nobody reads', () => {
    const revisions = createTraceRevisions()
    for (let index = 0; index < 20; index++) revisions.observe(`run-${index}`, [event({})], undefined, 1_000 + index)
    expect(revisions.size()).toBe(8)
    revisions.sweep(1_000 + 60_015, 60_000)
    expect(revisions.size()).toBe(4)
    revisions.sweep(1_000 + 60_020, 60_000)
    expect(revisions.size()).toBe(0)
  })
})

describe('remote trace merge', () => {
  const run = (items: TraceEvent[], extra: Partial<ActiveRun> = {}): ActiveRun => ({ ...meta, items, ...extra })
  const a = event({ text: 'a' })
  const b = event({ text: 'b' })
  const base: RemoteTraceView = { run: run([a], { attachments: [] }), cursor: { revision: 'e:1', count: 1 } }

  it('treats a base mismatch, a different run, a missing appended index or a stale count as a gap', () => {
    expect(mergeRemoteTrace(base, { kind: 'delta', run: meta, base: 'e:0', cursor: { revision: 'e:2', count: 2 }, changes: [{ index: 1, item: b }] })).toEqual({ kind: 'gap' })
    expect(mergeRemoteTrace(base, { kind: 'delta', run: { ...meta, runId: 'run-other' }, base: 'e:1', cursor: { revision: 'e:2', count: 2 }, changes: [{ index: 1, item: b }] })).toEqual({ kind: 'gap' })
    expect(mergeRemoteTrace(base, { kind: 'delta', run: meta, base: 'e:1', cursor: { revision: 'e:2', count: 3 }, changes: [{ index: 1, item: b }] })).toEqual({ kind: 'gap' })
    expect(mergeRemoteTrace({ ...base, cursor: { revision: 'e:1', count: 2 } }, { kind: 'delta', run: meta, base: 'e:1', cursor: { revision: 'e:2', count: 2 }, changes: [{ index: 1, item: b }] })).toEqual({ kind: 'gap' })
    expect(mergeRemoteTrace({ run: base.run }, { kind: 'delta', run: meta, base: 'e:1', cursor: { revision: 'e:2', count: 2 }, changes: [{ index: 1, item: b }] })).toEqual({ kind: 'gap' })
    expect(mergeRemoteTrace(null, { kind: 'delta', run: meta, base: 'e:1', cursor: { revision: 'e:2', count: 1 }, changes: [] })).toEqual({ kind: 'gap' })
  })

  it('keeps shown attachments when the image count is unchanged and reports status-only changes', () => {
    const image = { kind: 'image', name: 'a.png', mimeType: 'image/png', dataBase64: 'aQ==' } as NonNullable<ActiveRun['attachments']>[number]
    const shown: RemoteTraceView = { run: run([a], { attachments: [image] }), cursor: { revision: 'e:1', count: 1 } }
    const snapshot = mergeRemoteTrace(shown, { kind: 'snapshot', run: run([a, b]) })
    expect(snapshot).toMatchObject({ kind: 'applied', changed: true, view: { run: { attachments: [image], items: [a, b] } } })
    expect(snapshot.kind === 'applied' && snapshot.view?.cursor).toBeUndefined()
    const done = mergeRemoteTrace(shown, { kind: 'delta', run: { ...meta, done: true }, base: 'e:1', cursor: { revision: 'e:1', count: 1 }, changes: [] })
    expect(done).toMatchObject({ kind: 'applied', changed: true, view: { run: { done: true, attachments: [image] } } })
    if (done.kind !== 'applied') throw new Error('unreachable')
    expect(done.view?.run.items).toBe(shown.run.items)
    expect(mergeRemoteTrace(base, { kind: 'delta', run: { ...meta, attachments: [] }, base: 'e:1', cursor: { revision: 'e:1', count: 1 }, changes: [] }))
      .toEqual({ kind: 'applied', view: base, changed: false })
  })
})
