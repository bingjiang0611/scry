import { describe, it, expect } from 'vitest'
import { type TraceEvent } from '../../../shared/trace'
import { mergeTurnTraceEvents } from '../recorder'

export function registerSuite8(): void {


describe('lifecycle/transcript merge', () => {
  it('优先 transcript 的同一 toolUseId，并去掉 lifecycle 的重复 assistant/usage', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'life-tool', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'life-text', kind: 'model', stage: 'text', text: 'answer' }),
      event({ id: 'life-usage', kind: 'harness', stage: 'result', tokensIn: 9 })
    ]
    const transcript = [
      event({ id: 'transcript-tool', ts: '2026-01-01T00:00:01Z', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'transcript-text', ts: '2026-01-01T00:00:01Z', kind: 'model', stage: 'text', text: 'answer' }),
      event({ id: 'transcript-usage', ts: '2026-01-01T00:00:01Z', kind: 'harness', stage: 'result', text: 'transcript assistant usage', tokensIn: 9 })
    ]
    expect(mergeTurnTraceEvents(lifecycle, transcript).map((item) => item.id)).toEqual(['transcript-tool', 'transcript-text', 'transcript-usage'])
  })

  it('同一 toolUseId 的 lifecycle 重放不因 timestamp 不同重复计数', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'start-1', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'start-2', ts: '2026-01-01T00:00:00.250Z', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'result-1', ts: '2026-01-01T00:00:01Z', stage: 'tool_result', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'result-2', ts: '2026-01-01T00:00:01.250Z', stage: 'tool_result', toolUseId: 't1', tool: 'Bash' })
    ]

    expect(mergeTurnTraceEvents(lifecycle, []).map((item) => item.id)).toEqual(['start-1', 'result-1'])
  })

  it('完整 transcript 使用不同 call id 时仍压掉 lifecycle 的同轮调用', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'life-start', toolUseId: 'exec-1', tool: 'Bash' }),
      event({ id: 'life-result', stage: 'tool_result', toolUseId: 'exec-1', tool: 'Bash' })
    ]
    const transcript = [
      event({ id: 'rollout-start', toolUseId: 'call_1', tool: 'Bash' }),
      event({ id: 'rollout-result', stage: 'tool_result', toolUseId: 'call_1', tool: 'Bash' })
    ]

    expect(mergeTurnTraceEvents(lifecycle, transcript).map((item) => item.id)).toEqual([
      'rollout-start',
      'rollout-result'
    ])
  })

  it('transcript 尚有异步调用未完成时保留 lifecycle 尾部证据', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'life-start', toolUseId: 'exec-tail', tool: 'Bash' }),
      event({ id: 'life-result', stage: 'tool_result', toolUseId: 'exec-tail', tool: 'Bash' })
    ]
    const transcript = [
      event({ id: 'rollout-start', toolUseId: 'call_pending', tool: 'Bash' })
    ]

    expect(mergeTurnTraceEvents(lifecycle, transcript, false).map((item) => item.id)).toEqual([
      'life-start',
      'life-result',
      'rollout-start'
    ])
  })

  it('transcript 带脚本身份的 hook 运行压掉 recorder 的投递事件，缺失时保留投递证据', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'hook', stage: 'hook_delivery', ...overrides })
    const lifecycle = [event({ id: 'delivery', hookEvent: 'PreToolUse', hookId: 'delivery:PreToolUse::t1' })]
    const transcriptRun = [
      event({ id: 'run', ts: '2026-01-01T00:00:01Z', stage: 'hook_response', hookId: 'h1', hookName: 'audit.py', hookEvent: 'PreToolUse', hookOutcome: 'success' })
    ]

    expect(mergeTurnTraceEvents(lifecycle, transcriptRun).map((item) => item.id)).toEqual(['run'])
    expect(mergeTurnTraceEvents(lifecycle, []).map((item) => item.id)).toEqual(['delivery'])
  })
})
}
