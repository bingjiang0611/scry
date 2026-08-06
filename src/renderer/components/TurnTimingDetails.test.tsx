import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TraceEvent } from '@shared/trace'
import { buildTurnTimingBreakdown } from '../turn-timing'
import { TurnTimingDetails } from './TurnTimingDetails'

function event(partial: Partial<TraceEvent> & Pick<TraceEvent, 'id' | 'kind' | 'stage'>): TraceEvent {
  return { ts: '2026-07-18T00:00:00.000Z', runId: 'run-1', ...partial }
}

describe('TurnTimingDetails', () => {
  it('展示 SDK API 合计、去重调用耗时、类型累计，以及模型 API / 工具调用两类时间线', () => {
    const read = event({ id: 'read', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read', messageId: 'msg-1' })
    const write = event({
      id: 'write',
      kind: 'tool',
      stage: 'tool:Write',
      tool: 'Write',
      toolUseId: 'write',
      messageId: 'msg-2',
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
      <TurnTimingDetails timing={buildTurnTimingBreakdown(items, [read, write])} onOpenCall={() => {}} />
    )

    expect(html).toContain('耗时明细')
    expect(html).toContain('模型 API 合计')
    expect(html).toContain('4.2s')
    expect(html).toContain('2/2')
    expect(html).toContain('调用耗时')
    expect(html).toContain('去重墙钟')
    expect(html).toContain('按类型累计')
    expect(html).toContain('累计 6.0s · 无重叠')
    expect(html).toContain('Read')
    expect(html).toContain('Write')
    expect(html).toContain('耗时归因时间线')
    expect(html).toContain('turn-timing-timeline-block" open=""')
    expect(html).toContain('title="展开或收起耗时归因时间线"')
    expect(html).toContain('模型 API')
    expect(html).toContain('工具调用')
    expect(html).toContain('>~0.0s</b>')
    expect(html).toContain('>~2.0s</b>')
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('aria-label="第 2 次模型响应前 API 观测耗时约 2.0s"')
    expect(html).toContain('aria-label="1 次工具调用，耗时约 3.0s"')
    expect(html).not.toContain('响应 01')
    expect(html).not.toContain('模型响应</span>')
    expect(html).not.toContain('turn-timing-call-name')
  })

  it('把 Codex 根与子 Agent 响应显示为观测累计和去重占用，不再归入未归因耗时', () => {
    const items = [
      event({
        id: 'root-response',
        kind: 'model',
        stage: 'response_completed',
        messageId: 'response-root',
        ts: '2026-07-18T00:00:02.000Z',
        durationMs: 2_000
      }),
      event({
        id: 'child-response',
        kind: 'model',
        stage: 'response_completed',
        messageId: 'response-child',
        agentId: 'child',
        parentToolUseId: 'spawn-1',
        ts: '2026-07-18T00:00:04.000Z',
        durationMs: 3_000
      }),
      event({
        id: 'result',
        kind: 'harness',
        stage: 'result',
        ts: '2026-07-18T00:00:06.000Z',
        durationMs: 6_000
      })
    ]
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown(items, [])} />
    )

    expect(html).toContain('模型响应累计')
    expect(html).toContain('~5.0s')
    expect(html).toContain('~观测 · 2/2')
    expect(html).toContain('模型调用观测')
    expect(html).toContain('累计 5.0s · 占用 4.0s · 重叠 1.0s')
    expect(html).toContain('根 Agent')
    expect(html).toContain('子 Agent')
    expect(html).toContain('不等同于 Provider 服务端 latency')
    expect(html).not.toContain('未归因耗时')
  })

  it('无生命周期的 Skill 显示未计时，不制造 0ms', () => {
    const skill = event({ id: 'skill', kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator' })
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown([skill], [skill])} />
    )

    expect(html).toContain('1 次未计时')
    expect(html).toContain('未计时')
    expect(html).not.toContain('0ms')
  })

  it('API 原值缺失且无可确认区间时说明未采集，并单列未绑定与子 Agent 调用', () => {
    const main = event({
      id: 'main',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'main',
      messageId: 'msg-main'
    })
    const inferred = event({
      id: 'inferred',
      kind: 'skill',
      stage: 'skill:workflow-orchestrator',
      name: 'workflow-orchestrator',
      ts: '2026-07-18T00:00:00.500Z'
    })
    const nested = event({
      id: 'nested',
      kind: 'tool',
      stage: 'tool:Read',
      tool: 'Read',
      toolUseId: 'nested',
      messageId: 'msg-child',
      parentToolUseId: 'main',
      agentId: 'child',
      ts: '2026-07-18T00:00:01.000Z'
    })
    const items = [
      main,
      inferred,
      nested,
      event({ id: 'nested-result', kind: 'tool', stage: 'tool_result', toolUseId: 'nested', ts: '2026-07-18T00:00:02.000Z' }),
      event({ id: 'main-result', kind: 'tool', stage: 'tool_result', toolUseId: 'main', ts: '2026-07-18T00:00:03.000Z' })
    ]
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown(items, [main, inferred, nested])} />
    )

    expect(html).toContain('模型 API')
    expect(html).not.toContain('模型 API 观测')
    expect(html).toContain('未采集')
    expect(html).toContain('未绑定模型响应')
    expect(html).toContain('workflow-orchestrator')
    expect(html).toContain('子 Agent 内部调用')
    expect(html).toContain('主指标“调用耗时”会合并父子 Agent 的重叠区间')
  })

  it('无逐次响应边界时展示墙钟减调用占用的模型相关耗时估算', () => {
    const bash = event({
      id: 'bash',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'bash',
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

    expect(html).toContain('模型相关耗时估算')
    expect(html).toContain('~7.0s')
    expect(html).toContain('~估算 · 已计时 1/1')
    expect(html).toContain('aria-label="整轮模型相关耗时估算约 7.0s"')
    expect(html).toContain('aria-label="1 次工具调用，耗时约 3.0s"')
    expect(html).not.toContain('模型 API 合计')
  })

  it('调用耗时按区间去重，并在类型累计旁明确并行重叠', () => {
    const parent = event({
      id: 'parent',
      kind: 'agent',
      stage: 'agent:Task',
      name: 'reviewer',
      toolUseId: 'parent',
      ts: '2026-07-18T00:00:00.000Z'
    })
    const nested = event({
      id: 'nested',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'nested',
      parentToolUseId: 'parent',
      ts: '2026-07-18T00:00:02.000Z'
    })
    const items = [
      parent,
      nested,
      event({ id: 'nested-result', kind: 'tool', stage: 'tool_result', toolUseId: 'nested', ts: '2026-07-18T00:00:08.000Z' }),
      event({ id: 'parent-result', kind: 'tool', stage: 'tool_result', toolUseId: 'parent', ts: '2026-07-18T00:00:10.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:20.000Z', durationMs: 20_000 })
    ]
    const html = renderToStaticMarkup(
      <TurnTimingDetails timing={buildTurnTimingBreakdown(items, [parent, nested])} />
    )

    expect(html).toContain('调用耗时')
    expect(html).toContain('>10s</b>')
    expect(html).toContain('累计 16s · 重叠 6.0s')
    expect(html).toContain('主指标“调用耗时”会合并父子 Agent 的重叠区间')
  })
})
