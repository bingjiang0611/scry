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
      expect.objectContaining({ id: 'h1', name: 'audit.py', event: 'PreToolUse', status: 'success', durationMs: 25 })
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
      { id: 'native', ts: '2026-01-01T00:00:03.000Z', runId: 'r', kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 5 }
    ] }).usage.value).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('Tool、Skill、MCP 使用互斥口径，并共享 Skill 去重规则', () => {
    const events: TraceEvent[] = [
      { id: 'bash', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', name: 'Bash', toolUseId: 'bash-1' },
      { id: 'mcp', ts: '2026-01-01T00:00:00.100Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', name: 'Bash', toolUseId: 'mcp-1', isMcp: true, mcpServer: 'coop', mcpAction: 'query' },
      { id: 'skill-injected', ts: '2026-01-01T00:00:00.200Z', runId: 'r', kind: 'skill', stage: 'skill:rate-workflow', tool: 'Skill', name: 'rate-workflow', input: { source: 'skill_injection' } },
      { id: 'skill-path', ts: '2026-01-01T00:00:00.300Z', runId: 'r', kind: 'skill', stage: 'skill:rate-workflow', tool: 'Skill', name: 'rate-workflow', toolUseId: 'read-skill', input: { source: 'skill_path_in_command' } }
    ]
    const evidence = aggregateTurnEvidence({ events })

    expect(evidence.tools.value?.map((call) => call.id)).toEqual(['bash-1'])
    expect(evidence.mcps.value?.map((call) => call.id)).toEqual(['mcp-1'])
    expect(evidence.skills.value?.map((call) => call.name)).toEqual(['rate-workflow'])
  })
})
