import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../src/shared/trace'
import type { Turn } from '../../src/renderer/format'
import { AssistantTurn } from '../../src/renderer/components/ChatTurnAssistant'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const items = Array.from({ length: 217 }, (_, index): TraceEvent => ({
  id: `event-${index}`,
  runId: 'giant-completed-turn',
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'model',
  stage: 'text',
  text: `event ${index}`
}))
const turn = (events: TraceEvent[]): Turn => ({
  runId: 'giant-completed-turn',
  userText: 'fixed giant completed turn',
  done: true,
  items: events
})
const renderedFlowItems = (events: TraceEvent[]): number => {
  const html = renderToStaticMarkup(createElement(AssistantTurn, {
    turn: turn(events),
    selectedId: null,
    onSelect: () => {}
  }))
  return html.match(/class="model-text md"/g)?.length ?? 0
}
const samples: Array<{ visible: number; hidden: number }> = []

describe('giant completed turn window counter', () => {
  for (let index = 0; index < defaultRepeats; index++) it(`repeat ${index + 1}`, () => {
    const visible = renderedFlowItems(items)
    expect(visible).toBeGreaterThan(0)
    samples.push({ visible, hidden: items.length - visible })
  })

  it('is sensitive to one additional rendered event below the window threshold', () => {
    const smaller = renderedFlowItems(items.slice(0, 95))
    const larger = renderedFlowItems(items.slice(0, 96))
    expect(smaller).toBe(95)
    expect(larger).toBe(smaller + 1)
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
      workload: 'model-text-events=217;completed=true;selection=none',
      source: 'production AssistantTurn server markup; counted rendered model-text blocks'
    }
    writeCollector('renderer-turn-window', Object.entries(runs).map(([metric, values]) => measured({
      ...meta,
      metric,
      unit: 'count' as const
    }, values)))
  })
})
