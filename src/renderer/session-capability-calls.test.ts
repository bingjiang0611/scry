import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import type { Turn } from './format'
import { sessionCapabilityCalls } from './session-capability-calls'

const event = (patch: Partial<TraceEvent> = {}): TraceEvent => ({
  id: 'skill-1', runId: 'run-1', ts: '', kind: 'skill', stage: 'skill:workflow',
  name: 'workflow', toolUseId: 'call-1', ...patch
})
const turn = (items: TraceEvent[], runId = 'run-1'): Turn => ({ runId, userText: '/unused-skill', items, done: true })
const mcp = event({ id: 'mcp-1', kind: 'tool', stage: 'tool:mcp__tracker__search', tool: 'mcp__tracker__search',
  name: undefined, toolUseId: 'mcp-call-1', isMcp: true })

describe('sessionCapabilityCalls', () => {
  it('uses all loaded turns, deduplicates lifecycle events within a turn but not across turns', () => {
    const rows = sessionCapabilityCalls([
      turn([event(), event({ id: 'progress' }), event({ id: 'result', stage: 'tool_result' }), mcp,
        { ...mcp, id: 'mcp-progress' }, { ...mcp, id: 'mcp-result', stage: 'tool_result', isError: true }]),
      turn([event({ id: 'skill-2' }), { ...mcp, id: 'mcp-2' }], 'run-2')
    ])
    expect(rows.map(({ name, count, kind }) => ({ name, count, kind }))).toEqual([
      { kind: 'skill', name: 'workflow', count: 2 },
      { kind: 'mcp', name: 'tracker / search', count: 2 }
    ])
    expect(rows[0]).toMatchObject({ runId: 'run-1', event: { id: 'skill-1' } })
    expect(rows[1]).toMatchObject({ runId: 'run-1', event: { id: 'mcp-1' } })
  })

  it('does not invent calls from prompts, model text, Skill file references or ordinary tools', () => {
    const rows = sessionCapabilityCalls([turn([
      event({ input: { source: 'skill_file' } }),
      event({ input: { source: 'skill_path_in_bash' } }),
      event({ kind: 'model', stage: 'text_delta', text: '我会调用 workflow 和 tracker' }),
      event({ kind: 'tool', stage: 'tool:Read', tool: 'Read', input: { file_path: '/skills/workflow/SKILL.md' } })
    ])])
    expect(rows).toEqual([])
  })

  it('uses the existing Skill injection/direct-call dedup semantics', () => {
    const injection = event({ toolUseId: undefined, input: { source: 'skill_injection' } })
    expect(sessionCapabilityCalls([turn([injection, { ...injection, id: 'injection-2' }])])[0].count).toBe(1)
    expect(sessionCapabilityCalls([turn([injection, event()])])[0]).toMatchObject({ count: 1, event: { toolUseId: 'call-1' } })
  })

  it('counts separate calls and MCP actions, including failed attempts, without equating invocation with success', () => {
    const rows = sessionCapabilityCalls([turn([
      mcp,
      { ...mcp, id: 'second', toolUseId: 'mcp-call-2' },
      { ...mcp, id: 'failed-result', toolUseId: 'mcp-call-2', stage: 'tool_result', isError: true },
      { ...mcp, id: 'other-action', toolUseId: 'mcp-call-3', tool: 'mcp__tracker__get' }
    ])])
    expect(rows.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: 'tracker / search', count: 2 }, { name: 'tracker / get', count: 1 }
    ])
  })

  it('recovers multiple MCP calls from legacy bridge evidence using the shared parser', () => {
    const rows = sessionCapabilityCalls([turn([{
      ...mcp, tool: 'Bash', mcpServer: 'workitem', mcpAction: 'get_sub_workitem',
      mcpTool: 'mcporter:workitem.get_sub_workitem',
      input: { command: "mcporter call workitem.get_sub_workitem --args '{}' && mcporter call workitem.get_workitem_comments --args '{}'" }
    }])])
    expect(rows.map(({ name }) => name).sort()).toEqual(['workitem / get_sub_workitem', 'workitem / get_workitem_comments'])
  })

  it('session switch/new conversation cannot retain previous call rows', () => {
    expect(sessionCapabilityCalls([turn([event(), mcp])])).toHaveLength(2)
    expect(sessionCapabilityCalls([turn([], 'another-session')])).toEqual([])
    expect(sessionCapabilityCalls([])).toEqual([])
  })
})
