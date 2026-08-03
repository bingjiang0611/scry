import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from './aggregate'

describe('aggregateTurnEvidence', () => {
  it('区分真实零调用与 Provider 不可观测', () => {
    const exact = aggregateTurnEvidence({ userText: 'hello', events: [], observable: { tools: true } })
    const unavailable = aggregateTurnEvidence({ userText: 'hello', events: [], observable: { tools: false } })
    expect(exact.tools).toEqual({ status: 'available', quality: 'exact', source: ['trace_events'], value: [] })
    expect(unavailable.tools).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
  })

  it('过滤 Recorder 自身 hook，并保留真实 hook', () => {
    const events: TraceEvent[] = [
      { id: '1', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookName: 'turn-recorder-v1', hookEvent: 'Stop', hookOutcome: 'success' },
      { id: '2', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookName: 'audit.py', hookEvent: 'Stop', hookOutcome: 'success' }
    ]
    expect(aggregateTurnEvidence({ events }).hooks.value).toEqual([
      expect.objectContaining({ name: 'audit.py', event: 'Stop', status: 'success' })
    ])
  })

  it('把同一 Hook 的 started/response 聚合为一个处理器实例', () => {
    const events: TraceEvent[] = [
      { id: 'start', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'hook', stage: 'hook_started', hookId: 'h1', hookName: 'audit.py', hookEvent: 'PreToolUse', hookOutcome: 'started' },
      { id: 'end', ts: '2026-01-01T00:00:00.025Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h1', hookName: 'audit.py', hookEvent: 'PreToolUse', hookOutcome: 'success', hookExitCode: 0 },
      { id: 'self', ts: '2026-01-01T00:00:00.030Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h2', hookName: 'command', hookEvent: 'PreToolUse', hookCommand: 'SCRY_HANDLER_ID=turn-recorder-v1 .claude/hooks/scry-recorder.sh claude PreToolUse', hookOutcome: 'success' }
    ]
    expect(aggregateTurnEvidence({ events }).hooks.value).toEqual([
      expect.objectContaining({
        id: 'h1',
        order: 0,
        lifecycleEvents: 2,
        name: 'audit.py',
        event: 'PreToolUse',
        status: 'success',
        durationMs: 25
      })
    ])
  })

  it('整轮 Usage 求和，并在原生聚合结果存在时忽略 transcript 影子值', () => {
    const transcript = (id: string, input: number): TraceEvent => ({
      id,
      ts: `2026-01-01T00:00:0${id}.000Z`,
      runId: 'r',
      kind: 'harness',
      stage: 'result',
      text: 'transcript assistant usage',
      tokensIn: input,
      tokensOut: 1
    })
    expect(aggregateTurnEvidence({ events: [transcript('1', 3), transcript('2', 4)] }).usage.value).toMatchObject({ inputTokens: 7, outputTokens: 2 })
    expect(aggregateTurnEvidence({ events: [
      transcript('1', 3),
      transcript('2', 4),
      {
        id: 'native',
        ts: '2026-01-01T00:00:03.000Z',
        runId: 'r',
        kind: 'harness',
        stage: 'result',
        tokensIn: 10,
        tokensOut: 5,
        durationApiMs: 123,
        contextTokens: 42,
        modelUsage: [{ model: 'fixture-model', contextWindow: 100, inputTokens: 10, outputTokens: 5 }]
      }
    ] }).usage.value).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      apiDurationMs: 123,
      contextTokens: 42,
      contextWindow: 100,
      model: 'fixture-model'
    })
  })

  it('把根与子 Agent 的观测模型调用聚合为累计耗时和去重墙钟', () => {
    const events: TraceEvent[] = [
      {
        id: 'root-1',
        ts: '2026-01-01T00:00:02.000Z',
        runId: 'r',
        kind: 'model',
        stage: 'response_completed',
        messageId: 'response-root-1',
        durationMs: 2_000,
        runtimeMetadata: { timingSource: 'observed', timingBoundary: 'turn_or_activity_end' }
      },
      {
        id: 'child-1',
        ts: '2026-01-01T00:00:04.000Z',
        runId: 'r',
        kind: 'model',
        stage: 'response_completed',
        messageId: 'response-child-1',
        agentId: 'child-thread',
        parentToolUseId: 'spawn-1',
        durationMs: 3_000,
        runtimeMetadata: { timingSource: 'observed', timingBoundary: 'turn_or_activity_end' }
      },
      {
        id: 'root-2',
        ts: '2026-01-01T00:00:07.000Z',
        runId: 'r',
        kind: 'model',
        stage: 'response_completed',
        messageId: 'response-root-2',
        durationMs: 3_000,
        runtimeMetadata: { timingSource: 'observed', timingBoundary: 'turn_or_activity_end' }
      }
    ]

    expect(aggregateTurnEvidence({ events, source: 'scry_provider_adapter' }).modelTiming).toEqual({
      status: 'available',
      quality: 'estimated',
      source: ['scry_provider_adapter'],
      value: {
        method: 'response_intervals',
        totalCalls: 3,
        timedCalls: 3,
        cumulativeMs: 8_000,
        occupiedMs: 7_000,
        overlapMs: 1_000,
        root: { totalCalls: 2, timedCalls: 2, cumulativeMs: 5_000 },
        subagents: { totalCalls: 1, timedCalls: 1, cumulativeMs: 3_000 },
        calls: [
          expect.objectContaining({
            responseId: 'response-root-1',
            scope: 'root',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:02.000Z',
            durationMs: 2_000,
            source: 'observed',
            boundary: 'turn_or_activity_end'
          }),
          expect.objectContaining({
            responseId: 'response-child-1',
            scope: 'subagent',
            agentId: 'child-thread',
            parentToolUseId: 'spawn-1',
            startedAt: '2026-01-01T00:00:01.000Z',
            completedAt: '2026-01-01T00:00:04.000Z',
            durationMs: 3_000,
            source: 'observed',
            boundary: 'turn_or_activity_end'
          }),
          expect.objectContaining({
            responseId: 'response-root-2',
            scope: 'root',
            startedAt: '2026-01-01T00:00:04.000Z',
            completedAt: '2026-01-01T00:00:07.000Z',
            durationMs: 3_000,
            source: 'observed',
            boundary: 'turn_or_activity_end'
          })
        ]
      }
    })
  })

  it('Tool、Skill、MCP 使用互斥口径，并共享 Skill 去重规则', () => {
    const events: TraceEvent[] = [
      { id: 'bash', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', name: 'Bash', toolUseId: 'bash-1' },
      { id: 'mcp', ts: '2026-01-01T00:00:00.100Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', name: 'Bash', toolUseId: 'mcp-1', isMcp: true, mcpServer: 'coop', mcpAction: 'query' },
      { id: 'skill-injected', ts: '2026-01-01T00:00:00.200Z', runId: 'r', kind: 'skill', stage: 'skill:rate-workflow', tool: 'Skill', name: 'rate-workflow', input: { source: 'skill_injection' } },
      { id: 'skill-path', ts: '2026-01-01T00:00:00.300Z', runId: 'r', kind: 'skill', stage: 'skill:rate-workflow', tool: 'Skill', name: 'rate-workflow', toolUseId: 'read-skill', input: { source: 'skill_path_in_command' } }
    ]
    const evidence = aggregateTurnEvidence({ events })

    expect(evidence.tools.value).toEqual([
      expect.objectContaining({ id: 'bash-1', category: 'tool', order: 0 })
    ])
    expect(evidence.mcps.value).toEqual([
      expect.objectContaining({ id: 'mcp-1', category: 'mcp', order: 1 })
    ])
    expect(evidence.skills.value).toEqual([
      expect.objectContaining({ name: 'rate-workflow', category: 'skill', order: 2 })
    ])
  })

  it('同一个 shell lifecycle 中的多个 MCP 操作分别进入 evidence', () => {
    const evidence = aggregateTurnEvidence({
      events: [{
        id: 'mcp',
        ts: '2026-01-01T00:00:00.100Z',
        runId: 'r',
        kind: 'tool',
        stage: 'tool:Bash',
        tool: 'Bash',
        name: 'Bash',
        toolUseId: 'mcp-1',
        isMcp: true,
        mcpCalls: [
          { server: 'coop', action: 'query', tool: 'mcporter:coop.query' },
          { server: 'group-env', action: 'list', tool: 'mcporter:group-env.list' }
        ]
      }]
    })
    expect(evidence.tools.value).toEqual([])
    expect(evidence.mcps.value).toEqual([
      expect.objectContaining({ id: 'mcp-1', mcp: { server: 'coop', action: 'query', tool: 'mcporter:coop.query' } }),
      expect.objectContaining({ id: 'mcp-1', mcp: { server: 'group-env', action: 'list', tool: 'mcporter:group-env.list' } })
    ])
  })

  it('旧历史事件从 shell command 回填多个 MCP evidence', () => {
    const evidence = aggregateTurnEvidence({
      events: [{
        id: 'mcp',
        ts: '2026-01-01T00:00:00.100Z',
        runId: 'r',
        kind: 'tool',
        stage: 'tool:Bash',
        tool: 'Bash',
        name: 'Bash',
        toolUseId: 'mcp-1',
        isMcp: true,
        input: {
          command: "mcporter call coop.get_sub_workitem --args '{}' && mcporter call coop.get_workitem_comments --args '{}'"
        },
        mcpServer: 'coop',
        mcpAction: 'get_sub_workitem',
        mcpTool: 'mcporter:coop.get_sub_workitem'
      }]
    })
    expect(evidence.mcps.value).toEqual([
      expect.objectContaining({ mcp: { server: 'coop', action: 'get_sub_workitem', tool: 'mcporter:coop.get_sub_workitem' } }),
      expect.objectContaining({ mcp: { server: 'coop', action: 'get_workitem_comments', tool: 'mcporter:coop.get_workitem_comments' } })
    ])
  })

  it('完整聚合 delta-only、text-only，并对同一流的最终 snapshot 去重', () => {
    const events: TraceEvent[] = [
      { id: 'd1', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '你', messageId: 'm1' },
      { id: 'd2', ts: '2026-01-01T00:00:00.001Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '好', messageId: 'm1' },
      { id: 'snapshot', ts: '2026-01-01T00:00:00.002Z', runId: 'r', kind: 'model', stage: 'text', text: '你好', messageId: 'm1' },
      { id: 'tool', ts: '2026-01-01T00:00:00.003Z', runId: 'r', kind: 'tool', stage: 'tool:Read', tool: 'Read' },
      { id: 'text', ts: '2026-01-01T00:00:00.004Z', runId: 'r', kind: 'model', stage: 'text', text: '完成', messageId: 'm2' }
    ]
    const assistant = aggregateTurnEvidence({ events }).assistant
    const text = '你好完成'

    expect(assistant).toEqual({
      status: 'available',
      quality: 'exact',
      source: ['trace_events'],
      value: {
        text,
        textHash: `sha256:${createHash('sha256').update(text).digest('hex')}`
      }
    })
  })

  it('按事件顺序保留根 Agent 与子 Agent 的相邻可见输出', () => {
    const events: TraceEvent[] = [
      { id: 'root', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '根', parentToolUseId: null },
      { id: 'child', ts: '2026-01-01T00:00:00.001Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '子', agentId: 'child-1', parentToolUseId: 'spawn-1' },
      { id: 'root-2', ts: '2026-01-01T00:00:00.002Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '终', parentToolUseId: null }
    ]
    expect(aggregateTurnEvidence({ events }).assistant.value?.text).toBe('根子终')
  })

  it('普通 errors 与总览一致，只包含失败的 tool_result', () => {
    const events: TraceEvent[] = [
      { id: 'tool', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: 't1', isError: true, text: 'exit 1' },
      { id: 'hook', ts: '2026-01-01T00:00:00.001Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookName: 'audit.py', isError: true, text: 'hook failed' },
      { id: 'runtime', ts: '2026-01-01T00:00:00.002Z', runId: 'r', kind: 'harness', stage: 'result', isError: true, text: 'runtime failed' }
    ]
    expect(aggregateTurnEvidence({ events }).errors.value).toEqual([
      { message: 'exit 1', source: 'tool_result', toolUseId: 't1' }
    ])
  })
})
