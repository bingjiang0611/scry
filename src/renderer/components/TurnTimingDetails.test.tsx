import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TraceEvent } from '@shared/trace'
import { buildTurnTimingBreakdown } from '../turn-timing'
import { TurnTimingDetails } from './TurnTimingDetails'

function event(partial: Partial<TraceEvent> & Pick<TraceEvent, 'id' | 'kind' | 'stage'>): TraceEvent {
  return { ts: '2026-07-18T00:00:00.000Z', runId: 'run-1', ...partial }
}

describe('TurnTimingDetails', () => {
  it('展示 SDK API 合计、类型聚合、精简模型等待秒数和可跳转调用', () => {
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
    expect(html).toContain('按类型累计')
    expect(html).toContain('Read')
    expect(html).toContain('Write')
    expect(html).toContain('模型等待时间线')
    expect(html).toContain('>0.0s</b>')
    expect(html).toContain('>2.0s</b>')
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('aria-label="第 2 次模型响应前观测间隔 2.0s"')
    expect(html).not.toContain('响应 01')
    expect(html).not.toContain('模型响应</span>')
    expect(html).not.toContain('~等待')
    expect(html).not.toContain('观测区间')
    expect(html).not.toContain('本次响应后的调用 · 完成后进入下一次模型请求')
    expect(html).not.toContain('尾段未细分')
    expect(html).toContain('aria-label="跳到 Read 调用，观测耗时约 3.0s"')
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

  it('API 合计缺失时说明未上报，并单列未绑定与子 Agent 调用', () => {
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

    expect(html).toContain('模型 API 合计')
    expect(html).toContain('未上报')
    expect(html).toContain('未绑定模型响应')
    expect(html).toContain('workflow-orchestrator')
    expect(html).toContain('子 Agent 内部调用')
    expect(html).toContain('不与主会话模型响应串联')
  })
})
