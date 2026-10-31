import { describe, expect, it } from 'vitest'
import { appendCoalescedTrace, replaceTraceById, upsertTraceById } from '../live-trace'
import { ensureFailedTerminalResult } from '../run-outcome'
import { DockBadgeState } from '../dock-badge'
import { sanitizeToolEvents } from '../../core/turn-recorder/tool-content'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import { createTraceRuntime } from './trace-runtime'

// These tests drive the real writers (main/live-trace.ts, run-outcome.ts) and compare the
// cached bounded projection against the previous full path (`sanitizeToolEvents` over the whole
// array), which is the oracle. Identity assertions then prove a read reused a cached prefix
// instead of re-projecting everything.
//
// A missing `markTraceMutation` call inside a writer leaves the cached prefix stale and the
// oracle comparison fails; that is the control this file is built around. Tracking is not
// assumed to be complete: only recorded writes are covered.
const POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }
const oracle = (run: ActiveRun): TraceEvent[] => sanitizeToolEvents(run.items, POLICY, 'live_renderer')
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const storage = (event: TraceEvent): string | undefined =>
  event.stage === 'tool_result' ? event.outputContent?.storage : event.inputContent?.storage

let seq = 0
const runtime = () => createTraceRuntime({
  getWindow: () => null,
  rendererCanReceive: () => false,
  activeRunSessionKey: () => null,
  dockBadge: new DockBadgeState(() => { }),
  mainEventId: (prefix, runId) => `${prefix}:${runId}:${++seq}`
})

const run = (runId = 'run-1', items: TraceEvent[] = []): ActiveRun => ({
  runId, providerId: 'claude', userText: 'task', items, done: false
})
const toolResult = (id: string, body: string): TraceEvent => ({
  id, ts: 'T', runId: 'run-1', kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: id, output: body
})
const textDelta = (id: string, text: string, messageId = 'm-1'): TraceEvent => ({
  id, ts: 'T', runId: 'run-1', kind: 'model', stage: 'text_delta', text, messageId
})
const replaceStream = (id: string, text: string, messageId = 'm-1'): TraceEvent => ({
  id, ts: 'T', runId: 'run-1', kind: 'model', stage: 'text', text, messageId,
  runtimeMetadata: { replacesStreamedText: true }
})
const resultEvent = (id: string, text: string): TraceEvent => ({
  id, ts: 'T', runId: 'run-1', kind: 'harness', stage: 'result', text
})

