import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from './aggregate'

describe('aggregateTurnEvidence', () => {
  it('区分真实零调用与 Provider 不可观测', () => {
    const exact = aggregateTurnEvidence({ userText: 'hello', events: [], observable: { tools: true } })
    const unavailable = aggregateTurnEvidence({ userText: 'hello', events: [], observable: { tools: false } })
    expect(exact.tools).toEqual({ status: 'available', quality: 'exact', source: ['trace_events'], value: [] })
    expect(unavailable.tools).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
  })

  it('过滤 Recorder 自身 hook，并保留真实 hook', () => {
    const events: TraceEvent[] = [
      { id: '1', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookName: 'turn-recorder-v1', hookEvent: 'Stop', hookOutcome: 'success' },
      { id: '2', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookName: 'audit.py', hookEvent: 'Stop', hookOutcome: 'success' }
    ]
    expect(aggregateTurnEvidence({ events }).hooks.value).toEqual([
      expect.objectContaining({ name: 'audit.py', event: 'Stop', status: 'success' })
    ])
  })

  it('把同一 Hook 的 started/response 聚合为一个处理器实例', () => {
    const events: TraceEvent[] = [
      { id: 'start', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'hook', stage: 'hook_started', hookId: 'h1', hookName: 'audit.py', hookEvent: 'PreToolUse', hookOutcome: 'started' },
      { id: 'end', ts: '2026-01-01T00:00:00.025Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h1', hookName: 'audit.py', hookEvent: 'PreToolUse', hookOutcome: 'success', hookExitCode: 0 },
      { id: 'self', ts: '2026-01-01T00:00:00.030Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h2', hookName: 'command', hookEvent: 'PreToolUse', hookCommand: 'SCRY_HANDLER_ID=turn-recorder-v1 .claude/hooks/scry-recorder.sh claude PreToolUse', hookOutcome: 'success' }
    ]
    expect(aggregateTurnEvidence({ events }).hooks.value).toEqual([
      expect.objectContaining({ id: 'h1', name: 'audit.py', event: 'PreToolUse', status: 'success', durationMs: 25 })
    ])
  })

  it('整轮 Usage 求和，并在原生聚合结果存在时忽略 transcript 影子值', () => {
    const transcript = (id: string, input: number): TraceEvent => ({
      id,
      ts: `2026-01-01T00:00:0${id}.000Z`,
      runId: 'r',
      kind: 'harness',
      stage: 'result',
      text: 'transcript assistant usage',
      tokensIn: input,
      tokensOut: 1
    })
    expect(aggregateTurnEvidence({ events: [transcript('1', 3), transcript('2', 4)] }).usage.value).toMatchObject({ inputTokens: 7, outputTokens: 2 })
    expect(aggregateTurnEvidence({ events: [
      transcript('1', 3),
      transcript('2', 4),
      { id: 'native', ts: '2026-01-01T00:00:03.000Z', runId: 'r', kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 5 }
    ] }).usage.value).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })
})
