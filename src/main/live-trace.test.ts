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
})