describe('bounded live projection cache', () => {
  it('reuses the projection when nothing was written, and matches the full oracle', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'hello'))
    const first = trace.boundedLiveRun(state).items
    const second = trace.boundedLiveRun(state).items
    expect(second).toBe(first)
    expect(asJson(second)).toEqual(asJson(oracle(state)))
  })

  it('rebuilds only the suffix after an append', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'hello'))
    const first = trace.boundedLiveRun(state).items
    appendCoalescedTrace(state.items, toolResult('t-1', 'ok'))
    const second = trace.boundedLiveRun(state).items
    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second.length).toBe(first.length + 1)
    expect(asJson(second)).toEqual(asJson(oracle(state)))
  })

  it('rebuilds a merged tail without rewriting the snapshot a reader already holds', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'hel'))
    const first = trace.boundedLiveRun(state).items
    appendCoalescedTrace(state.items, textDelta('d-2', 'lo'))
    const second = trace.boundedLiveRun(state).items
    expect(state.items.length).toBe(1)
    expect(second.length).toBe(1)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].text).toBe('hello')
    // The earlier snapshot is a copy: the in-place tail merge cannot rewrite it.
    expect(first[0].text).toBe('hel')
    expect(asJson(second)).toEqual(asJson(oracle(state)))
  })

  it('rebuilds from a non-tail splice that replaces streamed text', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    appendCoalescedTrace(state.items, textDelta('d-2', 'b'))
    appendCoalescedTrace(state.items, toolResult('t-1', 'ok'))
    const first = trace.boundedLiveRun(state).items
    appendCoalescedTrace(state.items, replaceStream('d-3', 'ab'))
    const second = trace.boundedLiveRun(state).items
    expect(second).not.toBe(first)
    expect(second.length).toBe(2)
    expect(second.some((item) => item.id === 'd-2')).toBe(false)
    expect(asJson(second)).toEqual(asJson(oracle(state)))
  })

  it('rebuilds the suffix when a body changes with the same byte length', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-0', 'head'))
    appendCoalescedTrace(state.items, toolResult('t-1', 'AAAA'))
    appendCoalescedTrace(state.items, textDelta('d-2', 'tail', 'm-2'))
    const first = trace.boundedLiveRun(state).items
    expect(first.map((item) => item.output ?? item.text)).toEqual(['head', 'AAAA', 'tail'])
    // Same UTF-8 length, different content: neither identity nor byte count can be the signal.
    expect(Buffer.byteLength('AAAA')).toBe(Buffer.byteLength('BBBB'))
    upsertTraceById(state.items, toolResult('t-1', 'BBBB'))
    expect(state.items[1]).toMatchObject({ output: 'BBBB' })
    const second = trace.boundedLiveRun(state).items
    expect(second).not.toBe(first)
    // Only the prefix before the dirty index may be shared; the item at and after it is rebuilt.
    expect(second[0]).toBe(first[0])
    expect(second[1].output).toBe('BBBB')
    expect(asJson(second)).toEqual(asJson(oracle(state)))
  })

  it('projects an untracked array in full and caches nothing for it', () => {
    const trace = runtime()
    const items: TraceEvent[] = [textDelta('d-1', 'a')]
    const state = run('untracked', items)
    const first = trace.boundedLiveRun(state).items
    // No writer was called, so nothing was recorded; an in-place edit still has to show up.
    items[0].text = 'changed'
    const second = trace.boundedLiveRun(state).items
    expect(second).not.toBe(first)
    expect(second[0].text).toBe('changed')
    expect(asJson(second)).toEqual(asJson(oracle(state)))
  })

  it('projects an untracked tool event whose nested input was edited in place', () => {
    const trace = runtime()
    const input = { command: 'rg -n "a" src' }
    const items: TraceEvent[] = [{
      id: 't-1', ts: 'T', runId: 'run-1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 't-1', input
    }]
    const state = run('untracked-input', items)
    const first = trace.boundedLiveRun(state).items
    input.command = 'rg -n "b" src'
    const second = trace.boundedLiveRun(state).items
    expect(second).not.toBe(first)
    expect(second[0]).toMatchObject({ input: { command: 'rg -n "b" src' } })
    expect(asJson(second)).toEqual(asJson(oracle(state)))
    expect(first[0]).toMatchObject({ input: { command: 'rg -n "a" src' } })
  })

  it('recovers turn budget for the suffix when an earlier body shrinks', () => {
    const trace = runtime()
    const state = run()
    for (let index = 0; index < 17; index++) appendCoalescedTrace(state.items, toolResult(`t-${index}`, 'x'.repeat(8 * 1024)))
    const truncated = trace.boundedLiveRun(state).items
    // Sixteen full bodies exhaust the 128 KiB turn budget, so the last body cannot be shown.
    expect(storage(truncated[16])).toBe('omitted')
    expect(asJson(truncated)).toEqual(asJson(oracle(state)))
    // Shrinking the first body frees budget for every later body: the suffix must be re-projected.
    upsertTraceById(state.items, toolResult('t-0', 'x'))
    const recovered = trace.boundedLiveRun(state).items
    expect(recovered).not.toBe(truncated)
    expect(storage(recovered[16])).toBe('truncated')
    expect(asJson(recovered)).toEqual(asJson(oracle(state)))
  })

  it('applies a real failed terminal result to a warm cache', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, resultEvent('r-1', 'first result'))
    appendCoalescedTrace(state.items, resultEvent('r-2', 'second result'))
    const warm = trace.boundedLiveRun(state).items
    expect(warm.map((item) => item.stage)).toEqual(['result', 'result'])
    ensureFailedTerminalResult(state.items, {
      runId: state.runId, message: 'provider crashed', providerId: 'claude', runtimeProvider: 'claude_sdk',
      id: 'r-2', ts: 'T2'
    })
    const after = trace.boundedLiveRun(state).items
    expect(after.map((item) => item.stage)).toEqual(['result_superseded', 'result'])
    expect(after[1].isError).toBe(true)
    expect(after[1].text).toBe('second result')
    // The snapshot taken before the failure still shows what that reader saw.
    expect(warm.map((item) => item.stage)).toEqual(['result', 'result'])
    expect(asJson(after)).toEqual(asJson(oracle(state)))
  })

  it('applies a persisted enrichment found by id after an earlier splice', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, toolResult('t-1', 'raw output'))
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    trace.boundedLiveRun(state)
    // A streamed-text replacement removes the model delta, so the tool event keeps index 0 and
    // the enrichment must still land on it by id.
    appendCoalescedTrace(state.items, replaceStream('d-2', 'a'))
    expect(state.items.map((item) => item.id)).toEqual(['t-1', 'd-2'])
    const persisted: TraceEvent = {
      ...toolResult('t-1', 'raw output'),
      outputContent: {
        content: 'raw output', encoding: 'utf8', savedBytes: 10, source: 'live_renderer',
        sourceCompleteness: 'unknown', redaction: 'disabled', storage: 'complete', reasons: []
      }
    }
    expect(replaceTraceById(state.items, persisted)).toBe(true)
    const after = trace.boundedLiveRun(state).items
    expect(storage(after[0])).toBe('complete')
    expect(after[0]).toMatchObject({ output: 'raw output' })
    expect(asJson(after)).toEqual(asJson(oracle(state)))
    // A removed event is never resurrected by an enrichment that arrives late.
    expect(replaceTraceById(state.items, toolResult('t-missing', 'late'))).toBe(false)
  })

  it('keeps metadata live while reusing the cached items', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'hi'))
    const first = trace.boundedLiveRun(state).items
    state.done = true
    state.error = 'boom'
    const shown = trace.boundedLiveRun(state)
    expect(shown.done).toBe(true)
    expect(shown.error).toBe('boom')
    expect(shown.items).toBe(first)
  })

  it('treats a replaced items array as a new generation', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'hi'))
    const first = trace.boundedLiveRun(state).items
    state.items = [textDelta('d-9', 'replacement')]
    const second = trace.boundedLiveRun(state).items
    expect(second).not.toBe(first)
    expect(second.map((item) => item.id)).toEqual(['d-9'])
    expect(asJson(second)).toEqual(asJson(oracle(state)))
  })

  it('does not lose a change when two runtimes read the same run', () => {
    const a = runtime()
    const b = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    a.boundedLiveRun(state)
    appendCoalescedTrace(state.items, textDelta('d-2', 'b'))
    // b consumes the dirty range a has not read yet.
    expect(asJson(b.boundedLiveRun(state).items)).toEqual(asJson(oracle(state)))
    // a must not trust the range b cleared: it owes a rebuild.
    const shown = a.boundedLiveRun(state).items
    expect(shown[0].text).toBe('ab')
    expect(asJson(shown)).toEqual(asJson(oracle(state)))
  })

  it('releases a run on forgetBoundedRun', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'hi'))
    const first = trace.boundedLiveRun(state).items
    trace.forgetBoundedRun(state.runId)
    const second = trace.boundedLiveRun(state).items
    expect(second).not.toBe(first)
    expect(asJson(second)).toEqual(asJson(oracle(state)))
  })

  it('evicts by run count and by total projected items', () => {
    const trace = runtime()
    const runs = Array.from({ length: 9 }, (_unused, index) => run(`run-${index}`, [textDelta(`d-${index}`, 'x')]))
    const firstOfRun0 = trace.boundedLiveRun(runs[0]).items
    for (const state of runs.slice(1)) trace.boundedLiveRun(state)
    // Nine runs exceed the eight-run bound, so the first one is no longer cached.
    expect(trace.boundedLiveRun(runs[0]).items).not.toBe(firstOfRun0)

    const wide = runtime()
    const padded = (id: string): ActiveRun => {
      const items = Array.from({ length: 6_500 }, (_unused, index) => resultEvent(`${id}-${index}`, 'x'))
      const state = run(id, items)
      appendCoalescedTrace(items, resultEvent(`${id}-last`, 'y'))
      return state
    }
    const many = Array.from({ length: 8 }, (_unused, index) => padded(`wide-${index}`))
    const wideFirst = wide.boundedLiveRun(many[0]).items
    for (const state of many.slice(1)) wide.boundedLiveRun(state)
    // Eight runs of 6_500 items exceed the 50_000-item bound as well.
    expect(wide.boundedLiveRun(many[0]).items).not.toBe(wideFirst)
  })

  it('projects per read instead of caching a run past the item bound', () => {
    const trace = runtime()
    const items = Array.from({ length: 50_001 }, (_unused, index) => resultEvent(`r-${index}`, 'x'))
    // Written through the helper so the array is tracked: the bound, not the untracked path,
    // is what keeps this run out of the cache.
    appendCoalescedTrace(items, resultEvent('r-50001', 'y'))
    const state = run('huge', items)
    const first = trace.boundedLiveRun(state).items
    const second = trace.boundedLiveRun(state).items
    expect(second).not.toBe(first)
    expect(second.length).toBe(50_002)
    expect(asJson(second[50_001])).toEqual(asJson(oracle(state)[50_001]))
  })
})
