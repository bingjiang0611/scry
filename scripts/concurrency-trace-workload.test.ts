import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../src/shared/trace'
import { sanitizeToolEvents } from '../src/core/turn-recorder/tool-content'
import { applyWorkloadStep, createWorkloadRun, WORKLOAD_STEPS, type WorkloadStep } from './fixtures/concurrency-trace-workload'

// Mirrors the live policy in src/main/bootstrap/trace-runtime.ts:119-123 (8 KiB field,
// 128 KiB turn). Kept as a literal on purpose: the workload must be checked against
// the real budget, not against whatever the fixture happens to declare.
const LIVE_POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }

const STREAM_MESSAGE = 'msg:run-a:stream'
const TAIL_MESSAGE = 'msg:run-a:tail'

function drive(run: ActiveRun, k: number, through?: WorkloadStep): void {
  for (const step of WORKLOAD_STEPS) {
    if (through !== undefined && step === through) return
    applyWorkloadStep(run, step, k)
  }
}

const ids = (items: readonly TraceEvent[]): string[] => items.map((item) => item.id)
const streamPositions = (run: ActiveRun): number[] =>
  run.items.map((item, index) => (item.messageId === STREAM_MESSAGE ? index : -1)).filter((index) => index >= 0)
const shapes = (run: ActiveRun): unknown[] => run.items.map((item) => ({
  kind: item.kind,
  stage: item.stage,
  text: item.text?.length ?? null,
  output: typeof item.output === 'string' ? item.output.length : null,
  input: item.input === undefined ? null : JSON.stringify(item.input)
}))
const bodyBytes = (item: TraceEvent): number => Buffer.byteLength(String(item.output ?? ''))
// Per-step item counts: seed, quiet, replace-stream, append, coalesce, backfill, done.
const COUNTS = (k: number): number[] => [k, k, k - 2, k, k, k, k]

