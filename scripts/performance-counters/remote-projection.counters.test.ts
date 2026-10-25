import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../../src/shared/trace'
import { mergeRemoteTrace, type RemoteTraceView } from '../../src/renderer/remote-trace'
import { TurnStreamProjectionCache } from '../../src/renderer/turn-stream-projection'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const structuralCount = 5_000
const updates = 20
const workload = 'structural-items=5000;live-tail=1;updates=20;indexed-delta=true'
const meta: Omit<ActiveRun, 'items'> = { runId: 'remote-projection', userText: 'fixture', done: false }
const text = (value: string): TraceEvent => ({
  id: 'tail', runId: meta.runId, ts: '', kind: 'model', stage: 'text_delta', text: value
})

// Accessors count real array reads and return the original event. They are used
// ONLY for L1. L2 runs first on plain arrays, without this instrumentation.
function exercise(instrumented: boolean, extraRead = false) {
  const structural: TraceEvent[] = Array.from({ length: structuralCount }, (_, index) => ({
    id: `tool-${index}`, runId: meta.runId, ts: '', kind: 'tool', stage: 'tool_start', toolUseId: `tool-${index}`, toolName: 'Read'
  }))
  const initial = { ...meta, items: [...structural, text('answer 0')] }
  let view: RemoteTraceView = { run: initial, cursor: { revision: 'e:0', count: initial.items.length } }
  const cache = new TurnStreamProjectionCache()
  const first = cache.project(view.run.items)
  let projection = first
  const counts = { merge: 0, projection: 0 }
  let phase: keyof typeof counts | undefined
  const instrument = (items: TraceEvent[]): void => {
    for (let index = 0; index < structuralCount; index++) {
      const value = items[index]
      Object.defineProperty(items, index, { configurable: true, get: () => {
        if (phase) counts[phase]++
        return value
      } })
    }
  }
  if (instrumented) instrument(view.run.items)
  const started = performance.now()
  for (let update = 1; update <= updates; update++) {
    phase = 'merge'
    const merged = mergeRemoteTrace(view, {
      kind: 'delta', run: meta, base: view.cursor!.revision,
      cursor: { revision: `e:${update}`, count: structuralCount + 1 },
      changes: [{ index: structuralCount, item: text(`answer ${update}`) }]
    })
    phase = undefined
    if (merged.kind !== 'applied' || !merged.view || !merged.changed) throw new Error('Expected a changed, complete remote view')
    view = merged.view
    if (instrumented) instrument(view.run.items)
    phase = 'projection'
    projection = cache.project(view.run.items)
    phase = undefined
  }
  const durationMs = performance.now() - started
  if (extraRead) {
    phase = 'projection'
    Reflect.get(view.run.items, 0)
    phase = undefined
  }
  expect(projection.structuralItems).toBe(first.structuralItems)
  expect(projection.liveText).toBe(`answer ${updates}`)
  expect(view.run.items.slice(0, structuralCount)).toEqual(structural)
  expect(view.cursor).toEqual({ revision: `e:${updates}`, count: structuralCount + 1 })
  expect(initial.items.at(-1)?.text).toBe('answer 0')
  return {
    counters: { 'projection.prefix.reads': counts.projection, 'merge.prefix.reads': counts.merge },
    durationMs
  }
}

describe('remote text-tail projection work counters', () => {
  it('measures real delta merge + projection while retaining every structural event', async () => {
    const timingFile = process.env.SCRY_REMOTE_PROJECTION_TIMINGS
    if (timingFile) {
      const durationMs = Array.from({ length: defaultRepeats }, () => exercise(false).durationMs)
      writeFileSync(timingFile, `${JSON.stringify({ workload, scope: '20 mergeRemoteTrace + project calls on plain arrays; initial projection excluded', durationMs }, null, 2)}\n`)
    }
    const runs = await repeatCounters(defaultRepeats, () => exercise(true).counters)
    const control = exercise(true, true).counters
    expect(control['projection.prefix.reads']).toBe(runs['projection.prefix.reads'][0] + 1)
    expect(control['merge.prefix.reads']).toBe(runs['merge.prefix.reads'][0])
    writeCollector('remote-projection', Object.entries(runs).map(([metric, values]) => measured({
      scenario: 'renderer.remote-tail', metric, layer: 'ui', unit: 'count', workload,
      source: 'production delta merge + stream projection; pass-through structural array accessors'
    }, values)))
  })
})
