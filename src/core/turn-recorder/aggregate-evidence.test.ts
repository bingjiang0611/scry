import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from './aggregate'

describe('aggregateTurnEvidence model, call and diff evidence', () => {
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
      { id: 'mcp', ts: '2026-01-01T00:00:00.100Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', name: 'Bash', toolUseId: 'mcp-1', isMcp: true, mcpServer: 'workitem', mcpAction: 'query' },
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
          { server: 'workitem', action: 'query', tool: 'mcporter:workitem.query' },
          { server: 'env-config', action: 'list', tool: 'mcporter:env-config.list' }
        ]
      }]
    })
    expect(evidence.tools.value).toEqual([])
    expect(evidence.mcps.value).toEqual([
      expect.objectContaining({ id: 'mcp-1', mcp: { server: 'workitem', action: 'query', tool: 'mcporter:workitem.query' } }),
      expect.objectContaining({ id: 'mcp-1', mcp: { server: 'env-config', action: 'list', tool: 'mcporter:env-config.list' } })
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
          command: "mcporter call workitem.get_sub_workitem --args '{}' && mcporter call workitem.get_workitem_comments --args '{}'"
        },
        mcpServer: 'workitem',
        mcpAction: 'get_sub_workitem',
        mcpTool: 'mcporter:workitem.get_sub_workitem'
      }]
    })
    expect(evidence.mcps.value).toEqual([
      expect.objectContaining({ mcp: { server: 'workitem', action: 'get_sub_workitem', tool: 'mcporter:workitem.get_sub_workitem' } }),
      expect.objectContaining({ mcp: { server: 'workitem', action: 'get_workitem_comments', tool: 'mcporter:workitem.get_workitem_comments' } })
    ])
  })

  it('完整聚合 delta-only、text-only，并对同一流的最终 snapshot 去重', () => {
    const events: TraceEvent[] = [
      { id: 'd1', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '你', messageId: 'm1' },
      { id: 'd2', ts: '2026-01-01T00:00:00.001Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '好', messageId: 'm1' },
      { id: 'snapshot', ts: '2026-01-01T00:00:00.002Z', runId: 'r', kind: 'model', stage: 'text', text: '你好', messageId: 'm1' },
      { id: 'thinking', ts: '2026-01-01T00:00:00.003Z', runId: 'r', kind: 'model', stage: 'thinking', thinking: '检查文件', messageId: 'reasoning-1' },
      { id: 'tool', ts: '2026-01-01T00:00:00.004Z', runId: 'r', kind: 'tool', stage: 'tool:Read', tool: 'Read' },
      { id: 'text', ts: '2026-01-01T00:00:00.005Z', runId: 'r', kind: 'model', stage: 'text', text: '完成', messageId: 'm2' }
    ]
    const evidence = aggregateTurnEvidence({ events })
    const assistant = evidence.assistant
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
    expect(evidence.modelSegments).toEqual({
      status: 'available',
      quality: 'exact',
      source: ['trace_events'],
      value: [
        { order: 0, at: events[0].ts, kind: 'text', text: '你好', messageId: 'm1' },
        { order: 3, at: events[3].ts, kind: 'thinking', text: '检查文件', messageId: 'reasoning-1' },
        { order: 5, at: events[5].ts, kind: 'text', text: '完成', messageId: 'm2' }
      ]
    })
  })

  it('以 Provider 权威正文替换不完整的流式前缀', () => {
    const evidence = aggregateTurnEvidence({ events: [
      {
        id: 'prefix', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'model',
        stage: 'text_delta', text: 'hel', messageId: 'm1'
      },
      {
        id: 'authoritative', ts: '2026-01-01T00:00:00.001Z', runId: 'r', kind: 'model',
        stage: 'text', text: 'hello', messageId: 'm1',
        runtimeMetadata: { source: 'opencode_response_parts', replacesStreamedText: true }
      }
    ] })

    expect(evidence.assistant.value?.text).toBe('hello')
    expect(evidence.modelSegments?.value).toEqual([
      expect.objectContaining({ text: 'hello', messageId: 'm1' })
    ])
  })

  it('保留子 Agent model segment 但 root assistant 只汇总根作用域输出', () => {
    const events: TraceEvent[] = [
      { id: 'root', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '根', parentToolUseId: null },
      { id: 'child', ts: '2026-01-01T00:00:00.001Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '子', agentId: 'child-1', parentToolUseId: 'spawn-1' },
      { id: 'root-2', ts: '2026-01-01T00:00:00.002Z', runId: 'r', kind: 'model', stage: 'text_delta', text: '终', parentToolUseId: null }
    ]
    const evidence = aggregateTurnEvidence({ events })
    expect(evidence.assistant.value?.text).toBe('根终')
    expect(evidence.modelSegments?.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '子', agentId: 'child-1', parentId: 'spawn-1' })
    ]))
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

  it('保留显式 Provider task_error，但不把它计为工具调用', () => {
    const events: TraceEvent[] = [
      { id: 'api-error', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'harness', stage: 'task_error', isError: true, text: 'model rejected' }
    ]
    const evidence = aggregateTurnEvidence({ events })
    expect(evidence.errors.value).toEqual([{ message: 'model rejected', source: 'task_error', toolUseId: undefined }])
    expect(evidence.tools.value).toEqual([])
  })

  it('把人工介入作为独立 evidence 保留，不依赖 Provider 文本解析', () => {
    const intervention = {
      kind: 'clarification' as const,
      source: 'codex:item/tool/requestUserInput',
      resolution: 'answered' as const,
      request: {
        runId: 'r',
        questionId: 'question-1',
        providerId: 'codex' as const,
        questions: [{
          header: '范围',
          question: '选择范围？',
          multiSelect: false,
          options: [{ label: '全量', description: '全部' }, { label: '增量', description: '仅变化' }]
        }]
      },
      response: {
        runId: 'r',
        questionId: 'question-1',
        behavior: 'answered' as const,
        answers: { '选择范围？': '全量' }
      },
      openedAt: '2026-08-06T10:00:00.000Z',
      closedAt: '2026-08-06T10:00:02.000Z',
      durationMs: 2000
    }
    const evidence = aggregateTurnEvidence({
      events: [{ id: 'human-1', ts: intervention.closedAt, runId: 'r', kind: 'human', stage: 'intervention', intervention }]
    })

    expect(evidence.interventions).toEqual({
      status: 'available',
      quality: 'exact',
      source: ['trace_events'],
      value: [intervention]
    })
  })

  it('保留全部调用骨架，超预算时优先保留失败、写操作及同名首尾详情', () => {
    const events: TraceEvent[] = Array.from({ length: 170 }, (_, index) => ({
      id: `read-${index}`,
      ts: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      runId: 'r',
      kind: 'tool',
      stage: 'tool:Read',
      tool: 'Read',
      toolUseId: `read-${index}`,
      input: { path: `/repo/${index}.ts`, padding: 'x'.repeat(1024) }
    }))
    events.push(
      {
        id: 'write', ts: '2026-01-01T00:03:00.000Z', runId: 'r', kind: 'tool', stage: 'tool:Write', tool: 'Write',
        toolUseId: 'write', fileOp: 'write', filePath: '/repo/out.ts', input: { content: 'important mutation' }
      },
      {
        id: 'failed', ts: '2026-01-01T00:03:01.000Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', tool: 'Bash',
        toolUseId: 'failed', input: { command: 'exit 1' }
      },
      {
        id: 'failed-result', ts: '2026-01-01T00:03:02.000Z', runId: 'r', kind: 'tool', stage: 'tool_result',
        tool: 'Bash', toolUseId: 'failed', isError: true, text: 'failed safely'
      }
    )

    const evidence = aggregateTurnEvidence({ events })
    const calls = evidence.tools.value ?? []
    expect(evidence.tools).toMatchObject({ status: 'partial', quality: 'exact' })
    expect(calls).toHaveLength(172)
    expect(calls.find((call) => call.id === 'read-0')?.input).toBeDefined()
    expect(calls.find((call) => call.id === 'read-169')?.input).toBeDefined()
    expect(calls.find((call) => call.id === 'read-160')?.input).toBeUndefined()
    expect(calls.find((call) => call.id === 'write')?.input).toBeDefined()
    expect(calls.find((call) => call.id === 'failed')).toMatchObject({ input: { command: 'exit 1' }, error: 'failed safely' })
  })

  it('单次工具 input 超过 8 KiB 时只省略 input，并把 evidence 标为 partial', () => {
    const evidence = aggregateTurnEvidence({ events: [{
      id: 'large', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'tool', stage: 'tool:Bash',
      tool: 'Bash', toolUseId: 'large', input: { command: 'x'.repeat(9 * 1024) }
    }] })

    expect(evidence.tools).toMatchObject({ status: 'partial', quality: 'exact' })
    expect(evidence.tools.value?.[0].input).toBeUndefined()
    expect(evidence.tools.value?.[0]).toMatchObject({ id: 'large', name: 'Bash', status: 'unknown' })
  })

  it('仓库快照成功但文件 patch 被省略时，diff evidence 标为 partial', () => {
    const evidence = aggregateTurnEvidence({ events: [{
      id: 'diff', ts: '2026-01-01T00:00:01.000Z', runId: 'r', kind: 'harness', stage: 'turn_diff',
      turnDiff: {
        version: 1,
        status: 'captured',
        files: [{ path: '/repo/.factorypath', added: 1, deleted: 1, patchStatus: 'unavailable', patchReason: 'policy' }],
        beforeAt: '2026-01-01T00:00:00.000Z',
        afterAt: '2026-01-01T00:00:01.000Z',
        captureMs: 1,
        cleanup: 'ok'
      }
    }] })

    expect(evidence.diff).toMatchObject({
      status: 'partial',
      quality: 'exact',
      omissionReason: 'one or more file patches were omitted or truncated: policy'
    })
  })
})
