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
  it('Provider 原值与算术差独立展示，不冒充模型 / 非模型墙钟', () => {
    const html = render([
      event({ id: 'result', kind: 'harness', stage: 'result', durationMs: 10_000, durationApiMs: 4200 })
    ])
    expect(html).toContain('独立计时口径')
    expect(html).toContain('Provider 结果时长</span><b>10s</b><em>结果计时')
    expect(html).toContain('Provider API 耗时</span><b>4.2s</b><em>结果上报 / 聚合')
    expect(html).toContain('Provider 计时余量</span><b>5.8s</b><em>结果时长 − API')
    expect(html).not.toContain('两类墙钟')
    expect(html).not.toContain('非模型耗时</span>')
    expect(html).not.toContain('两项可相加')
  })

  it('真实 Qoder 边界：前置和收尾 Hook 不在 SDK 内部计时内，1.1s 不是 Hook 预算', () => {
    // 脱敏自 2026-09-08 的日志：Hook 共约 3.82s，SDK result 却只有 7.863s / 6.770s。
    const items = [
      event({ id: 'session-start', kind: 'hook', stage: 'hook_started', ts: '2026-09-08T08:48:03.836Z' }),
      event({ id: 'prompt-start', kind: 'hook', stage: 'hook_started', ts: '2026-09-08T08:48:04.358Z' }),
      event({ id: 'prompt-end', kind: 'hook', stage: 'hook_response', ts: '2026-09-08T08:48:06.691Z', durationMs: 2333 }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-09-08T08:48:16.272Z', durationMs: 7863, durationApiMs: 6770 }),
      event({ id: 'session-end', kind: 'hook', stage: 'hook_response', ts: '2026-09-08T08:48:16.318Z', durationMs: 42 })
    ]
    expect(buildTurnTimingBreakdown(items, []).providerTiming).toEqual({ totalMs: 7863, apiMs: 6770 })
    const html = render(items)
    expect(html).toContain('Provider 结果时长</span><b>7.9s')
    expect(html).toContain('Provider API 耗时</span><b>6.8s')
    expect(html).toContain('Provider 计时余量</span><b>1.1s')
    expect(html).toContain('不保证覆盖前置、收尾 Hook')
    expect(html).toContain('不能直接相加对账')
    expect(html).not.toContain('非模型耗时</span>')
  })

  it('模型响应并发使用区间并集，但不与 Provider 总时长混算余量', () => {
    const html = render([
      event({ id: 'root', kind: 'model', stage: 'response_completed', messageId: 'root', ts: '2026-07-18T00:00:02.000Z', durationMs: 2000 }),
      event({ id: 'child', kind: 'model', stage: 'response_completed', messageId: 'child', agentId: 'child', parentToolUseId: 'spawn', ts: '2026-07-18T00:00:04.000Z', durationMs: 3000 }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:06.000Z', durationMs: 6000 })
    ])
    expect(html).toContain('模型耗时观测 / 估算</span><b>~4.0s</b><em>~响应区间观测')
    expect(html).toContain('Provider 计时余量</span><b>—</b><em>缺少结果计时')
    expect(html).not.toContain('<b>2.0s</b>')
  })

  it.each([{ items: [] }, { items: [event({ id: 'skill', kind: 'skill', stage: 'skill:workflow', name: 'workflow' })] }])(
    '缺少可靠计时，即使没有工具也不显示零非模型耗时', ({ items }) => {
      const html = render(items, items)
      expect(html).toContain('Provider 结果时长</span><b>—</b>')
      expect(html).toContain('模型耗时观测 / 估算</span><b>—</b>')
      expect(html).toContain('Provider 计时余量</span><b>—</b>')
      expect(html).not.toContain('<b>0ms</b>')
    }
  )

  it('只有 API 原值时不制造总时长或余量', () => {
    const html = render([event({ id: 'result', kind: 'harness', stage: 'result', durationApiMs: 4200 })])
    expect(html).toContain('Provider API 耗时</span><b>4.2s</b><em>结果上报 / 聚合')
    expect(html).toContain('Provider 结果时长</span><b>—</b>')
    expect(html).toContain('Provider 计时余量</span><b>—</b>')
  })

  it('活动区间超出 SDK 范围时仍展示原值，不捏造整轮划分', () => {
    const bash = event({ id: 'bash', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'bash' })
    const items = [
      bash,
      event({ id: 'bash-result', kind: 'tool', stage: 'tool_result', toolUseId: 'bash', ts: '2026-07-18T00:00:07.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:10.000Z', durationMs: 5000, durationApiMs: 3000 })
    ]
    expect(buildTurnTimingBreakdown(items, [bash]).wallConsistency).toBe('invalid')
    const html = render(items, [bash])
    expect(html).toContain('Provider 结果时长</span><b>5.0s</b><em>结果计时')
    expect(html).toContain('Provider API 耗时</span><b>3.0s</b><em>结果上报 / 聚合')
    expect(html).toContain('暂不划分整轮模型 / 非模型墙钟')
  })

  it('API 超过总时长时保留原值，但不截断或显示负余量', () => {
    const html = render([event({ id: 'result', kind: 'harness', stage: 'result', durationMs: 10_000, durationApiMs: 12_000 })])
    expect(html).toContain('Provider 结果时长</span><b>10s')
    expect(html).toContain('Provider API 耗时</span><b>12s')
    expect(html).toContain('Provider 计时余量</span><b>—</b><em>不可相减')
    expect(html).toContain('可能存在累计或计时口径差异')
    expect(html).not.toContain('<b>0ms</b>')
  })
})