describe('deterministic concurrency trace workload', () => {
  it('declares the fixed step order', () => {
    expect([...WORKLOAD_STEPS]).toEqual(['seed', 'quiet', 'replace-stream', 'append', 'coalesce', 'backfill', 'done'])
  })

  it('seeds exactly k items with deterministic ids, stages and byte-exact tool bodies', () => {
    const run = createWorkloadRun({ runId: 'run-a', k: 40 })
    applyWorkloadStep(run, 'seed', 40)

    expect(run.items).toHaveLength(40)
    expect(ids(run.items)).toEqual(Array.from({ length: 40 }, (_, index) => `wt:run-a:${index}`))
    expect(run.items[0]).toMatchObject({ kind: 'model', stage: 'text_delta', messageId: 'msg:run-a:0' })
    expect(run.items[1]).toMatchObject({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'bash:run-a:0' })
    expect(run.items[1].input).toEqual({ command: 'rg -n "symbol0" src' })
    // The early result is the backfill target and must already exist in the seed.
    expect(run.items[2]).toMatchObject({ kind: 'tool', stage: 'tool_result', toolUseId: 'bash:run-a:0' })
    expect(bodyBytes(run.items[2])).toBe(1024)
    expect(run.items[4]).toMatchObject({ kind: 'tool', stage: 'tool_result', tool: 'Read' })
    expect(bodyBytes(run.items[4])).toBe(1024)
    expect(run.items[5]).toMatchObject({ kind: 'harness', stage: 'note' })
    // Seed keeps the three separated stream deltas and never coalesces them.
    expect(streamPositions(run)).toEqual([3, 8, 13])
    expect(streamPositions(run).map((index) => run.items[index].text)).toEqual(['stream part 0: ', 'stream part 1: ', 'stream part 2: '])
  })

  // The real command scale. Only counts and the final shape are asserted here: the
  // byte-level assertions above stay at small k because stringifying 50k items would
  // dominate the run without proving anything more than the counts already do.
  it.each([1000, 10000, 50000])('keeps the documented counts through every step at k=%i', (k) => {
    const run = createWorkloadRun({ runId: `run-${k}`, k })
    WORKLOAD_STEPS.forEach((step, index) => {
      applyWorkloadStep(run, step, k)
      expect(run.items, `item count after ${step}`).toHaveLength(COUNTS(k)[index])
      expect(run.done, `done after ${step}`).toBe(step === 'done')
    })
    expect(run.items[2].id).toBe(`wt:run-${k}:2`)
    const tail = run.items[run.items.length - 1]
    expect(tail).toMatchObject({ id: `wt:run-${k}:append-1`, messageId: `msg:run-${k}:tail` })
    expect(tail.text).toBe('Tail delta starts here and the tail coalesces')
  })

  it('rejects k below the documented minimum', () => {
    expect(() => createWorkloadRun({ runId: 'run-a', k: 11 })).toThrow('k >= 12')
    expect(() => createWorkloadRun({ runId: 'run-a', k: 12.5 })).toThrow('k >= 12')
  })

  it('quiet mutates nothing', () => {
    const run = createWorkloadRun({ runId: 'run-a', k: 40 })
    applyWorkloadStep(run, 'seed', 40)
    const before = JSON.stringify(run.items)
    applyWorkloadStep(run, 'quiet', 40)
    expect(JSON.stringify(run.items)).toBe(before)
  })

  it('replace-stream splices three separated deltas into one without reordering unrelated items', () => {
    const run = createWorkloadRun({ runId: 'run-a', k: 40 })
    applyWorkloadStep(run, 'seed', 40)
    const unrelatedBefore = ids(run.items.filter((item) => item.messageId !== STREAM_MESSAGE))
    expect(streamPositions(run)).toEqual([3, 8, 13])

    applyWorkloadStep(run, 'replace-stream', 40)

    expect(run.items).toHaveLength(38)
    expect(run.items[3]).toMatchObject({ id: 'wt:run-a:stream-final', kind: 'model', stage: 'text', messageId: STREAM_MESSAGE, runtimeMetadata: { replacesStreamedText: true } })
    expect(run.items[3].text).toBe('Streamed reasoning kept once, after three separated deltas.')
    expect(run.items.filter((item) => item.messageId === STREAM_MESSAGE)).toHaveLength(1)
    expect(run.items.some((item) => item.stage === 'text_delta' && item.messageId === STREAM_MESSAGE)).toBe(false)
    expect(ids(run.items.filter((item) => item.messageId !== STREAM_MESSAGE))).toEqual(unrelatedBefore)
  })

  it('append returns the count to k and coalesce merges the tail in place', () => {
    const run = createWorkloadRun({ runId: 'run-a', k: 40 })
    applyWorkloadStep(run, 'seed', 40)
    applyWorkloadStep(run, 'replace-stream', 40)
    expect(run.items).toHaveLength(38)

    applyWorkloadStep(run, 'append', 40)
    expect(run.items).toHaveLength(40)
    expect(run.items[38]).toMatchObject({ id: 'wt:run-a:append-0', kind: 'tool', stage: 'tool:Edit', tool: 'Edit' })
    expect(run.items[39]).toMatchObject({ id: 'wt:run-a:append-1', kind: 'model', stage: 'text_delta', messageId: TAIL_MESSAGE })
    const tail = run.items[39]
    const tailText = tail.text

    applyWorkloadStep(run, 'coalesce', 40)
    expect(run.items).toHaveLength(40)
    expect(run.items[39]).toBe(tail)
    expect(run.items[39].text).toBe(`${tailText} and the tail coalesces`)
    expect(run.items[39].id).toBe('wt:run-a:append-1')
  })

  it('backfill replaces one early result by id and done only flips metadata', () => {
    const run = createWorkloadRun({ runId: 'run-a', k: 40 })
    drive(run, 40, 'backfill')
    const neighbours = ids(run.items.filter((_item, index) => index !== 2))

    applyWorkloadStep(run, 'backfill', 40)
    expect(run.items).toHaveLength(40)
    expect(run.items[2].id).toBe('wt:run-a:2')
    expect(bodyBytes(run.items[2])).toBe(8192)
    expect(ids(run.items.filter((_item, index) => index !== 2))).toEqual(neighbours)

    const before = JSON.stringify(run.items)
    expect(run.done).toBe(false)
    applyWorkloadStep(run, 'done', 40)
    expect(run.done).toBe(true)
    expect(JSON.stringify(run.items)).toBe(before)
    expect(run.userText).toBe('Deterministic concurrency trace workload')
  })

  it('two runs replay identical work without sharing mutable objects', () => {
    const first = createWorkloadRun({ runId: 'run-a', k: 40 })
    const second = createWorkloadRun({ runId: 'run-b', k: 40 })
    drive(first, 40)
    drive(second, 40)

    expect(shapes(first)).toEqual(shapes(second))
    // Ids stay run-scoped even though the work is identical.
    expect(first.items[0].id).toBe('wt:run-a:0')
    expect(second.items[0].id).toBe('wt:run-b:0')
    expect(first.items[1]).not.toBe(second.items[1])
    expect(first.items[1].input).not.toBe(second.items[1].input)
    ;(first.items[1].input as { command: string }).command = 'mutated'
    expect((second.items[1].input as { command: string }).command).toBe('rg -n "symbol0" src')
    expect(first.done).toBe(true)
    expect(second.done).toBe(true)
  })

  // The real budget is crossed here with the production 8 KiB/128 KiB limits; k is
  // reduced from 1000 only to keep the unit cheap, and the projected bodies come from
  // the real sanitizeToolEvents, not from a reimplementation.
  it('backfill changes the visible projection of untouched suffix items under the real turn budget', () => {
    const run = createWorkloadRun({ runId: 'run-budget', k: 512 })
    drive(run, 512, 'backfill')
    const rawBefore = run.items.map((item) => JSON.stringify(item))
    const before = sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')
    expect(before[2].outputContent?.storage).toBe('complete')

    applyWorkloadStep(run, 'backfill', 512)
    const after = sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')

    expect(after).toHaveLength(before.length)
    expect(after[2].outputContent).toMatchObject({ savedBytes: 8192, storage: 'complete' })
    const flipped = run.items.map((_item, index) => index).filter((index) => {
      if (JSON.stringify(run.items[index]) !== rawBefore[index]) return false
      return before[index].outputContent?.storage === 'complete' && after[index].outputContent?.storage !== 'complete'
    })
    expect(flipped.length).toBeGreaterThan(0)
    expect(flipped.every((index) => index > 2)).toBe(true)
    // Tool bodies, not only tiny tool inputs, must lose visible bytes.
    expect(flipped.some((index) => run.items[index].output !== undefined)).toBe(true)
    // The turn budget stays saturated, so the early gain reappears as suffix loss.
    const saved = (item: TraceEvent): number => (item.outputContent?.savedBytes ?? 0) + (item.inputContent?.savedBytes ?? 0)
    const lost = flipped.reduce((total, index) => total + saved(before[index]) - saved(after[index]), 0)
    expect(lost).toBeGreaterThan(0)
  })

  // Sensitivity control: the same detector above must report nothing when the backfill
  // does not run, so the flipped suffix is caused by the growth and not by the check.
  it('reports no flipped suffix item when the backfill is skipped', () => {
    const run = createWorkloadRun({ runId: 'run-budget', k: 512 })
    drive(run, 512, 'backfill')
    const before = sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')
    applyWorkloadStep(run, 'done', 512)
    const after = sanitizeToolEvents(run.items, LIVE_POLICY, 'live_renderer')

    const flipped = run.items.map((_item, index) => index).filter((index) =>
      before[index].outputContent?.storage === 'complete' && after[index].outputContent?.storage !== 'complete')
    expect(flipped).toEqual([])
    expect(after.map((item) => item.outputContent?.storage ?? null)).toEqual(before.map((item) => item.outputContent?.storage ?? null))
  })
})
