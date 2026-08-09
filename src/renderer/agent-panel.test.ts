import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { AgentsSurface } from './components/AgentsSurface'
import type { Turn } from './format'
import { deriveAgentRows } from './agent-panel'

function event(partial: Partial<TraceEvent> & Pick<TraceEvent, 'id' | 'kind' | 'stage'>): TraceEvent {
  return {
    ts: '2026-08-09T08:00:00.000Z',
    runId: 'run-1',
    ...partial
  }
}

function turn(items: TraceEvent[], partial: Partial<Turn> = {}): Turn {
  return { runId: 'run-1', userText: 'delegate', items, done: true, ...partial }
}

describe('deriveAgentRows', () => {
  it('合并 Codex spawnAgent 与 subAgentActivity，并忽略仅表示 spawn 完成的根级结果', () => {
    const items = [
      event({
        id: 'spawn',
        kind: 'agent',
        stage: 'agent:检查 Provider',
        tool: 'Agent',
        toolUseId: 'spawn-1',
        name: '检查 Provider',
        providerId: 'codex',
        runtimeProvider: 'codex_cli',
        input: {
          senderThreadId: 'thread-root',
          receiverThreadIds: ['thread-child'],
          prompt: '检查 Provider',
          model: 'gpt-5.6'
        }
      }),
      event({
        id: 'activity',
        kind: 'agent',
        stage: 'agent:alpha',
        tool: 'Agent',
        toolUseId: 'activity-1',
        agentId: 'thread-child',
        name: 'alpha',
        ts: '2026-08-09T08:00:01.000Z',
        providerId: 'codex',
        runtimeProvider: 'codex_cli',
        input: { activity: 'started', agentThreadId: 'thread-child', agentPath: '/root/alpha' }
      }),
      event({
        id: 'bash',
        kind: 'tool',
        stage: 'tool:Bash',
        tool: 'Bash',
        toolUseId: 'bash-1',
        agentId: 'thread-child',
        parentToolUseId: 'spawn-1',
        ts: '2026-08-09T08:00:02.000Z',
        providerId: 'codex',
        runtimeProvider: 'codex_cli',
        input: { command: 'pwd' }
      }),
      event({
        id: 'bash-result',
        kind: 'tool',
        stage: 'tool_result',
        tool: 'Bash',
        toolUseId: 'bash-1',
        agentId: 'thread-child',
        ts: '2026-08-09T08:00:03.000Z',
        providerId: 'codex',
        runtimeProvider: 'codex_cli',
        output: '/repo'
      }),
      event({
        id: 'spawn-ack',
        kind: 'tool',
        stage: 'tool_result',
        tool: 'Agent',
        toolUseId: 'spawn-1',
        ts: '2026-08-09T08:00:04.000Z',
        providerId: 'codex',
        runtimeProvider: 'codex_cli',
        output: '{}'
      }),
      event({
        id: 'child-result',
        kind: 'tool',
        stage: 'tool_result',
        tool: 'Agent',
        toolUseId: 'spawn-1',
        agentId: 'thread-child',
        ts: '2026-08-09T08:00:05.000Z',
        providerId: 'codex',
        runtimeProvider: 'codex_cli',
        output: '{"status":"completed"}'
      })
    ]

    const rows = deriveAgentRows([turn(items)], { busy: false })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'thread-child',
      name: '检查 Provider',
      model: 'gpt-5.6',
      providerId: 'codex',
      status: 'completed',
      statusSource: 'tool_result',
      toolCount: 1
    })
    expect(rows[0].terminalEvent?.id).toBe('child-result')
    expect(rows[0].recentActivity.map((activity) => activity.label)).toContain('Bash · pwd')
  })

  it('Codex 子 Agent 的嵌套 spawn ack 不会提前结束父 Agent', () => {
    const items = [
      event({
        id: 'parent-spawn', kind: 'agent', stage: 'agent:parent', tool: 'Agent', toolUseId: 'parent-spawn',
        name: 'parent', providerId: 'codex', runtimeProvider: 'codex_cli',
        input: { senderThreadId: 'thread-root', receiverThreadIds: ['thread-parent'] }
      }),
      event({
        id: 'nested-spawn', kind: 'agent', stage: 'agent:grandchild', tool: 'Agent', toolUseId: 'nested-spawn',
        agentId: 'thread-parent', name: 'grandchild', ts: '2026-08-09T08:00:01.000Z',
        providerId: 'codex', runtimeProvider: 'codex_cli',
        input: { senderThreadId: 'thread-parent', receiverThreadIds: ['thread-grandchild'] }
      }),
      event({
        id: 'nested-ack', kind: 'tool', stage: 'tool_result', tool: 'Agent', toolUseId: 'nested-spawn',
        agentId: 'thread-parent', ts: '2026-08-09T08:00:02.000Z', providerId: 'codex', runtimeProvider: 'codex_cli'
      }),
      event({
        id: 'grandchild-result', kind: 'tool', stage: 'tool_result', tool: 'Agent', toolUseId: 'nested-spawn',
        agentId: 'thread-grandchild', ts: '2026-08-09T08:00:03.000Z', providerId: 'codex', runtimeProvider: 'codex_cli',
        runtimeMetadata: { source: 'codex_child_turn', agentStatus: 'completed' }
      })
    ]

    const rows = deriveAgentRows([turn(items, { done: false })], { busy: true })
    const parent = rows.find((row) => row.id === 'thread-parent')
    const grandchild = rows.find((row) => row.id === 'thread-grandchild')

    expect(parent).toMatchObject({ status: 'running', statusSource: 'active_turn', depth: 0 })
    expect(parent?.terminalEvent).toBeUndefined()
    expect(parent?.recentActivity.map((activity) => activity.label)).toContain('子 Agent 已启动')
    expect(grandchild).toMatchObject({
      parentId: 'thread-parent',
      status: 'completed',
      statusSource: 'tool_result',
      depth: 1
    })
    expect(grandchild?.terminalEvent?.id).toBe('grandchild-result')
  })

  it('按 Claude parentToolUseId 归属工具与嵌套 Agent，不把内层工具算给外层', () => {
    const items = [
      event({
        id: 'outer', kind: 'agent', stage: 'agent:Explore', tool: 'Task', toolUseId: 'outer', name: 'Explore',
        providerId: 'claude', runtimeProvider: 'claude_sdk'
      }),
      event({
        id: 'inner', kind: 'agent', stage: 'agent:reviewer', tool: 'Task', toolUseId: 'inner', name: 'reviewer',
        parentToolUseId: 'outer', ts: '2026-08-09T08:00:01.000Z', providerId: 'claude', runtimeProvider: 'claude_sdk'
      }),
      event({
        id: 'read', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read', parentToolUseId: 'outer',
        ts: '2026-08-09T08:00:02.000Z', providerId: 'claude', runtimeProvider: 'claude_sdk'
      }),
      event({
        id: 'grep', kind: 'tool', stage: 'tool:Grep', tool: 'Grep', toolUseId: 'grep', parentToolUseId: 'inner',
        ts: '2026-08-09T08:00:03.000Z', providerId: 'claude', runtimeProvider: 'claude_sdk'
      }),
      event({
        id: 'inner-result', kind: 'tool', stage: 'tool_result', tool: 'Task', toolUseId: 'inner',
        ts: '2026-08-09T08:00:04.000Z', providerId: 'claude', runtimeProvider: 'claude_sdk', output: 'reviewed'
      }),
      event({
        id: 'outer-result', kind: 'tool', stage: 'tool_result', tool: 'Task', toolUseId: 'outer',
        ts: '2026-08-09T08:00:05.000Z', providerId: 'claude', runtimeProvider: 'claude_sdk', output: 'explored'
      })
    ]

    const rows = deriveAgentRows([turn(items)], { busy: false })
    const outer = rows.find((row) => row.id === 'run-1:outer')
    const inner = rows.find((row) => row.id === 'run-1:inner')

    expect(rows.map((row) => row.id)).toEqual(['run-1:outer', 'run-1:inner'])
    expect(outer).toMatchObject({ status: 'completed', toolCount: 1, depth: 0 })
    expect(inner).toMatchObject({ parentId: 'run-1:outer', status: 'completed', toolCount: 1, depth: 1 })
    expect(outer?.recentActivity.map((activity) => activity.label)).toContain('启动子 Agent · reviewer')
  })

  it('结果先于启动事件到达时仍按 toolUseId 得到真实终态', () => {
    const rows = deriveAgentRows([turn([
      event({
        id: 'result', kind: 'tool', stage: 'tool_result', tool: 'Task', toolUseId: 'late-start',
        ts: '2026-08-09T08:00:02.000Z', providerId: 'claude', runtimeProvider: 'claude_sdk', output: 'done'
      }),
      event({
        id: 'start', kind: 'agent', stage: 'agent:research', tool: 'Task', toolUseId: 'late-start', name: 'research',
        ts: '2026-08-09T08:00:01.000Z', providerId: 'claude', runtimeProvider: 'claude_sdk'
      })
    ])], { busy: false })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'run-1:late-start', status: 'completed' })
    expect(rows[0].startedAt).toBe('2026-08-09T08:00:01.000Z')
    expect(rows[0].completedAt).toBe('2026-08-09T08:00:02.000Z')
  })

  it.each(['async_launched', 'remote_launched'])('%s 只是启动回执，不是 Agent 终态', (agentStatus) => {
    const active = turn([
      event({
        id: 'start', kind: 'agent', stage: 'agent:research', tool: 'Agent', toolUseId: 'background', name: 'research'
      }),
      event({
        id: 'launch', kind: 'tool', stage: 'tool_result', tool: 'Agent', toolUseId: 'background',
        ts: '2026-08-09T08:00:01.000Z', runtimeMetadata: { agentStatus }
      }),
      event({
        id: 'task-started', kind: 'harness', stage: 'agent_activity', tool: 'Agent', toolUseId: 'background',
        ts: '2026-08-09T08:00:02.000Z', input: { activity: 'task_started' },
        runtimeMetadata: { agentStatus: 'running' }
      })
    ], { done: false })

    const [row] = deriveAgentRows([active], { busy: true })
    expect(row).toMatchObject({ status: 'running', statusSource: 'active_turn' })
    expect(row.terminalEvent).toBeUndefined()
    expect(row.recentActivity.map((activity) => activity.label)).not.toContain('Agent 完成')
  })

  it.each([
    ['completed', 'completed', 'tool_result', 'Agent 完成'],
    ['failed', 'failed', 'tool_error', 'Agent 失败'],
    ['stopped', 'stopped', 'tool_stopped', 'Agent 已停止'],
    ['cancelled', 'stopped', 'tool_stopped', 'Agent 已停止'],
    ['interrupted', 'stopped', 'tool_stopped', 'Agent 已停止']
  ])('把 Provider %s 终态投影为真实状态', (agentStatus, status, statusSource, activity) => {
    const [row] = deriveAgentRows([turn([
      event({ id: 'start', kind: 'agent', stage: 'agent:worker', tool: 'Agent', toolUseId: 'worker', name: 'worker' }),
      event({
        id: 'result', kind: 'tool', stage: 'tool_result', tool: 'Agent', toolUseId: 'worker',
        ts: '2026-08-09T08:00:01.000Z', runtimeMetadata: { agentStatus }
      })
    ])], { busy: false })

    expect(row).toMatchObject({ status, statusSource })
    expect(row.recentActivity[0]?.label).toBe(activity)
  })

  it('历史 turn 缺少 Agent 终态时保持 unknown，即使外部 busy 暂时为 true', () => {
    const historical = turn([
      event({ id: 'start', kind: 'agent', stage: 'agent:Explore', tool: 'Task', toolUseId: 'orphan', name: 'Explore' })
    ], { done: true })

    const rows = deriveAgentRows([historical], { busy: true })

    expect(rows[0]).toMatchObject({ status: 'unknown', statusSource: 'missing_terminal' })
    expect(rows[0].terminalEvent).toBeUndefined()
  })

  it('仅把当前未结束 turn 中有真实事件的 Agent 标为 running，并渲染反假数据口径', () => {
    const active = turn([
      event({ id: 'start', kind: 'agent', stage: 'agent:active', tool: 'Task', toolUseId: 'active', name: 'active' }),
      event({
        id: 'read', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read', parentToolUseId: 'active',
        ts: '2026-08-09T08:00:01.000Z'
      })
    ], { done: false })

    const rows = deriveAgentRows([active], { busy: true })
    const html = renderToStaticMarkup(createElement(AgentsSurface, { turns: [active], busy: true }))

    expect(rows[0]).toMatchObject({ status: 'running', statusSource: 'active_turn', toolCount: 1 })
    expect(html).toContain('运行中')
    expect(html).toContain('1 个工具调用')
    expect(html).toContain('未采集到终态时显示“状态未知”')
    expect(html).not.toContain('0 Token')
    expect(html).not.toContain('100%')
  })

  it('对 Agent 名称和最近活动先脱敏再截断', () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz1234567890'
    const [row] = deriveAgentRows([turn([
      event({
        id: 'start', kind: 'agent', stage: 'agent:sensitive', tool: 'Agent', toolUseId: 'sensitive',
        name: `检查 ${secret} ${'x'.repeat(120)}`
      })
    ])], { busy: false })
    const html = renderToStaticMarkup(createElement(AgentsSurface, { turns: [turn([row.sourceEvent])], busy: false }))

    expect(row.name).toContain('«REDACTED»')
    expect(row.name.length).toBeLessThanOrEqual(80)
    expect(row.recentActivity[0]?.label).not.toContain(secret)
    expect(html).not.toContain(secret)
  })
})
