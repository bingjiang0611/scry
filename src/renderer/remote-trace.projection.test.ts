import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { DesktopTraceChange } from '../shared/desktop-remote'
import { mergeRemoteTrace, type RemoteTraceView } from './remote-trace'
import { TurnStreamProjectionCache } from './turn-stream-projection'

const meta: Omit<ActiveRun, 'items'> = { runId: 'remote', userText: 'fixture', done: false }
const tool = (id: string): TraceEvent => ({ id, runId: 'remote', ts: '', kind: 'tool', stage: 'tool_use', tool: 'Read', toolUseId: id })
const text = (id: string, value: string, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  id, runId: 'remote', ts: '', kind: 'model', stage: 'text_delta', messageId: 'message', text: value, ...extra
})
function initial(items: TraceEvent[]): RemoteTraceView {
  return { run: { ...meta, items }, cursor: { revision: 'e:0', count: items.length } }
}
function update(view: RemoteTraceView, changes: DesktopTraceChange[], count = view.run.items.length): RemoteTraceView {
  const merged = mergeRemoteTrace(view, { kind: 'delta', run: meta, base: view.cursor!.revision,
    cursor: { revision: `${view.cursor!.revision}:next`, count }, changes })
  if (merged.kind !== 'applied' || !merged.view) throw new Error('Expected an applied delta')
  return merged.view
}
function expectColdEquivalent(cache: TurnStreamProjectionCache, view: RemoteTraceView): void {
  expect({ ...cache.project(view.run.items), structuralRecomputed: false }).toEqual({
    ...new TurnStreamProjectionCache().project(view.run.items), structuralRecomputed: false
  })
}

describe('remote delta stream projection provenance', () => {
  it('does not rescan an unchanged structural prefix for a remote text-tail replacement', () => {
    const structural = Array.from({ length: 5_000 }, (_, index) => tool(`tool-${index}`))
    const base = initial([...structural, text('tail', 'first')])
    const cache = new TurnStreamProjectionCache()
    const first = cache.project(base.run.items)
    const next = update(base, [{ index: structural.length, item: text('tail', 'second') }])
    let prefixReads = 0
    for (let index = 0; index < structural.length; index++) {
      const value = next.run.items[index]
      Object.defineProperty(next.run.items, index, { configurable: true, get: () => { prefixReads++; return value } })
    }
    const projected = cache.project(next.run.items)
    expect(prefixReads).toBe(0)
    expect(projected.structuralItems).toBe(first.structuralItems)
    expect(projected.liveText).toBe('second')
    expect(base.run.items.at(-1)?.text).toBe('first')

    // A full snapshot has no preserved-prefix proof, even when its values look equal.
    const reset = initial([...structural, text('tail', 'reset')])
    let resetReads = 0
    const firstItem = reset.run.items[0]
    Object.defineProperty(reset.run.items, 0, { configurable: true, get: () => { resetReads++; return firstItem } })
    const merged = mergeRemoteTrace(next, { kind: 'snapshot', run: reset.run, cursor: reset.cursor })
    if (merged.kind !== 'applied' || !merged.view) throw new Error('Expected a snapshot')
    expect(cache.project(merged.view.run.items).liveText).toBe('reset')
    expect(resetReads).toBeGreaterThan(0)
  })

  it('matches cold projection for unsorted earlier corrections, append, truncation and terminal replacement', () => {
    let view = initial([tool('a'), tool('b'), text('tail', 'first')])
    const cache = new TurnStreamProjectionCache()
    cache.project(view.run.items)
    const operations: Array<{ changes: DesktopTraceChange[]; count?: number }> = [
      { changes: [{ index: 2, item: text('tail', 'second') }, { index: 0, item: { ...tool('a'), input: { path: 'corrected' } } }] },
      { changes: [{ index: 3, item: text('more', ' continuation') }], count: 4 },
      { changes: [], count: 2 },
      { changes: [{ index: 2, item: text('child', 'child response', { parentToolUseId: 'a' }) }], count: 3 },
      { changes: [{ index: 2, item: { id: 'result', runId: 'remote', ts: '', kind: 'harness', stage: 'result' } }] },
      { changes: [], count: 0 }
    ]
    for (const operation of operations) {
      view = update(view, operation.changes, operation.count)
      expectColdEquivalent(cache, view)
    }
  })

  it('falls back safely when rendering skipped an intermediate remote update', () => {
    const cache = new TurnStreamProjectionCache()
    const base = initial([tool('a'), tool('b'), text('tail', 'first')])
    cache.project(base.run.items)
    const corrected = update(base, [{ index: 0, item: { ...tool('a'), input: { path: 'changed' } } }])
    const next = update(corrected, [{ index: 2, item: text('tail', 'last') }])
    expectColdEquivalent(cache, next)
    expect(cache.project(next.run.items).structuralItems[0]).toBe(corrected.run.items[0])
  })

  it('keeps no-change identity and refuses a cursor gap without modifying prior evidence', () => {
    const base = initial([tool('a'), text('tail', 'first')])
    expect(update(base, []).run.items).toBe(base.run.items)
    expect(mergeRemoteTrace(base, { kind: 'delta', run: meta, base: 'missing', cursor: { revision: 'e:1', count: 2 },
      changes: [{ index: 1, item: text('tail', 'wrong') }] })).toEqual({ kind: 'gap' })
    expect(base.run.items.at(-1)?.text).toBe('first')
  })
})
