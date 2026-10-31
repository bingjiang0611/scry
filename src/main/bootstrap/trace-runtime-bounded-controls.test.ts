import { describe, expect, it, vi } from 'vitest'
import { appendCoalescedTrace, upsertTraceById } from '../live-trace'
import { DockBadgeState } from '../dock-badge'
import { sanitizeToolEvents, type ToolContentPolicy } from '../../core/turn-recorder/tool-content'
import type { TraceEvent } from '../../shared/trace'
import { createTraceRuntime } from './trace-runtime'

// Negative controls required by the P1 mutation plan (§C.3): the independent full projection has
// to notice a change the cache never heard about. The damage lives only in this file, applied to
// the real state numbers or to the single-item step the cache calls. Production has no switch for
// it, and the state object keeps its identity so the cache still treats it as the same generation.
const damage = vi.hoisted(() => ({
  state: null as null | { revision: number; baseRevision: number; dirtyFrom: number },
  remaining: null as number | null
}))

vi.mock('../live-trace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live-trace')>()
  return {
    ...actual,
    traceMutationState: (items: readonly TraceEvent[]) => {
      const state = actual.traceMutationState(items)
      // Same object the cache sees: only its numbers are tampered with below.
      if (state) damage.state = state
      return state
    }
  }
})

vi.mock('../../core/turn-recorder/tool-content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/turn-recorder/tool-content')>()
  return {
    ...actual,
    // One-shot damage: the item itself is projected correctly, but the caller is handed the
    // pre-change remaining budget, which is what a stale suffix budget looks like.
    sanitizeToolEvent: (event: TraceEvent, policy: ToolContentPolicy, source: string, remaining: number) => {
      const step = actual.sanitizeToolEvent(event, policy, source, remaining)
      if (damage.remaining === null) return step
      const stale = damage.remaining
      damage.remaining = null
      return { event: step.event, remaining: stale }
    }
  }
})

const POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }
const oracle = (items: TraceEvent[]): TraceEvent[] => sanitizeToolEvents(items, POLICY, 'live_renderer')
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
const run = (runId = 'control-run', items: TraceEvent[] = []) => ({
  runId, providerId: 'claude' as const, userText: 'task', items, done: false
})
const textDelta = (id: string, text: string, messageId = 'm-1'): TraceEvent => ({
  id, ts: 'T', runId: 'control-run', kind: 'model', stage: 'text_delta', text, messageId
})
const noteEvent = (id: string): TraceEvent => ({
  id, ts: 'T', runId: 'control-run', kind: 'harness', stage: 'note', text: 'separator'
})
const replaceStream = (id: string, text: string, messageId = 'm-1'): TraceEvent => ({
  id, ts: 'T', runId: 'control-run', kind: 'model', stage: 'text', text, messageId,
  runtimeMetadata: { replacesStreamedText: true }
})
const toolResult = (id: string, body: string): TraceEvent => ({
  id, ts: 'T', runId: 'control-run', kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: id, output: body
})

describe('bounded projection negative controls', () => {
  it('detects a suppressed property notification on the merged tail', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'a'))
    expect(trace.boundedLiveRun(state).items[0].text).toBe('a')
    const real = damage.state!
    const saved = { revision: real.revision, baseRevision: real.baseRevision, dirtyFrom: real.dirtyFrom }
    appendCoalescedTrace(state.items, textDelta('d-2', 'b'))
    // Test-only: restore the pre-write numbers so the cache sees no pending notification.
    Object.assign(real, saved)
    const stale = trace.boundedLiveRun(state).items
    expect(stale[0].text).toBe('a')
    expect(asJson(stale)).not.toEqual(asJson(oracle(state.items)))
    // A new generation is the only recovery once a notification is lost.
    trace.forgetBoundedRun(state.runId)
    const fresh = trace.boundedLiveRun(state).items
    expect(fresh[0].text).toBe('ab')
    expect(asJson(fresh)).toEqual(asJson(oracle(state.items)))
  })

  it('detects a structural change whose dirty index was pushed past it', () => {
    const trace = runtime()
    const state = run()
    appendCoalescedTrace(state.items, textDelta('d-1', 'streamed'))
    appendCoalescedTrace(state.items, noteEvent('n-1'))
    appendCoalescedTrace(state.items, toolResult('t-1', 'body'))
    expect(trace.boundedLiveRun(state).items.length).toBe(3)
    const real = damage.state!
    const saved = { revision: real.revision, baseRevision: real.baseRevision, dirtyFrom: real.dirtyFrom }
    appendCoalescedTrace(state.items, replaceStream('d-2', 'streamed'))
    expect(state.items.map((item) => item.id)).toEqual(['d-2', 'n-1', 't-1'])
    // Test-only: keep the new revision but start the dirty range one index late, so index 0 is
    // never re-projected. The state object identity is preserved.
    Object.assign(real, { ...saved, revision: real.revision, dirtyFrom: Math.min(saved.dirtyFrom + 1, state.items.length) })
    const stale = trace.boundedLiveRun(state).items
    expect(stale[0].id).toBe('d-1')
    expect(asJson(stale)).not.toEqual(asJson(oracle(state.items)))
    trace.forgetBoundedRun(state.runId)
    expect(asJson(trace.boundedLiveRun(state).items)).toEqual(asJson(oracle(state.items)))
  })

  it('detects a stale suffix budget while the early item itself is correct', () => {
    const trace = runtime()
    const state = run()
    for (let index = 0; index < 17; index++) appendCoalescedTrace(state.items, toolResult(`t-${index}`, 'x'.repeat(8 * 1024)))
    expect(storage(trace.boundedLiveRun(state).items[16])).toBe('omitted')
    // The remaining budget after item 0 while its body was still 8 KiB.
    damage.remaining = 128 * 1024 - 8 * 1024
    upsertTraceById(state.items, toolResult('t-0', 'x'))
    const projected = trace.boundedLiveRun(state).items
    const good = oracle(state.items)
    // The item that changed is projected correctly, so any difference is the stale budget alone.
    expect(asJson(projected[0])).toEqual(asJson(good[0]))
    expect(storage(projected[16])).toBe('omitted')
    expect(storage(good[16])).toBe('truncated')
    expect(asJson(projected)).not.toEqual(asJson(good))
    // The damage was one-shot; a fresh generation matches the oracle again.
    expect(damage.remaining).toBeNull()
    trace.forgetBoundedRun(state.runId)
    expect(asJson(trace.boundedLiveRun(state).items)).toEqual(asJson(oracle(state.items)))
  })
})
