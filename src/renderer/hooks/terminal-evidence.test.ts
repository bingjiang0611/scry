import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import type { Turn } from '../format'
import { appendMissingTraceItems, hasTerminalResult, replayRunLifecycleDeltas, terminalEvidenceOf } from './useAgentSession'

const ev = (id: string, runId = 'r1'): TraceEvent => ({
  id,
  runId,
  ts: '',
  kind: 'model',
  stage: 'text',
  text: id
})

describe('terminal evidence backfill', () => {
  const resultEvent = (id: string, runId = 'r1'): TraceEvent => ({
    id,
    runId,
    ts: '',
    kind: 'harness',
    stage: 'result',
    tokensIn: 10,
    tokensOut: 5
  })

  it('把归档里的终态 result 补进缺失的一轮，并按 id 去重', () => {
    const turn: Turn = { runId: 'r1', userText: 'prompt', items: [ev('tool-1')], done: true, error: 'failed' }
    expect(hasTerminalResult(turn)).toBe(false)

    const patched = appendMissingTraceItems([turn], 'r1', [resultEvent('result-1'), ev('tool-1')])

    expect(patched[0].items.map((item) => item.id)).toEqual(['tool-1', 'result-1'])
    expect(hasTerminalResult(patched[0])).toBe(true)
    // 已有 result 时不再改动，避免覆盖 live 证据
    expect(appendMissingTraceItems(patched, 'r1', [resultEvent('result-1')])).toBe(patched)
  })

  it('只认终态 result/session_diff，不把中间事件当作用量证据', () => {
    const intermediate: TraceEvent[] = [ev('text-1'), { ...resultEvent('diff-1'), stage: 'session_diff' }]
    expect(terminalEvidenceOf(intermediate).map((item) => item.id)).toEqual(['diff-1'])
  })

  it('终态 delta 落到已显示但未聚焦的轮次，不落其他会话的轮次', () => {
    const turns: Turn[] = [{ runId: 'r1', userText: 'prompt', items: [], done: false }]
    const other: Turn[] = [{ runId: 'r2', userText: 'other', items: [], done: false }]
    const delta = { kind: 'error' as const, event: { runId: 'r1', message: 'Qoder: request_failed' } }

    expect(replayRunLifecycleDeltas(turns, [delta])[0]).toMatchObject({ done: true, error: 'Qoder: request_failed' })
    expect(replayRunLifecycleDeltas(other, [delta])).toEqual(other)
  })
})
