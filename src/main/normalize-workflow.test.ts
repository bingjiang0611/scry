import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import type { WorkflowActivity } from '../shared/claude-workflow'
import { WORKFLOW_FIXTURE_SNAPSHOTS, workflowFixtureMessages } from '../shared/claude-workflow.fixture'
import { type NormalizeCtx, normalizeSdkMessage } from './normalize'
import { cloneWorkflowNormalizeState } from './normalize-workflow'

function ctx(): NormalizeCtx {
  let n = 0
  return { runId: 'run-1', newId: () => `ev-${n++}`, now: () => '2026-11-10T00:00:00.000Z' }
}

function activities(events: TraceEvent[]): WorkflowActivity[] {
  return events.filter((event) => event.stage === 'workflow_activity').map((event) => event.input as WorkflowActivity)
}

function run(messages: Array<Record<string, unknown>>, c = ctx()): TraceEvent[] {
  return messages.flatMap((message) => normalizeSdkMessage(message, c))
}

describe('Claude Code workflow task normalization', () => {
  it('把 Workflow 工具结果的结构化回执保留在 tool_result 上，并用它建立 task 别名', () => {
    const events = run(workflowFixtureMessages({ progressSteps: 0 }))
    const result = events.find((event) => event.stage === 'tool_result')
    expect(result).toMatchObject({
      tool: 'Workflow',
      toolUseId: 'toolu_workflow_1',
      runtimeMetadata: {
        source: 'provider_workflow_result',
        workflow: { status: 'async_launched', taskId: 'wtask-1', runId: 'wf_run_1', workflowName: 'audit-routes' }
      }
    })
    const [started] = activities(events)
    expect(started).toMatchObject({ activity: 'task_started', taskId: 'wtask-1', seq: 1, workflowName: 'audit-routes' })
    expect(started.script).toContain("phase('scan')")
    expect(events.at(-1)).toMatchObject({ kind: 'harness', tool: 'Workflow', toolUseId: 'toolu_workflow_1' })
  })

  it('只发出相对上一份快照变化的行，不把重复快照放大成二次方事件量', () => {
    const all = activities(run(workflowFixtureMessages()))
    const progress = all.filter((activity) => activity.activity === 'task_progress')
    expect(progress).toHaveLength(WORKFLOW_FIXTURE_SNAPSHOTS.length)
    // 首帧：3 个阶段 + 3 个排队的 scan agent；之后每帧只含真正变化的 agent 行。
    expect(progress.map((activity) => activity.rows?.length ?? 0)).toEqual([6, 3, 5, 2, 3, 1])
    expect(progress.map((activity) => activity.rowTotal)).toEqual(WORKFLOW_FIXTURE_SNAPSHOTS.map((rows) => rows.length))
    expect(progress.every((activity) => activity.progressObserved === true)).toBe(true)
    expect(all.map((activity) => activity.seq)).toEqual(all.map((_, index) => index + 1))
    expect(progress[0].rows?.[0]).toEqual({ type: 'phase', index: 1, title: 'scan' })
    expect(progress[4].rows).toContainEqual(expect.objectContaining({
      type: 'agent', index: 5, state: 'error', error: 'stalled — no progress for 600s', attempt: 2
    }))
  })

  it('行未变化的进度心跳仍然发出用量，但不重复携带行', () => {
    const c = ctx()
    run(workflowFixtureMessages({ progressSteps: 1 }), c)
    const [heartbeat] = activities(run([{
      type: 'system', subtype: 'task_progress', task_id: 'wtask-1',
      usage: { total_tokens: 9_999, tool_uses: 7, duration_ms: 12_000 },
      workflow_progress: WORKFLOW_FIXTURE_SNAPSHOTS[0]
    }], c))
    expect(heartbeat.rows).toBeUndefined()
    expect(heartbeat).toMatchObject({ rowTotal: 6, progressObserved: true, usage: { totalTokens: 9_999, toolUses: 7, durationMs: 12_000 } })
  })

  it('Provider 没有下发 workflow_progress 时不伪造空行集合', () => {
    const c = ctx()
    run(workflowFixtureMessages({ progressSteps: 0 }), c)
    const [progress] = activities(run([{
      type: 'system', subtype: 'task_progress', task_id: 'wtask-1', description: 'scan: auth.ts',
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 }
    }], c))
    expect(progress).not.toHaveProperty('rows')
    expect(progress).not.toHaveProperty('rowTotal')
    expect(progress).not.toHaveProperty('progressObserved')
  })

  it('无法识别的行只计数，不猜测其含义', () => {
    const c = ctx()
    run(workflowFixtureMessages({ progressSteps: 0 }), c)
    const [progress] = activities(run([{
      type: 'system', subtype: 'task_progress', task_id: 'wtask-1',
      workflow_progress: [
        { type: 'workflow_phase', index: 1, title: 'scan' },
        { type: 'workflow_agent', index: 1, state: 'teleporting' },
        { type: 'workflow_future_row', index: 2 },
        'not-a-row'
      ]
    }], c))
    expect(progress.rows).toEqual([{ type: 'phase', index: 1, title: 'scan' }])
    expect(progress).toMatchObject({ rowTotal: 4, rowsUnrecognized: 3 })
  })

  it('脚本 log 行不算进度行也不算未知行；仅心跳时间变化的运行中 agent 不重复发出', () => {
    const c = ctx()
    run(workflowFixtureMessages({ progressSteps: 2 }), c)
    const beat = WORKFLOW_FIXTURE_SNAPSHOTS[1].map((row) =>
      row.type === 'workflow_agent' ? { ...row, lastProgressAt: 99_999 } : row)
    const [heartbeat] = activities(run([{
      type: 'system', subtype: 'task_progress', task_id: 'wtask-1',
      workflow_progress: [...beat, { type: 'workflow_log', message: 'scan started' }]
    }], c))
    expect(heartbeat.rows).toBeUndefined()
    expect(heartbeat.rowTotal).toBe(WORKFLOW_FIXTURE_SNAPSHOTS[1].length)
    expect(heartbeat).not.toHaveProperty('rowsUnrecognized')
    // A real change on one agent still carries the fresh heartbeat value.
    const moved = beat.map((row) => row.index === 1 && row.type === 'workflow_agent' ? { ...row, toolCalls: 9 } : row)
    const [changed] = activities(run([{ type: 'system', subtype: 'task_progress', task_id: 'wtask-1', workflow_progress: moved }], c))
    expect(changed.rows).toEqual([expect.objectContaining({ type: 'agent', index: 1, toolCalls: 9, lastProgressAt: 99_999 })])
  })

  it('终态与暂停来自 Provider 的 task_notification / task_updated，不由文本推断', () => {
    const c = ctx()
    run(workflowFixtureMessages({ progressSteps: 2 }), c)
    const [paused] = activities(run([{
      type: 'system', subtype: 'task_updated', task_id: 'wtask-1', patch: { status: 'paused' }
    }], c))
    expect(paused).toMatchObject({ activity: 'task_updated', status: 'paused' })
    const [terminal] = activities(run([{
      type: 'system', subtype: 'task_notification', task_id: 'wtask-1', status: 'failed', summary: 'Dynamic workflow failed',
      workflow_progress: WORKFLOW_FIXTURE_SNAPSHOTS[1], workflow_progress_omitted: 4
    }], c))
    expect(terminal).toMatchObject({ activity: 'task_notification', status: 'failed', rowsOmitted: 4, summary: 'Dynamic workflow failed' })
  })

  it('workflow task 事件不进入子 Agent 生命周期，Agent task 事件也不被当成 workflow', () => {
    const events = run(workflowFixtureMessages())
    expect(events.some((event) => event.stage === 'agent_activity')).toBe(false)
    expect(events.filter((event) => event.stage === 'tool_result')).toHaveLength(1)

    const c = ctx()
    const agentEvents = run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'x', prompt: 'x' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'task-a', tool_use_id: 'agent-1', description: 'x' },
      { type: 'system', subtype: 'task_updated', task_id: 'task-a', patch: { status: 'running' } },
      { type: 'system', subtype: 'task_progress', task_id: 'task-a', summary: 'reading' }
    ], c)
    expect(agentEvents.filter((event) => event.stage === 'agent_activity')).toHaveLength(2)
    expect(agentEvents.some((event) => event.stage === 'workflow_activity')).toBe(false)
  })

  it('没有观测到 Workflow tool_use 时，只凭结构化 task_type 识别，不看描述文本', () => {
    const c = ctx()
    const events = run([
      { type: 'system', subtype: 'task_started', task_id: 'w-resumed', task_type: 'local_workflow', workflow_name: 'spec' },
      { type: 'system', subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash', description: 'Dynamic workflow lookalike' }
    ], c)
    expect(activities(events)).toEqual([expect.objectContaining({ taskId: 'w-resumed', workflowName: 'spec', seq: 1 })])
    expect(events[0].toolUseId).toBeUndefined()
  })

  it('复制归一化状态后，两份上下文的行增量互不影响', () => {
    const c = ctx()
    run(workflowFixtureMessages({ progressSteps: 1 }), c)
    const forked: NormalizeCtx = { ...ctx(), workflow: cloneWorkflowNormalizeState(c.workflow!) }
    const next = { type: 'system', subtype: 'task_progress', task_id: 'wtask-1', workflow_progress: WORKFLOW_FIXTURE_SNAPSHOTS[1] }
    expect(activities(run([next], forked))[0].rows).toHaveLength(3)
    expect(activities(run([next], c))[0].rows).toHaveLength(3)
  })
})
