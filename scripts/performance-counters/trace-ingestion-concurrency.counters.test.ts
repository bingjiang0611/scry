import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../src/shared/trace'
import { LiveTraceIngestion } from '../../src/main/live-trace-ingestion'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const eventCount = 8
const workload = `tool-events=${eventCount};blocked-persistence=1;ordered-enrichment=1`
const source = 'production LiveTraceIngestion scheduler with a fixed blocked persistence boundary'

function toolEvent(index: number): TraceEvent {
  return {
    id: `tool-${index}`,
    runId: 'run',
    ts: '',
    kind: 'tool',
    stage: 'tool_result',
    toolUseId: `call-${index}`,
    text: `body-${index}`
  }
}

describe('live trace persistence scheduling work', () => {
  it('counts the persistence rounds needed for a fixed tool-event burst', async () => {
    const runs = await repeatCounters(defaultRepeats, async () => {
      let release!: () => void
      const blocked = new Promise<void>((resolve) => { release = resolve })
      let active = 0
      let maxConcurrent = 0
      const persisted: string[] = []
      const queue = new LiveTraceIngestion({
        provider: 'pi',
        publish: () => undefined,
        persist: async (event) => {
          active++
          maxConcurrent = Math.max(maxConcurrent, active)
          await blocked
          active--
          return event
        },
        onPersisted: (event) => { persisted.push(event.id) },
        onError: (error) => { throw error }
      })
      for (let index = 0; index < eventCount; index++) {
        const event = toolEvent(index)
        queue.enqueue(event, event)
      }
      await setImmediate()
      expect(maxConcurrent).toBeGreaterThan(0)
      release()
      await queue.idle()
      expect(persisted).toEqual(Array.from({ length: eventCount }, (_, index) => `tool-${index}`))
      return { rounds: Math.ceil(eventCount / maxConcurrent) }
    })
    writeCollector('trace-ingestion-concurrency', [
      measured({
        scenario: 'persistence.trace-ingestion-burst',
        metric: 'persistence.rounds',
        layer: 'main',
        unit: 'count',
        workload,
        source
      }, runs.rounds)
    ])
  })
})
