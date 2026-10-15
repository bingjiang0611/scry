import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../src/shared/trace'
import { TraceOutputBridge } from '../src/main/trace-output'
import { TerminalOutputBridge } from '../src/main/terminal-output'
import { sessionHistoryPage } from '../src/main/session-history'
import { applyTraceBatch, type Turn } from '../src/renderer/format'

// Fixed offline workloads, actual production implementations. No Provider, HOME, DB or user files.
// CI copies this SAME harness into both checkouts, so a PR cannot win by shrinking its fixture.
const timestamp = '2026-01-01T00:00:00.000Z'
const events: TraceEvent[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `event-${index}`, runId: 'run-fixed', ts: timestamp,
  kind: 'model', stage: 'text_delta', messageId: 'message-fixed', text: 'fixed 中文 output\n'
}))
const history = Array.from({ length: 4_000 }, (_, index) => ({
  runId: `turn-${index}`, userText: `fixed request ${index}`, done: true,
  ts: index, items: [{ ...events[0], id: `answer-${index}`, runId: `turn-${index}`, stage: 'text' }]
}))
const terminalChunks = Array.from({ length: 1_000 }, () => 'fixed terminal 中文 output\n')
const activeTurn: Turn = { runId: 'run-fixed', userText: 'fixed request', done: false, items: [] }

export function deliverTrace(input: TraceEvent[]): Record<string, number> {
  let bytes = 0
  let messages = 0
  let delivered = 0
  const received: TraceEvent[] = []
  const bridge = new TraceOutputBridge({
    canSend: () => true,
    schedule: () => () => {},
    send: batch => {
      // Count the real envelope rather than its precomputed event-byte estimate.
      bytes += Buffer.byteLength(JSON.stringify(batch))
      messages++
      delivered += batch.events.length
      received.push(...batch.events)
    }
  })
  for (const event of input) bridge.push(event)
  bridge.flushAll()
  bridge.close()
  expect(JSON.stringify(received)).toBe(JSON.stringify(input))
  return { bytes, messages, events: delivered }
}

export function assertCompleteProjection(result: Turn[]): void {
  expect(result).toHaveLength(1)
  expect(result[0].runId).toBe(activeTurn.runId)
  expect(result[0].done).toBe(false)
  expect(result[0].items.map(item => item.text ?? '').join('')).toBe(events.map(event => event.text).join(''))
}

const scenarios: Record<string, () => Record<string, number>> = {
  'trace.delivery': () => deliverTrace(events),
  'history.page': () => {
    const page = sessionHistoryPage(history, { limit: 40 })
    expect(page.turns).toEqual(history.slice(-40))
    expect(page.totalTurns).toBe(history.length)
    expect(page.hasOlder).toBe(true)
    return { bytes: Buffer.byteLength(JSON.stringify(page)), turns: page.turns.length }
  },
  'renderer.batch': () => {
    const result = applyTraceBatch([activeTurn], events, new Set())
    assertCompleteProjection(result)
    return { bytes: Buffer.byteLength(JSON.stringify(result)), turns: result.length }
  },
  'terminal.delivery': () => {
    let bytes = 0
    let messages = 0
    let output = ''
    const bridge = new TerminalOutputBridge({
      canSend: () => true,
      sendData: batch => {
        messages++
        bytes += Buffer.byteLength(JSON.stringify(batch))
        output += batch.map(item => item.data).join('')
      },
      sendExit: () => {}, pauseTerminal: () => {}, resumeTerminal: () => {}
    })
    const epoch = bridge.started('terminal-fixed')
    bridge.ready('terminal-fixed', epoch)
    for (const data of terminalChunks) bridge.data({ id: 'terminal-fixed', data })
    bridge.exit({ id: 'terminal-fixed', exitCode: 0 })
    bridge.close()
    expect(output).toBe(terminalChunks.join(''))
    return { bytes, messages, outputBytes: Buffer.byteLength(output) }
  }
}

export const duplicateTraceControl = (): Record<string, number> => deliverTrace([...events, ...events])

describe('fixed production-path performance harness', () => {
  it('preserves data and produces comparable work and timing measurements', () => {
    const results: Record<string, { counters: Record<string, number>; durationMs: number[] }> = {}
    for (const [name, run] of Object.entries(scenarios)) {
      for (let warmup = 0; warmup < 3; warmup++) {
        for (let iteration = 0; iteration < 20; iteration++) run()
      }
      const durationMs: number[] = []
      let counters: Record<string, number> = {}
      for (let index = 0; index < 15; index++) {
        const started = performance.now()
        let next: Record<string, number> = {}
        for (let iteration = 0; iteration < 20; iteration++) next = run()
        durationMs.push((performance.now() - started) / 20)
        if (index > 0) expect(next).toEqual(counters)
        counters = next
      }
      results[name] = { counters, durationMs }
    }
    expect(results['trace.delivery'].counters.events).toBe(events.length)
    const output = process.env.SCRY_PERFORMANCE_OUTPUT
    if (output) {
      writeFileSync(output, JSON.stringify({
        schema: 1,
        measurement: { kind: 'batch-mean-ms', warmups: 3, samples: 15, iterationsPerSample: 20 },
        harness: createHash('sha256').update(readFileSync('scripts/performance-baseline.test.ts')).update(readFileSync('vitest.config.ts')).digest('hex'),
        revision: process.env.SCRY_PERFORMANCE_REVISION ?? 'working-tree',
        environment: { node: process.versions.node, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
        results
      }, null, 2))
    }
  })

  it('negative control: real duplicate publication increases transfer work', () => {
    const normal = deliverTrace(events)
    const duplicated = duplicateTraceControl()
    expect(duplicated.events).toBe(normal.events * 2)
    expect(duplicated.bytes).toBeGreaterThan(normal.bytes * 1.9)
    expect(duplicated.messages).toBeGreaterThan(normal.messages)
    // Faster because it dropped data is never an optimization.
    expect(() => assertCompleteProjection(applyTraceBatch([activeTurn], events.slice(0, 1), new Set()))).toThrow()
  })
})
