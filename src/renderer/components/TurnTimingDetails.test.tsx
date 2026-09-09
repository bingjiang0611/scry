import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TraceEvent } from '@shared/trace'
import { buildTurnTimingBreakdown } from '../turn-timing'
import { TurnTimingDetails } from './TurnTimingDetails'

function event(partial: Partial<TraceEvent> & Pick<TraceEvent, 'id' | 'kind' | 'stage'>): TraceEvent {
  return { ts: '2026-07-18T00:00:00.000Z', runId: 'run-1', ...partial }
}

function render(items: TraceEvent[], calls: TraceEvent[] = []) {
  return renderToStaticMarkup(<TurnTimingDetails timing={buildTurnTimingBreakdown(items, calls)} />)
}

describe('TurnTimingDetails', () => {
  it('uses the Scry terminal boundary, independent of Provider result timing', () => {
    const items = [
      event({ id: 'result', kind: 'harness', stage: 'result', durationMs: 7863, durationApiMs: 6770 }),
      event({ id: 'wall', kind: 'harness', stage: 'runtime:turn_wall', durationMs: 13_500 })
    ]
    expect(buildTurnTimingBreakdown(items, []).turnWall).toEqual({ durationMs: 13500, source: 'observed' })
    const html = render(items)
    expect(html).toContain('整轮耗时</span><b>14s</b>')
    expect(html).not.toContain('Provider 结果时长')
    expect(html).toContain('Provider API 耗时</span><b>6.8s</b>')
    expect(html).not.toContain('Provider 计时余量')
    expect(html).not.toContain('turn-timing-note')
    expect(html).not.toContain('turn-timing-caption')
    expect(html).not.toContain('<em>')
    expect(html).toContain('title="Scry 接受本轮执行至 Provider 及本轮同步 Hook 收尾结束')
  })

  it('estimates old Qoder turns using recorded Hook boundaries, not SDK duration', () => {
    const items = [
      event({ id: 'start', kind: 'harness', stage: 'runtime:controls', ts: '2026-09-08T08:48:02.000Z' }),
      event({ id: 'session-start', kind: 'hook', stage: 'hook_started', ts: '2026-09-08T08:48:03.836Z' }),
      event({ id: 'prompt-end', kind: 'hook', stage: 'hook_response', ts: '2026-09-08T08:48:06.691Z', durationMs: 2333 }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-09-08T08:48:16.272Z', durationMs: 7863, durationApiMs: 6770 }),
      event({ id: 'session-end', kind: 'hook', stage: 'hook_response', ts: '2026-09-08T08:48:16.318Z', durationMs: 42 }),
      event({ id: 'diff', kind: 'harness', stage: 'turn_diff', ts: '2026-09-08T08:49:00.000Z' })
    ]
    expect(buildTurnTimingBreakdown(items, []).turnWall).toEqual({ durationMs: 14318, source: 'estimated' })
    const html = render(items)
    expect(html).toContain('整轮耗时</span><b>14s</b>')
    expect(html).not.toContain('整轮耗时（估算）')
    expect(html).not.toContain('<b>~14s</b>')
    expect(html).toContain('title="历史记录估算')
    expect(html).not.toContain('<b>1.1s</b>')
  })

  it('does not invent a full-turn boundary from a lone result or unfinished run', () => {
    for (const items of [
      [],
      [event({ id: 'result', kind: 'harness', stage: 'result', durationMs: 10000, durationApiMs: 5000 })],
      [event({ id: 'start', kind: 'harness', stage: 'runtime:controls' }), event({ id: 'hook', kind: 'hook', stage: 'hook_started', ts: '2026-07-18T00:00:03.000Z' })]
    ]) {
      expect(buildTurnTimingBreakdown(items, []).turnWall).toBeUndefined()
      expect(render(items)).toContain('整轮耗时</span><b>—</b>')
    }
  })

  it('retains the settled boundary for interrupted runs without a Provider result', () => {
    const html = render([event({ id: 'wall', kind: 'harness', stage: 'runtime:turn_wall', durationMs: 2500 })])
    expect(html).toContain('整轮耗时</span><b>2.5s</b>')
    expect(html).not.toContain('Provider 结果时长')
    expect(html).not.toContain('<b>0ms</b>')
  })

  it('preserves Provider cumulative API values even if larger than the full turn', () => {
    const html = render([
      event({ id: 'result', kind: 'harness', stage: 'result', durationMs: 10000, durationApiMs: 12000 }),
      event({ id: 'wall', kind: 'harness', stage: 'runtime:turn_wall', durationMs: 11000 })
    ])
    expect(html).toContain('整轮耗时</span><b>11s</b>')
    expect(html).toContain('Provider API 耗时</span><b>12s</b>')
    expect(html).not.toContain('<b>0ms</b>')
  })

  it('keeps concurrent response observations separate without computing non-model residuals', () => {
    const html = render([
      event({ id: 'root', kind: 'model', stage: 'response_completed', messageId: 'root', ts: '2026-07-18T00:00:02.000Z', durationMs: 2000 }),
      event({ id: 'child', kind: 'model', stage: 'response_completed', messageId: 'child', agentId: 'child', parentToolUseId: 'spawn', ts: '2026-07-18T00:00:04.000Z', durationMs: 3000 }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:06.000Z', durationMs: 6000 })
    ])
    expect(html).toContain('模型耗时观测 / 估算</span><b>~4.0s</b>')
    expect(html).not.toContain('非模型耗时</span>')
  })
})
