import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import type { WorkflowActivity } from '../shared/claude-workflow'
import { type NormalizeCtx, normalizeSdkMessage } from './normalize'
import { QoderBackgroundTasks } from './providers/qoder-messages'
import { QODER_BACKGROUND_AGENT_MESSAGES } from './workflow-wire-fixtures/qoder-background-agent'

function ctx(): NormalizeCtx {
  let n = 0
  return { runId: 'run-1', newId: () => `ev-${n++}`, now: () => '2026-11-10T00:00:00.000Z' }
}

// These messages are a real Qoder run (see the fixture header), so the assertions below
// pin what the shared normalization must keep doing with actual wire data from a Provider
// other than Claude, instead of with shapes chosen inside the test.
function replay(): TraceEvent[] {
  const c = ctx()
  return QODER_BACKGROUND_AGENT_MESSAGES.flatMap((message) => normalizeSdkMessage(message, c))
}

describe('real Qoder background Agent wire', () => {
  it('两个后台 Agent 都不进 workflow 通道', () => {
    const events = replay()
    const workflow = events.filter((event) => event.stage === 'workflow_activity').map((event) => event.input as WorkflowActivity)
    expect(workflow).toEqual([])
    // Qoder's task lifecycle is `local_agent`, and it carries no `workflow_progress`.
    expect(events.some((event) => event.stage === 'harness' && event.tool === 'Workflow')).toBe(false)
  })

  it('Agent tool_use 与 lifecycle 事件按 tool_use_id 对上', () => {
    const events = replay()
    const uses = events.filter((event) => event.stage.startsWith('agent:'))
    expect(uses.map((event) => [event.stage, event.tool])).toEqual([
      ['agent:general-purpose', 'Agent'], ['agent:general-purpose', 'Agent']
    ])
    const toolUseIds = new Set(uses.map((event) => event.toolUseId))
    const activity = events.filter((event) => event.stage === 'agent_activity')
    expect(activity.map((event) => (event.input as { activity: string }).activity))
      .toEqual(['task_started', 'task_started', 'task_progress', 'task_progress', 'task_progress'])
    expect(activity.every((event) => toolUseIds.has(event.toolUseId))).toBe(true)
    expect(activity.map((event) => (event.input as { lastToolName?: string }).lastToolName))
      .toEqual([undefined, undefined, 'Bash', 'Read', 'Bash'])
  })

  it('启动回执与终态回执是两条 tool_result，终态只说 Provider 报的 completed', () => {
    const events = replay()
    const results = events.filter((event) => event.stage === 'tool_result' && event.tool === 'Agent')
    expect(results).toHaveLength(4)
    expect(results.map((event) => event.runtimeMetadata?.agentStatus ?? null))
      .toEqual([null, null, 'completed', 'completed'])
    expect(results.every((event) => event.isError === false)).toBe(true)
    // `task_updated` 带 patch 时只是补状态，不得凭它单独编造一条 Agent 行。
    const patched = events.filter((event) => event.runtimeMetadata?.source === 'provider_task_updated')
    expect(patched).toEqual([])
  })

  it('后台任务卡片先出现再结算，不留运行中的任务', () => {
    const tasks = new QoderBackgroundTasks()
    const seen: number[] = []
    for (const message of QODER_BACKGROUND_AGENT_MESSAGES) {
      tasks.observe(message)
      seen.push(tasks.tasks.length)
    }
    // 两个任务都出现过，最后都按 Provider 的终态结算掉。
    expect(Math.max(...seen)).toBe(2)
    expect(tasks.pending).toBe(false)
    expect(tasks.tasks).toEqual([])
  })
})
