import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { appendCoalescedTrace } from './live-trace'
import { LlmPerformanceObserver } from './llm-performance'

function fixture() {
  let time = 0
  const epoch = Date.parse('2026-10-10T00:00:00Z')
  const observer = new LlmPerformanceObserver('VPN A', { monotonic: () => time, now: () => epoch + time })
  const events: TraceEvent[] = []
  let sequence = 0
  const emit = (at: number, partial: Partial<TraceEvent>) => {
    time = at
    const event: TraceEvent = { id: String(sequence++), runId: 'run', ts: new Date(epoch + time).toISOString(), kind: 'model', stage: 'text_delta', ...partial }
    event.llmPerformance = observer.observe(event, events)
    appendCoalescedTrace(events, event)
    return event.llmPerformance
  }
  return { emit, events, epoch }
}


describe('local LLM performance observation', () => {
  it('counts genuine Unicode text chunks before coalescing, not chunks as tokens or snapshots twice', () => {
    const { emit, events, epoch } = fixture()
    emit(1000, { text: '你好🙂' })
    const sample = emit(2000, { text: 'abc' })
    expect(sample).toMatchObject({ networkLabel: 'VPN A', firstOutputWaitMs: 1000, streamCharacters: 6, streamDurationMs: 1000, averageCharactersPerSecond: 6 })
    expect(sample.outputTokens).toBeUndefined()
    expect(sample.recentOutput).toEqual([{ ts: epoch + 1000, characters: 3 }, { ts: epoch + 2000, characters: 3 }])
    expect(events).toHaveLength(1)
    expect(events[0].llmPerformance?.streamCharacters).toBe(6)
    expect(emit(3000, { stage: 'text', text: '你好🙂abc' }).streamCharacters).toBe(6)
  })

  it('excludes child output, buffered Pi fallback and tool waiting', () => {
    const { emit } = fixture()
    expect(emit(100, { text: 'child', parentToolUseId: 'agent' }).firstOutputWaitMs).toBeUndefined()
    emit(1000, { text: 'abc' })
    emit(2000, { text: 'def' })
    expect(emit(2200, { kind: 'tool', stage: 'tool:Bash', toolUseId: 't' }).state).toBe('tool')
    emit(20_000, { kind: 'tool', stage: 'tool_result', toolUseId: 't' })
    emit(21_000, { text: 'ghi' })
    emit(22_000, { text: 'jkl' })
    const end = emit(23_000, { kind: 'harness', stage: 'result' })
    expect(end).toMatchObject({ streamCharacters: 12, streamDurationMs: 2000, averageCharactersPerSecond: 6, state: 'complete' })
    expect(end.apiTokensPerSecond).toBeUndefined()
    const buffered = fixture().emit(1000, { text: 'whole reply', runtimeMetadata: { bufferedOutput: true } })
    expect(buffered).toMatchObject({ state: 'buffered', streamCharacters: 0, firstOutputWaitMs: 1000 })
    expect(buffered.averageCharactersPerSecond).toBeUndefined()
  })

  it('does not bridge separate responses, inflate retry snapshots, or fabricate timing for a single chunk', () => {
    const { emit } = fixture()
    emit(1000, { text: 'abc', messageId: 'm1' })
    emit(2000, { text: 'def', messageId: 'm1' })
    emit(3000, { kind: 'harness', stage: 'runtime:llm_stream_end' })
    emit(10_000, { text: 'xyz', messageId: 'm2' })
    expect(emit(11_000, { text: 'uvwxyz', stage: 'text', messageId: 'm2', runtimeMetadata: { replacesStreamedText: true, genuineStreamDelta: 'uvw' } })).toMatchObject({ streamCharacters: 12, streamDurationMs: 2000, averageCharactersPerSecond: 6 })
    const singleton = fixture()
    singleton.emit(100, { text: 'one chunk' })
    expect(singleton.emit(200, { kind: 'harness', stage: 'result' }).averageCharactersPerSecond).toBeUndefined()
  })

  it('selects canonical cumulative Claude usage and requires full incremental coverage for other providers', () => {
    const cumulative = fixture()
    cumulative.emit(1000, { kind: 'harness', stage: 'result', runtimeProvider: 'claude_sdk', tokensOut: 20, durationApiMs: 1000 })
    expect(cumulative.emit(2000, { kind: 'harness', stage: 'result', runtimeProvider: 'claude_sdk', tokensOut: 30, durationApiMs: 2000 })).toMatchObject({ outputTokens: 30, apiTokensPerSecond: 15 })
    const incremental = fixture()
    incremental.emit(1000, { kind: 'harness', stage: 'result', tokensOut: 20, durationApiMs: 1000 })
    expect(incremental.emit(2000, { kind: 'harness', stage: 'result', tokensOut: 30, durationApiMs: 1000 })).toMatchObject({ outputTokens: 50, apiTokensPerSecond: 25 })
    const partial = fixture()
    partial.emit(1000, { kind: 'harness', stage: 'result', tokensOut: 20 })
    expect(partial.emit(2000, { kind: 'harness', stage: 'result', tokensOut: 30, durationApiMs: 1000 }).apiTokensPerSecond).toBeUndefined()
  })

  it('pairs canonical turn usage only with provider API time, never wall/tool residual timing', () => {
    const { emit } = fixture()
    const result = emit(10_000, { kind: 'harness', stage: 'result', tokensOut: 100, durationApiMs: 5000, durationMs: 10_000 })
    expect(result).toMatchObject({ outputTokens: 100, apiDurationMs: 5000, apiTokensPerSecond: 20 })
    expect(emit(12_000, { kind: 'harness', stage: 'runtime:turn_wall', durationMs: 12_000 })).toMatchObject({ outputTokens: 100, apiTokensPerSecond: 20 })
    expect(fixture().emit(10_000, { kind: 'harness', stage: 'result', tokensOut: 100, durationMs: 10_000 }).apiTokensPerSecond).toBeUndefined()
  })

  it('pairs per-call tokens with the same calls\' local time, ignoring child calls and turn usage', () => {
    const { emit } = fixture()
    const first = emit(1000, { kind: 'harness', stage: 'runtime:llm_stream_end', llmCall: { outputTokens: 100, durationMs: 4000, model: 'ultimate' } })
    expect(first).toMatchObject({ outputTokens: 100, apiDurationMs: 4000, apiTokensPerSecond: 25, tokenTimingSource: 'observed_calls', llmCalls: 1, model: 'ultimate' })
    emit(1500, { kind: 'harness', stage: 'runtime:llm_call', parentToolUseId: 'agent', llmCall: { outputTokens: 900, durationMs: 1000 } })
    emit(2000, { kind: 'harness', stage: 'runtime:llm_stream_end', llmCall: { outputTokens: 50, durationMs: 1000 } })
    // Turn usage also counts retried/failed calls; it must not replace the per-call numerator.
    const end = emit(9000, { kind: 'harness', stage: 'result', tokensOut: 400, durationMs: 9000 })
    expect(end).toMatchObject({ state: 'complete', outputTokens: 150, apiDurationMs: 5000, apiTokensPerSecond: 30, llmCalls: 2, model: 'ultimate' })
  })

  it('keeps Provider API time authoritative and never labels it as observed calls', () => {
    const { emit } = fixture()
    expect(emit(1000, { kind: 'harness', stage: 'result', tokensOut: 100, durationApiMs: 5000 }))
      .toMatchObject({ apiTokensPerSecond: 20, tokenTimingSource: 'provider_api' })
  })
})
