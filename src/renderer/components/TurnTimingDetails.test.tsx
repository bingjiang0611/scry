import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TraceEvent } from '@shared/trace'
import { buildTurnTimingBreakdown } from '../turn-timing'
import { TurnTimingDetails } from './TurnTimingDetails'

function event(partial: Partial<TraceEvent> & Pick<TraceEvent, 'id' | 'kind' | 'stage'>): TraceEvent {
  return { ts: '2026-07-18T00:00:00.000Z', runId: 'run-1', ...partial }
}

describe('TurnTimingDetails', () => {
  it('只展示模型响应耗时与非模型耗时，并按整轮墙钟互斥划分', () => {
    const read = event({ id: 'read', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read' })
    const write = event({
      id: 'write', kind: 'tool', stage: 'tool:Write', tool: 'Write', toolUseId: 'write',
      ts: '2026-07-18T00:00:05.000Z'
    })
    const items = [
      read,
      event({ id: 'read-result', kind: 'tool', stage: 'tool_result', toolUseId: 'read', ts: '2026-07-18T00:00:03.000Z' }),
      write,
      event({ id: 'write-result', kind: 'tool', stage: 'tool_result', toolUseId: 'write', ts: '2026-07-18T00:00:08.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:10.000Z', durationMs: 10_000, durationApiMs: 4200 })
    ]
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown(items, [read, write])} />
    )

    expect(html).toContain('耗时明细')
    expect(html).toContain('两类墙钟')
    expect(html).toContain('模型响应耗时</span><b>4.2s</b><em>SDK 原值')
    expect(html).toContain('非模型耗时</span><b>5.8s</b><em>整轮剩余')
    expect(html).toContain('两项可相加')
    expect(html).not.toContain('整轮墙钟</span>')
    expect(html).not.toContain('可计时调用')
    expect(html).not.toContain('按类型累计')
    expect(html).not.toContain('耗时归因时间线')
    expect(html).not.toContain('turn-timing-aggregate')
    expect(html).not.toContain('子 Agent 内部调用</span>')
  })

  it('模型响应存在并发时使用区间并集，不再展示累计与重叠', () => {
    const items = [
      event({
        id: 'root-response', kind: 'model', stage: 'response_completed', messageId: 'response-root',
        ts: '2026-07-18T00:00:02.000Z', durationMs: 2_000
      }),
      event({
        id: 'child-response', kind: 'model', stage: 'response_completed', messageId: 'response-child',
        agentId: 'child', parentToolUseId: 'spawn-1', ts: '2026-07-18T00:00:04.000Z', durationMs: 3_000
      }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:06.000Z', durationMs: 6_000 })
    ]
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown(items, [])} />
    )

    expect(html).toContain('模型响应耗时</span><b>~4.0s</b><em>~观测')
    expect(html).toContain('非模型耗时</span><b>2.0s</b><em>整轮剩余')
    expect(html).not.toContain('累计 5.0s')
    expect(html).not.toContain('重叠 1.0s')
  })

  it('调用缺少生命周期时不制造耗时', () => {
    const skill = event({ id: 'skill', kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator' })
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown([skill], [skill])} />
    )

    expect(html).toContain('模型响应耗时</span><b>—</b><em>未采集')
    expect(html).toContain('非模型耗时</span><b>—</b><em>未计时')
    expect(html).not.toContain('0ms')
  })

  it('缺少响应边界时保留模型估算，并把墙钟余量归入非模型耗时', () => {
    const bash = event({
      id: 'bash', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'bash',
      ts: '2026-07-18T00:00:02.000Z'
    })
    const items = [
      bash,
      event({ id: 'bash-result', kind: 'tool', stage: 'tool_result', toolUseId: 'bash', ts: '2026-07-18T00:00:05.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:10.000Z', durationMs: 10_000 })
    ]
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown(items, [bash])} />
    )

    expect(html).toContain('模型响应耗时</span><b>~7.0s</b><em>~估算')
    expect(html).toContain('非模型耗时</span><b>3.0s</b><em>整轮剩余')
    expect(html).not.toContain('模型相关耗时估算</span>')
  })

  it('没有工具调用时明确显示零耗时', () => {
    const timing = buildTurnTimingBreakdown([], [])
    const html = renderToStaticMarkup(<TurnTimingDetails timing={timing} />)

    expect(html).toContain('非模型耗时</span><b>0ms</b><em>本轮无工具调用')
  })

  it('整轮墙钟与活动区间冲突时显示数据异常，不显示模型零与非模型全墙钟', () => {
    const bash = event({
      id: 'bash', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'bash',
      ts: '2026-07-18T00:00:00.000Z'
    })
    const items = [
      bash,
      event({ id: 'bash-result', kind: 'tool', stage: 'tool_result', toolUseId: 'bash', ts: '2026-07-18T00:00:07.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:10.000Z', durationMs: 5_000 })
    ]
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown(items, [bash])} />
    )

    expect(html).toContain('模型响应耗时</span><b>—</b><em>数据异常')
    expect(html).toContain('非模型耗时</span><b>—</b><em>数据异常')
    expect(html).toContain('整轮墙钟与活动时间不一致')
    expect(html).not.toContain('<b>0ms</b>')
    expect(html).not.toContain('<b>5.0s</b>')
  })

  it('Provider API 时长超过整轮墙钟时不静默截断', () => {
    const timing = buildTurnTimingBreakdown([
      event({
        id: 'result', kind: 'harness', stage: 'result',
        ts: '2026-07-18T00:00:10.000Z', durationMs: 10_000, durationApiMs: 12_000
      })
    ], [])
    const html = renderToStaticMarkup(<TurnTimingDetails timing={timing} />)

    expect(html).toContain('模型响应耗时</span><b>—</b><em>数据异常')
    expect(html).toContain('非模型耗时</span><b>—</b><em>数据异常')
    expect(html).not.toContain('<b>10.0s</b>')
    expect(html).not.toContain('<b>12.0s</b>')
  })
})
