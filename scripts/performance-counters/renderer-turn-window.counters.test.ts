import { afterAll, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../src/shared/trace'
import { completedTurnFlow } from '../../src/renderer/completed-turn-flow'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const workload = Array.from({ length: 217 }, (_, index): TraceEvent => ({
  id: `event-${index}`,
  runId: 'giant-completed-turn',
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'model',
  stage: 'text',
  text: `event ${index}`
}))
const samples: Array<{ visible: number; hidden: number }> = []

describe('giant completed turn window counter', () => {
  for (let index = 0; index < defaultRepeats; index++) it(`repeat ${index + 1}`, () => {
    const result = completedTurnFlow(workload, { completed: true, expanded: false, selectedId: null })
    expect(result.items.at(-1)?.id).toBe('event-216')
    samples.push({ visible: result.items.length, hidden: result.hiddenCount })
  })

  it('is sensitive to crossing the window threshold', () => {
    const below = completedTurnFlow(workload.slice(0, 96), { completed: true, expanded: false, selectedId: null })
    const above = completedTurnFlow(workload.slice(0, 97), { completed: true, expanded: false, selectedId: null })
    expect(below.items).toHaveLength(96)
    expect(above.items.length).toBeLessThan(below.items.length)
  })

  afterAll(async () => {
    expect(samples).toHaveLength(defaultRepeats)
    const runs = await repeatCounters(defaultRepeats, async index => ({
      'rendered.flow-items': samples[index].visible,
      'deferred.flow-items': samples[index].hidden
    }))
    const meta = {
      scenario: 'renderer.giant-completed-turn',
      layer: 'ui' as const,
      workload: 'visible-events=217;completed=true;expanded=false;selection=none',
      source: 'production completedTurnFlow window selection'
    }
    writeCollector('renderer-turn-window', Object.entries(runs).map(([metric, values]) => measured({
      ...meta,
      metric,
      unit: 'count' as const
    }, values)))
  })
})
