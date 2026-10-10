import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunRegistry } from './run-registry'
import { LlmPerformanceSampling } from './llm-performance-sampling'
import type { ActiveRun } from '../shared/trace'

afterEach(() => vi.useRealTimers())
describe('instance performance sampling clock', () => {
  it('samples without IPC or a view, bounds time coverage, and stops when idle', () => {
    vi.useFakeTimers()
    const registry = new RunRegistry<ActiveRun, { runId: string }>()
    const run: ActiveRun = { runId: 'a', items: [], userText: '', done: false }
    registry.register(run, { runId: 'a' })
    const sampling = new LlmPerformanceSampling(() => registry.activeStates())
    sampling.registryChanged()
    vi.advanceTimersByTime(40_000)
    expect(sampling.read().trend).toHaveLength(30)
    expect(sampling.read().trend[0].ts).toBeGreaterThan(Date.now() - 30_000)
    const previous = sampling.read()
    for (let index = 0; index < 100; index++) expect(sampling.read()).toBe(previous)
    run.done = true
    sampling.registryChanged()
    expect(sampling.read()).toMatchObject({ running: 0, trend: [] })
    expect(vi.getTimerCount()).toBe(0)
  })
})
