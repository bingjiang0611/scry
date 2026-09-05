import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { TurnStreamProjectionCache, isStreamTextFragment } from './turn-stream-projection'

const tool = (id: string): TraceEvent => ({
  id,
  runId: 'r1',
  ts: '',
  kind: 'tool',
  stage: 'tool_use',
  tool: 'Read',
  toolUseId: id
})

const delta = (id: string, text: string, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  id,
  runId: 'r1',
  ts: '',
  kind: 'model',
  stage: 'text_delta',
  messageId: 'm1',
  text,
  ...extra
})

const fullText = (id: string, text: string): TraceEvent => ({
  id,
  runId: 'r1',
  ts: '',
  kind: 'model',
  stage: 'text',
  messageId: 'm1',
  text
})

describe('turn stream fragment classification', () => {
  it('treats text_delta as streaming, and full text only for codex transports', () => {
    expect(isStreamTextFragment(delta('d1', 'a'))).toBe(true)
    expect(isStreamTextFragment(fullText('t1', 'a'))).toBe(false)
    expect(isStreamTextFragment({ ...fullText('t1', 'a'), providerId: 'codex' })).toBe(true)
    expect(isStreamTextFragment({ ...fullText('t1', 'a'), runtimeProvider: 'codex_cli' })).toBe(true)
    expect(isStreamTextFragment(tool('x1'))).toBe(false)
  })
})

