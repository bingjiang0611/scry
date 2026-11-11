import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import type { WorkflowActivity } from '../shared/claude-workflow'
import type { NormalizeCtx } from './normalize'
import { QoderBackgroundTasks, normalizeQoderMessage } from './providers/qoder-messages'
import { QODER_BACKGROUND_AGENT_MESSAGES } from './workflow-wire-fixtures/qoder-background-agent'

function ctx(): NormalizeCtx {
  let n = 0
  return { runId: 'run-1', newId: () => `ev-${n++}`, now: () => '2026-11-10T00:00:00.000Z' }
}

// These messages are a real Qoder run (see the fixture header), so the assertions below
// pin what the shared normalization must keep doing with actual wire data from a Provider
// other than Claude, instead of with shapes chosen inside the test. They go through the
// Qoder adapter's own entry, which rewrites task_updated and text notifications before
// the shared normalizer, exactly as the production run loop does.
function replay(): TraceEvent[] {
  const c = ctx()
  return QODER_BACKGROUND_AGENT_MESSAGES.flatMap((message) => normalizeQoderMessage(message, c))
}

describe('real Qoder background Agent wire', () => {
  it('两个后台 Agent 都不进 workflow 通道', () => {
    const events = replay()
    const workflow = events.filter((event) => event.stage === 'workflow_activity').map((event) => event.input as WorkflowActivity)
    expect(workflow).toEqual([])
    // Qoder's task lifecycle is `local_agent`, and it carries no `workflow_progress`.
    expect(events.some((event) => event.kind === 'harness' && event.tool === 'Workflow')).toBe(false)
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

  it('启动回执之后，每个 Agent 的终态只说 Provider 报的 completed', () => {
    const events = replay()
    const results = events.filter((event) => event.stage === 'tool_result' && event.tool === 'Agent')
    // Production entry: Qoder sends task_updated and then task_notification for each Agent,
    // and the adapter rewrites task_updated into a terminal (unchanged from main), so each
    // Agent carries two terminal results after its launch receipt. Both say `completed`.
    expect(results.map((event) => [event.toolUseId?.slice(-6), event.runtimeMetadata?.source ?? 'launch']))
      .toEqual([
        ['9cM53V', 'launch'], ['Vp7nZv', 'launch'],
        ['Vp7nZv', 'qoder_task_updated'], ['Vp7nZv', 'provider_task_notification'],
        ['9cM53V', 'qoder_task_updated'], ['9cM53V', 'provider_task_notification']
      ])
    expect(results.filter((event) => event.runtimeMetadata?.agentStatus).every((event) =>
      event.runtimeMetadata?.agentStatus === 'completed')).toBe(true)
    expect(results.every((event) => event.isError === false)).toBe(true)
    // The shared normalizer never sees a raw task_updated from Qoder; it is rewritten first.
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
