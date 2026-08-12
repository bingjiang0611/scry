import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { appendCoalescedTrace } from './live-trace'

const delta = (id: string, text: string): TraceEvent => ({
  id,
  ts: '2026-07-10T00:00:00.000Z',
  runId: 'run-1',
  kind: 'model',
  stage: 'text_delta',
  text
})

describe('appendCoalescedTrace', () => {
  it('coalesces the snapshot without mutating events queued for renderer IPC', () => {
    const first = delta('1', 'O')
    const second = delta('2', 'K')
    const items: TraceEvent[] = []

    appendCoalescedTrace(items, first)
    appendCoalescedTrace(items, second)

    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('OK')
    expect(first.text).toBe('O')
    expect(second.text).toBe('K')
  })

  it('用 Provider 权威正文替换同 message 的不完整流式前缀', () => {
    const items: TraceEvent[] = []
    appendCoalescedTrace(items, { ...delta('prefix', 'hel'), messageId: 'message-1' })
    appendCoalescedTrace(items, {
      ...delta('authoritative', 'hello'),
      stage: 'text',
      messageId: 'message-1',
      runtimeMetadata: { replacesStreamedText: true }
    })

    expect(items).toEqual([
      expect.objectContaining({ stage: 'text', text: 'hello', runtimeMetadata: { replacesStreamedText: true } })
    ])
  })

  it('does not merge root and child output or a delta with its final snapshot', () => {
    const items: TraceEvent[] = []
    appendCoalescedTrace(items, delta('root', '根'))
    appendCoalescedTrace(items, { ...delta('child', '子'), agentId: 'child-1', parentToolUseId: 'spawn-1' })
    appendCoalescedTrace(items, { ...delta('snapshot', '根'), stage: 'text' })

    expect(items.map((event) => [event.stage, event.text, event.agentId])).toEqual([
      ['text_delta', '根', undefined],
      ['text_delta', '子', 'child-1'],
      ['text', '根', undefined]
    ])
  })
})