describe('TurnStreamProjectionCache bounded structural updates', () => {
  it('keeps one structural projection across a long streaming tail', () => {
    const cache = new TurnStreamProjectionCache()
    const base = [tool('t-1'), tool('t-2'), tool('t-3')]
    let recomputes = 0
    let projection = cache.project(base)
    if (projection.structuralRecomputed) recomputes += 1
    const firstStructural = projection.structuralItems

    // 模拟 500 批「合批后仍是同一条 text_delta 被追加文本」的流式更新。
    let text = ''
    for (let batch = 0; batch < 500; batch++) {
      text += `token-${batch} `
      projection = cache.project([...base, delta('d-1', text)])
      if (projection.structuralRecomputed) recomputes += 1
      expect(projection.structuralItems).toBe(firstStructural)
      expect(projection.liveText).toBe(text)
      expect(projection.liveKey).toBe('d-1')
    }
    // 500 批流式增量只允许 1 次结构化重算（首次建立）。
    expect(recomputes).toBe(1)
    expect(firstStructural).toEqual(base)
  })

  it('keeps a single structural projection when new fragment events are appended', () => {
    const cache = new TurnStreamProjectionCache()
    const base = [tool('t-1')]
    const first = cache.project(base).structuralItems
    let recomputes = 0
    for (let index = 0; index < 200; index++) {
      const projection = cache.project([...base, ...Array.from({ length: index + 1 }, (_u, i) => delta(`d-${i}`, `${i} `))])
      if (projection.structuralRecomputed) recomputes += 1
      expect(projection.structuralItems).toBe(first)
    }
    expect(recomputes).toBe(0)
  })

  it('recomputes exactly once per structural change and preserves ordering', () => {
    const cache = new TurnStreamProjectionCache()
    // applyTraceBatch 保留未变事件的对象引用；这里照同一语义复用同一批对象。
    const t1 = tool('t-1')
    const t2 = tool('t-2')
    const d1 = delta('d-1', 'hello ')
    cache.project([t1])
    const afterTool = cache.project([t1, d1])
    expect(afterTool.structuralRecomputed).toBe(false)

    // 新工具调用是结构变化：必须重算，且顺序保持在流式文本之前。
    const withNewTool = cache.project([t1, d1, t2])
    expect(withNewTool.structuralRecomputed).toBe(true)
    expect(withNewTool.structuralItems.map((event) => event.id)).toEqual(['t-1', 'd-1', 't-2'])
    expect(withNewTool.liveText).toBe('')

    const streamingAgain = cache.project([t1, d1, t2, delta('d-2', 'more')])
    expect(streamingAgain.structuralRecomputed).toBe(false)
    expect(streamingAgain.liveText).toBe('more')
  })

  it('treats mid-stream corrections and superseded events as structural changes', () => {
    const cache = new TurnStreamProjectionCache()
    const t1 = tool('t-1')
    const t2 = tool('t-2')
    const d1 = delta('d-1', 'x')
    const corrected = { ...t1, output: 'done' }
    cache.project([t1, t2, d1])
    // 中间事件被更正（新对象引用）不能被当成纯尾部增量复用。
    const afterCorrection = cache.project([corrected, t2, d1])
    expect(afterCorrection.structuralRecomputed).toBe(true)
    expect(afterCorrection.structuralItems[0]).toBe(corrected)

    // 事件被移除（result_superseded）同样是结构变化。
    const afterRemoval = cache.project([corrected, d1])
    expect(afterRemoval.structuralRecomputed).toBe(true)
    expect(afterRemoval.structuralItems.map((event) => event.id)).toEqual(['t-1'])
  })

  it('replacing streamed deltas with the canonical full text becomes structural, not a live tail', () => {
    const cache = new TurnStreamProjectionCache()
    const t1 = tool('t-1')
    cache.project([t1, delta('d-1', 'partial')])
    const replaced = cache.project([t1, fullText('t-final', 'partial answer')])
    expect(replaced.structuralRecomputed).toBe(true)
    expect(replaced.liveText).toBe('')
    expect(replaced.structuralItems.map((event) => event.id)).toEqual(['t-1', 't-final'])
  })

  it('extracts one parent-scoped subagent tail without rebuilding the outer structure', () => {
    const cache = new TurnStreamProjectionCache()
    const parent = tool('t-1')
    const first = cache.project([parent, delta('d-1', 'child ', { parentToolUseId: 't-1' })])
    const second = cache.project([
      parent,
      delta('d-1', 'child ', { parentToolUseId: 't-1' }),
      delta('d-2', 'answer', { parentToolUseId: 't-1' })
    ])

    expect(first.liveParentToolUseId).toBe('t-1')
    expect(second.liveText).toBe('child answer')
    expect(second.structuralItems.map((event) => event.id)).toEqual(['t-1'])
    expect(second.structuralRecomputed).toBe(false)
  })

  it('keeps orphan parent-scoped text structural so bad attribution cannot hide it', () => {
    const cache = new TurnStreamProjectionCache()
    const orphan = cache.project([delta('d-1', 'visible', { parentToolUseId: 'missing-parent' })])
    expect(orphan.liveText).toBe('')
    expect(orphan.structuralItems.map((event) => event.id)).toEqual(['d-1'])
  })

  it('does not treat a standalone tool result as a parent for scoped live text', () => {
    const cache = new TurnStreamProjectionCache()
    const result = { ...tool('orphan-result'), stage: 'tool_result' }
    const projection = cache.project([result, delta('d-1', 'still visible', { parentToolUseId: 'orphan-result' })])
    expect(projection.liveText).toBe('')
    expect(projection.structuralItems.map((event) => event.id)).toEqual(['orphan-result', 'd-1'])
  })

  it('force-flushes the tail into the structural projection at terminal state', () => {
    const cache = new TurnStreamProjectionCache()
    const t1 = tool('t-1')
    const d1 = delta('d-1', 'answer')
    cache.project([t1, d1])
    // 终态到达（result 事件）必须把尾部并回结构化投影，不留悬空的流式段。
    const terminal = cache.project([
      t1,
      d1,
      { id: 'res-1', runId: 'r1', ts: '', kind: 'harness', stage: 'result' }
    ])
    expect(terminal.structuralRecomputed).toBe(true)
    expect(terminal.liveText).toBe('')
    expect(terminal.structuralItems.map((event) => event.id)).toEqual(['t-1', 'd-1', 'res-1'])
  })
})
