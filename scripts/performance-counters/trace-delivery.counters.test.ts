import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../src/shared/trace'
import { TraceOutputBridge } from '../../src/main/trace-output'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

// Production trace bridge, fixed 1000 Unicode text deltas. Counts the IPC sends and
// serialized bytes a renderer receives for one complete delivery.
const workload = 'trace-events=1000;unicode=true'
const events: TraceEvent[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `event-${index}`, runId: 'run-fixed', ts: '2026-01-01T00:00:00.000Z',
  kind: 'model', stage: 'text_delta', messageId: 'message-fixed', text: 'fixed 中文 output\n'
}))

export function deliver(input: TraceEvent[]) {
  let messages = 0
  let bytes = 0
  const received: TraceEvent[] = []
  const bridge = new TraceOutputBridge({
    canSend: () => true,
    schedule: () => () => {},
    send: batch => { messages++; bytes += Buffer.byteLength(JSON.stringify(batch)); received.push(...batch.events) }
  })
  for (const event of input) bridge.push(event)
  bridge.flushAll()
  bridge.close()
  expect(received).toEqual(input)
  return { messages, bytes }
}

describe('trace delivery work counters', () => {
  it('counts IPC messages and bytes for one complete delivery', async () => {
    const runs = await repeatCounters(defaultRepeats, () => deliver(events))
    const meta = { scenario: 'trace.delivery', layer: 'ipc', workload, source: 'TraceOutputBridge send() wrapper; JSON UTF-8 bytes, not structured-clone wire bytes' }
    writeCollector('trace-delivery', [
      measured({ ...meta, metric: 'ipc.messages', unit: 'count' }, runs.messages),
      measured({ ...meta, metric: 'ipc.bytes', unit: 'bytes' }, runs.bytes)
    ])
  })

  it('is sensitive to duplicated delivery work', () => {
    const single = deliver(events)
    const doubled = deliver([...events, ...events.map(event => ({ ...event, id: `${event.id}-dup` }))])
    expect(doubled.messages).toBeGreaterThan(single.messages)
    expect(doubled.bytes).toBeGreaterThan(single.bytes)
  })
})
