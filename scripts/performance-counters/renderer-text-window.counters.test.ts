import { afterAll, describe, expect, it } from 'vitest'
import { completedModelText } from '../../src/renderer/completed-turn-flow'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const input = 'x'.repeat(40_000)
const samples: Array<{ visible: number; deferred: number }> = []

describe('large completed model text counter', () => {
  for (let index = 0; index < defaultRepeats; index++) it(`repeat ${index + 1}`, () => {
    const result = completedModelText(input, { completed: true, expanded: false })
    expect(result.text.length + result.hiddenCharacters).toBe(input.length)
    samples.push({ visible: result.text.length, deferred: result.hiddenCharacters })
  })

  it('is sensitive below and above the text window threshold', () => {
    expect(completedModelText('x'.repeat(24_000), { completed: true, expanded: false }).hiddenCharacters).toBe(0)
    expect(completedModelText('x'.repeat(24_001), { completed: true, expanded: false }).hiddenCharacters).toBeGreaterThan(0)
  })

  afterAll(async () => {
    expect(samples).toHaveLength(defaultRepeats)
    const runs = await repeatCounters(defaultRepeats, async index => ({
      'rendered.text-characters': samples[index].visible,
      'deferred.text-characters': samples[index].deferred
    }))
    const meta = {
      scenario: 'renderer.large-completed-text',
      layer: 'ui' as const,
      workload: 'model-text-characters=40000;completed=true;expanded=false',
      source: 'production completedModelText projection; counted characters before Markdown rendering'
    }
    writeCollector('renderer-text-window', Object.entries(runs).map(([metric, values]) => measured({
      ...meta,
      metric,
      unit: 'count' as const
    }, values)))
  })
})
