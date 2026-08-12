import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { buildTurnTimingBreakdown } from './turn-timing'

function event(partial: Partial<TraceEvent> & Pick<TraceEvent, 'id' | 'kind' | 'stage'>): TraceEvent {
  return { ts: '2026-07-18T00:00:00.000Z', runId: 'run-1', ...partial }
}

describe('buildTurnTimingBreakdown', () => {
  it('配对工具墙钟、按类型聚合，并保留 Provider 原生 duration', () => {
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
      event({ id: 'write-result', kind: 'tool', stage: 'tool_result', toolUseId: 'write', ts: '2026-07-18T00:00:09.000Z', durationMs: 2500 }),
      event({
        id: 'result',
        kind: 'harness',
        stage: 'result',
        ts: '2026-07-18T00:00:12.000Z',
        durationMs: 12_000,
        durationApiMs: 4_200
      })
    ]

    const timing = buildTurnTimingBreakdown(items, [read, write])
    expect(timing).toMatchObject({
      wallMs: 12_000,
      apiMs: 4_200,
      apiSource: 'provider',
      timedApiPhases: 2,
      totalApiPhases: 2,
      totalCalls: 2,
      timedCalls: 2,
      cumulativeCallMs: 5_500
    })
    expect(timing.aggregates).toEqual([
      { category: 'Read', count: 1, timedCount: 1, totalMs: 3000, averageMs: 3000, maxMs: 3000 },
      { category: 'Write', count: 1, timedCount: 1, totalMs: 2500, averageMs: 2500, maxMs: 2500 }
    ])
    expect(timing.phases[0].observedMs).toBe(0)
    expect(timing.phases[1].observedMs).toBe(2000)
    expect(timing.phases[0]).toMatchObject({ toolMs: 3000, timedTools: 1 })
    expect(timing.phases[1]).toMatchObject({ toolMs: 4000, timedTools: 1 })
    expect(timing.phases[0].callsAfterResponse[0].durationSource).toBe('observed')
    expect(timing.phases[1].callsAfterResponse[0].durationSource).toBe('provider')
  })

  it('同一模型响应的并行工具归为一批，并区分累计、占用与重叠', () => {
    const read = event({ id: 'read', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read', messageId: 'msg-parallel' })
    const grep = event({
      id: 'grep',
      kind: 'tool',
      stage: 'tool:Grep',
      tool: 'Grep',
      toolUseId: 'grep',
      messageId: 'msg-parallel',
      ts: '2026-07-18T00:00:01.000Z'
    })
    const items = [
      read,
      grep,
      event({ id: 'read-result', kind: 'tool', stage: 'tool_result', toolUseId: 'read', ts: '2026-07-18T00:00:05.000Z' }),
      event({ id: 'grep-result', kind: 'tool', stage: 'tool_result', toolUseId: 'grep', ts: '2026-07-18T00:00:04.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:06.000Z', durationMs: 6000 })
    ]

    const timing = buildTurnTimingBreakdown(items, [read, grep])
    expect(timing.phases[0].callsAfterResponse.map((call) => call.category)).toEqual(['Read', 'Grep'])
    expect(timing.phases[0].toolMs).toBe(5000)
    expect(timing.cumulativeCallMs).toBe(8000)
    expect(timing.occupiedCallMs).toBe(5000)
    expect(timing.overlapCallMs).toBe(3000)
  })

  it('缺少结果、非法时间和推断 Skill 只降低覆盖率，不生成假耗时', () => {
    const read = event({ id: 'read', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'missing', ts: 'not-a-date' })
    const skill = event({ id: 'skill', kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator', ts: '2026-07-18T00:00:01.000Z' })
    const negative = event({
      id: 'write',
      kind: 'tool',
      stage: 'tool:Write',
      tool: 'Write',
      toolUseId: 'negative',
      ts: '2026-07-18T00:00:05.000Z'
    })
    const items = [
      read,
      skill,
      negative,
      event({ id: 'negative-result', kind: 'tool', stage: 'tool_result', toolUseId: 'negative', ts: '2026-07-18T00:00:04.000Z' })
    ]

    const timing = buildTurnTimingBreakdown(items, [read, skill, negative])
    expect(timing.totalCalls).toBe(3)
    expect(timing.timedCalls).toBe(0)
    expect(timing.cumulativeCallMs).toBe(0)
    expect(timing.aggregates.find((row) => row.category === 'Skill')).toMatchObject({ count: 1, timedCount: 0, totalMs: 0 })
    expect(timing.phases[0].kind).toBe('unsegmented')
    expect(timing.phases[0].observedMs).toBeUndefined()
  })

  it('MCP/Skill/子Agent 分开聚合，整轮 API 只保留合计而不分摊到响应段', () => {
    const mcp = event({
      id: 'mcp',
      kind: 'tool',
      stage: 'tool:mcp__tracker__query',
      tool: 'mcp__tracker__query',
      toolUseId: 'mcp',
      messageId: 'msg-1',
      isMcp: true,
      mcpServer: 'tracker',
      mcpAction: 'query'
    })
    const skill = event({ id: 'skill', kind: 'skill', stage: 'skill:rate', name: 'rate', toolUseId: 'skill', messageId: 'msg-1' })
    const agent = event({ id: 'agent', kind: 'agent', stage: 'agent:review', name: 'review', toolUseId: 'agent', messageId: 'msg-1' })
    const items = [
      mcp,
      skill,
      agent,
      ...[mcp, skill, agent].map((call, index) =>
        event({
          id: `${call.id}-result`,
          kind: 'tool',
          stage: 'tool_result',
          toolUseId: call.toolUseId,
          ts: `2026-07-18T00:00:0${index + 1}.000Z`
        })
      ),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:05.000Z', durationMs: 5000, durationApiMs: 2500 })
    ]

    const timing = buildTurnTimingBreakdown(items, [mcp, skill, agent])
    expect(timing.aggregates.map((row) => row.category)).toEqual(['子Agent', 'Skill', 'MCP'])
    expect(timing.apiMs).toBe(2500)
    expect(timing.phases.every((phase) => !('apiMs' in phase))).toBe(true)
  })

  it('路径推断 Skill 与真实工具共享 toolUseId 时只计一次生命周期耗时', () => {
    const inferredSkill = event({
      id: 'skill-evidence',
      kind: 'skill',
      stage: 'skill:browser-use',
      name: 'browser-use',
      toolUseId: 'shared',
      messageId: 'msg-1',
      input: { source: 'skill_path_in_bash' }
    })
    const bash = event({
      id: 'bash',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'shared',
      messageId: 'msg-1'
    })
    const items = [
      inferredSkill,
      bash,
      event({ id: 'result', kind: 'tool', stage: 'tool_result', toolUseId: 'shared', ts: '2026-07-18T00:00:02.000Z' })
    ]

    const timing = buildTurnTimingBreakdown(items, [inferredSkill, bash])
    expect(timing).toMatchObject({ totalCalls: 2, timedCalls: 1, cumulativeCallMs: 2000 })
    expect(timing.aggregates.find((row) => row.category === 'Skill')).toMatchObject({ count: 1, timedCount: 0, totalMs: 0 })
    expect(timing.aggregates.find((row) => row.category === 'Bash')).toMatchObject({ count: 1, timedCount: 1, totalMs: 2000 })
  })

  it('响应边界采用完整 assistant message 的最晚事件，并把真实最终文本与运行收尾分开', () => {
    const read = event({
      id: 'read',
      kind: 'tool',
      stage: 'tool:Read',
      tool: 'Read',
      toolUseId: 'read',
      messageId: 'msg-1',
      ts: '2026-07-18T00:00:01.000Z'
    })
    const items = [
      read,
      event({ id: 'message-text', kind: 'model', stage: 'text', messageId: 'msg-1', ts: '2026-07-18T00:00:02.000Z' }),
      event({ id: 'read-result', kind: 'tool', stage: 'tool_result', toolUseId: 'read', ts: '2026-07-18T00:00:04.000Z' }),
      event({ id: 'final-text', kind: 'model', stage: 'text', messageId: 'msg-2', ts: '2026-07-18T00:00:10.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:12.000Z', durationMs: 12_000 })
    ]

    const timing = buildTurnTimingBreakdown(items, [read])
    expect(timing.phases).toMatchObject([
      { kind: 'response', observedMs: 2000 },
      { kind: 'final', observedMs: 6000 },
      { kind: 'tail', tailMode: 'cleanup', observedMs: 2000 }
    ])
  })

  it('共享 toolUseId 取真实 lifecycle owner 的结束时间计算下一次模型等待', () => {
    const inferredSkill = event({
      id: 'skill-evidence',
      kind: 'skill',
      stage: 'skill:browser-use',
      name: 'browser-use',
      toolUseId: 'shared',
      messageId: 'msg-1'
    })
    const bash = event({
      id: 'bash',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'shared',
      messageId: 'msg-1'
    })
    const items = [
      inferredSkill,
      bash,
      event({ id: 'bash-result', kind: 'tool', stage: 'tool_result', toolUseId: 'shared', ts: '2026-07-18T00:00:02.000Z' }),
      event({ id: 'final', kind: 'model', stage: 'text', messageId: 'msg-2', ts: '2026-07-18T00:00:05.000Z' })
    ]

    const timing = buildTurnTimingBreakdown(items, [inferredSkill, bash])
    expect(timing.phases[1]).toMatchObject({ kind: 'final', observedMs: 3000 })
  })

  it('主会话与子 Agent 分 lane，子 Agent 调用计入聚合但不串进主模型间隔', () => {
    const agent = event({
      id: 'agent',
      kind: 'agent',
      stage: 'agent:review',
      name: 'review',
      toolUseId: 'agent',
      messageId: 'msg-main',
      ts: '2026-07-18T00:00:01.000Z'
    })
    const childRead = event({
      id: 'child-read',
      kind: 'tool',
      stage: 'tool:Read',
      tool: 'Read',
      toolUseId: 'child-read',
      parentToolUseId: 'agent',
      agentId: 'child-1',
      messageId: 'msg-child',
      ts: '2026-07-18T00:00:02.000Z'
    })
    const items = [
      agent,
      childRead,
      event({ id: 'child-result', kind: 'tool', stage: 'tool_result', toolUseId: 'child-read', ts: '2026-07-18T00:00:03.000Z' }),
      event({ id: 'agent-result', kind: 'tool', stage: 'tool_result', toolUseId: 'agent', ts: '2026-07-18T00:00:10.000Z' }),
      event({ id: 'final', kind: 'model', stage: 'text', messageId: 'msg-final', ts: '2026-07-18T00:00:12.000Z' })
    ]

    const timing = buildTurnTimingBreakdown(items, [agent, childRead])
    expect(timing.phases.map((phase) => phase.messageId).filter(Boolean)).toEqual(['msg-main', 'msg-final'])
    expect(timing.phases[1]).toMatchObject({ kind: 'final', observedMs: 2000 })
    expect(timing.nestedCalls.map((call) => call.id)).toEqual(['child-read'])
    expect(timing.totalCalls).toBe(2)
  })

  it('无 messageId 的调用不猜测归属，保留在未绑定列表', () => {
    const inferred = event({
      id: 'skill-injection',
      kind: 'skill',
      stage: 'skill:workflow-orchestrator',
      name: 'workflow-orchestrator',
      ts: '2026-07-18T00:00:00.500Z'
    })
    const read = event({
      id: 'read',
      kind: 'tool',
      stage: 'tool:Read',
      tool: 'Read',
      toolUseId: 'read',
      messageId: 'msg-1',
      ts: '2026-07-18T00:00:01.000Z'
    })
    const items = [
      inferred,
      read,
      event({ id: 'read-result', kind: 'tool', stage: 'tool_result', toolUseId: 'read', ts: '2026-07-18T00:00:03.000Z' })
    ]

    const timing = buildTurnTimingBreakdown(items, [inferred, read])
    expect(timing.unassignedCalls.map((call) => call.id)).toEqual(['skill-injection'])
    expect(timing.phases[0].callsAfterResponse.map((call) => call.id)).toEqual(['read'])
  })

  it('使用上层合并后的 result，避免历史尾部 usage 事件抹掉墙钟与 API 合计', () => {
    const archivedResult = event({
      id: 'archive-result',
      kind: 'harness',
      stage: 'result',
      ts: '2026-07-18T00:00:10.000Z',
      durationMs: 10_000,
      durationApiMs: 4200
    })
    const transcriptUsage = event({
      id: 'usage-result',
      kind: 'harness',
      stage: 'result',
      text: 'transcript assistant usage',
      ts: '2026-07-18T00:00:11.000Z'
    })

    const timing = buildTurnTimingBreakdown([archivedResult, transcriptUsage], [], archivedResult)
    expect(timing).toMatchObject({ wallMs: 10_000, apiMs: 4200, apiSource: 'provider' })
  })

  it('uses observed root and subagent response calls instead of the unsegmented residual', () => {
    const response = (
      id: string,
      completedAt: string,
      durationMs: number,
      agentId?: string
    ): TraceEvent => event({
      id,
      kind: 'model',
      stage: 'response_completed',
      ts: completedAt,
      messageId: id,
      durationMs,
      ...(agentId ? { agentId, parentToolUseId: 'spawn-1' } : {}),
      runtimeMetadata: { timingSource: 'observed', timingBoundary: 'turn_or_activity_end' }
    })
    const items = [
      response('root-1', '2026-07-18T00:00:02.000Z', 2_000),
      response('child-1', '2026-07-18T00:00:04.000Z', 3_000, 'child-thread'),
      response('root-2', '2026-07-18T00:00:07.000Z', 3_000),
      event({
        id: 'result',
        kind: 'harness',
        stage: 'result',
        ts: '2026-07-18T00:00:08.000Z',
        durationMs: 8_000
      })
    ]

    expect(buildTurnTimingBreakdown(items, [])).toMatchObject({
      wallMs: 8_000,
      apiMs: 8_000,
      apiSource: 'observed',
      apiObservation: 'response',
      timedApiPhases: 3,
      totalApiPhases: 3,
      cumulativeApiMs: 8_000,
      occupiedApiMs: 7_000,
      overlapApiMs: 1_000,
      rootApiMs: 5_000,
      nestedApiMs: 3_000
    })
  })

  it('Provider 未上报 API 耗时时回退到可确认的模型响应观测区间', () => {
    const bash = event({
      id: 'bash',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'bash',
      messageId: 'msg-1',
      ts: '2026-07-18T00:00:02.000Z'
    })
    const items = [
      bash,
      event({ id: 'bash-result', kind: 'tool', stage: 'tool_result', toolUseId: 'bash', ts: '2026-07-18T00:00:05.000Z' }),
      event({ id: 'final', kind: 'model', stage: 'text', messageId: 'msg-2', ts: '2026-07-18T00:00:09.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:10.000Z', durationMs: 10_000 })
    ]

    const timing = buildTurnTimingBreakdown(items, [bash])
    expect(timing).toMatchObject({
      apiMs: 6000,
      apiSource: 'observed',
      apiObservation: 'phase',
      timedApiPhases: 2,
      totalApiPhases: 2
    })
  })

  it('缺少 messageId 时用整轮非工具余量估计 API，不伪造成原生值', () => {
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

    const timing = buildTurnTimingBreakdown(items, [bash])
    expect(timing).toMatchObject({
      wallMs: 10_000,
      apiMs: 7000,
      apiSource: 'observed',
      apiObservation: 'residual',
      timedApiPhases: 1,
      totalApiPhases: 1
    })
    expect(timing.phases[0]).toMatchObject({ kind: 'unsegmented', observedMs: 7000, toolMs: 3000 })
  })

  it('活动区间超出整轮窗口时标记数据异常，不把负余量截成零', () => {
    const bash = event({
      id: 'bash',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'bash',
      ts: '2026-07-18T00:00:00.000Z'
    })
    const items = [
      bash,
      event({ id: 'bash-result', kind: 'tool', stage: 'tool_result', toolUseId: 'bash', ts: '2026-07-18T00:00:07.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:10.000Z', durationMs: 5_000 })
    ]

    const timing = buildTurnTimingBreakdown(items, [bash])
    expect(timing).toMatchObject({
      wallMs: 5_000,
      occupiedCallMs: 7_000,
      wallConsistency: 'invalid',
      apiSource: 'unknown'
    })
    expect(timing.apiMs).toBeUndefined()
    expect(timing.phases[0].observedMs).toBeUndefined()
  })

  it('活动占用未超过 wall 但时间戳落在整轮窗口外时仍标记异常', () => {
    const read = event({
      id: 'read',
      kind: 'tool',
      stage: 'tool:Read',
      tool: 'Read',
      toolUseId: 'read',
      ts: '2026-07-18T00:00:00.000Z'
    })
    const items = [
      read,
      event({ id: 'read-result', kind: 'tool', stage: 'tool_result', toolUseId: 'read', ts: '2026-07-18T00:00:02.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:10.000Z', durationMs: 5_000 })
    ]

    expect(buildTurnTimingBreakdown(items, [read])).toMatchObject({
      wallMs: 5_000,
      occupiedCallMs: 2_000,
      wallConsistency: 'invalid',
      apiSource: 'unknown'
    })
  })

  it('Provider API 时长超过整轮墙钟时标记数据异常', () => {
    const items = [
      event({
        id: 'result',
        kind: 'harness',
        stage: 'result',
        ts: '2026-07-18T00:00:10.000Z',
        durationMs: 10_000,
        durationApiMs: 12_000
      })
    ]

    expect(buildTurnTimingBreakdown(items, [])).toMatchObject({
      wallMs: 10_000,
      wallConsistency: 'invalid',
      apiSource: 'unknown',
      apiMs: undefined
    })
  })

  it('纯文本轮也消费 recorder 的 residual 兜底，不把已有估算显示成未采集', () => {
    const items = [
      event({
        id: 'result',
        kind: 'harness',
        stage: 'result',
        ts: '2026-07-18T00:00:10.000Z',
        durationMs: 10_000
      })
    ]

    expect(buildTurnTimingBreakdown(items, [])).toMatchObject({
      wallMs: 10_000,
      apiMs: 10_000,
      apiSource: 'observed',
      apiObservation: 'residual'
    })
  })

  it('倒序结果时间不污染 lifecycle；非法 result duration 会回退到调用原生 duration', () => {
    const write = event({
      id: 'write',
      kind: 'tool',
      stage: 'tool:Write',
      tool: 'Write',
      toolUseId: 'write',
      messageId: 'msg-1',
      ts: '2026-07-18T00:00:05.000Z',
      durationMs: 2000
    })
    const items = [
      write,
      event({
        id: 'write-result',
        kind: 'tool',
        stage: 'tool_result',
        toolUseId: 'write',
        ts: '2026-07-18T00:00:04.000Z',
        durationMs: -1
      }),
      event({ id: 'final', kind: 'model', stage: 'text', messageId: 'msg-2', ts: '2026-07-18T00:00:10.000Z' })
    ]

    const timing = buildTurnTimingBreakdown(items, [write])
    expect(timing).toMatchObject({ timedCalls: 1, cumulativeCallMs: 2000, occupiedCallMs: 2000 })
    expect(timing.phases[1]).toMatchObject({ kind: 'final', observedMs: 3000 })
  })

  it('工具后直接结束时只显示未细分尾段，不伪造最终模型响应', () => {
    const bash = event({
      id: 'bash',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'bash',
      messageId: 'msg-1',
      ts: '2026-07-18T00:00:01.000Z'
    })
    const items = [
      bash,
      event({ id: 'bash-result', kind: 'tool', stage: 'tool_result', toolUseId: 'bash', ts: '2026-07-18T00:00:03.000Z' }),
      event({ id: 'result', kind: 'harness', stage: 'result', ts: '2026-07-18T00:00:04.000Z', durationMs: 4000 })
    ]

    const timing = buildTurnTimingBreakdown(items, [bash])
    expect(timing.phases.map((phase) => phase.kind)).toEqual(['response', 'tail'])
    expect(timing.phases[1]).toMatchObject({ tailMode: 'unknown', observedMs: 1000 })
  })
})
