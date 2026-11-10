import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { WORKFLOW_FIXTURE_SNAPSHOTS, workflowFixtureMessages } from '@shared/claude-workflow.fixture'
import { type NormalizeCtx, normalizeSdkMessage } from '../main/normalize'
import type { Turn } from './format-types'
import { deriveWorkflowRuns, workflowRunForToolUse } from './workflow-runs'

function events(messages: Array<Record<string, unknown>>): TraceEvent[] {
  let n = 0
  const ctx: NormalizeCtx = { runId: 'run-1', newId: () => `ev-${n++}`, now: () => `2026-11-10T00:00:${String(n).padStart(2, '0')}.000Z` }
  return messages.flatMap((message) => normalizeSdkMessage(message, ctx))
}

function turn(items: TraceEvent[], partial: Partial<Turn> = {}): Turn {
  return { runId: 'run-1', userText: 'ultracode: audit routes', items, done: true, ...partial }
}

describe('deriveWorkflowRuns', () => {
  it('从完整事件流折叠出阶段、agent 与终态', () => {
    const [run, ...rest] = deriveWorkflowRuns([turn(events(workflowFixtureMessages()))], { busy: false })
    expect(rest).toEqual([])
    expect(run).toMatchObject({
      toolUseId: 'toolu_workflow_1', taskId: 'wtask-1', providerRunId: 'wf_run_1', name: 'audit-routes',
      status: 'completed', statusSource: 'task_notification', progress: 'observed', partial: false, agentCount: 6,
      usage: { totalTokens: 26_600, toolUses: 32, durationMs: 31_000 }
    })
    expect(run.script).toMatchObject({ source: 'tool_input', truncated: false, phaseLines: { scan: 7, edit: 12, verify: 17 } })
    expect(run.phases.map((phase) => [phase.title, phase.status, phase.agents.length, phase.settled, phase.failed])).toEqual([
      ['scan', 'done', 3, 3, 0],
      ['edit', 'failed', 2, 2, 1],
      ['verify', 'done', 1, 1, 0]
    ])
    expect(run.phases[0].models).toEqual(['claude-haiku-4-5'])
    expect(run.phases[1].agents.map((agent) => agent.status)).toEqual(['done', 'failed'])
  })

  it('运行中的轮次保持 running，并只统计已观测到的 agent', () => {
    const [run] = deriveWorkflowRuns(
      [turn(events(workflowFixtureMessages({ progressSteps: 4 })), { done: false })], { busy: true })
    expect(run).toMatchObject({ status: 'running', statusSource: 'task_started', agentCount: 5 })
    expect(run.phases.map((phase) => [phase.title, phase.status, phase.running])).toEqual([
      ['scan', 'done', 0], ['edit', 'running', 2], ['verify', 'pending', 0]
    ])
  })

  it('所属轮次结束但 Provider 没有上报终态时显示 unknown，未结束的 agent 不算完成', () => {
    const [run] = deriveWorkflowRuns([turn(events(workflowFixtureMessages({ progressSteps: 4 })))], { busy: false })
    expect(run).toMatchObject({ status: 'unknown', statusSource: 'missing_terminal' })
    const edit = run.phases[1]
    expect(edit.agents.map((agent) => agent.status)).toEqual(['unsettled', 'unsettled'])
    expect(edit).toMatchObject({ settled: 0, failed: 0, status: 'unsettled' })
  })

  it('Provider 未下发行数据时进度为 unavailable，而不是 0 个 agent 的完成态', () => {
    const messages = [
      ...workflowFixtureMessages({ progressSteps: 0 }),
      { type: 'system', subtype: 'task_progress', task_id: 'wtask-1', usage: { total_tokens: 5, tool_uses: 1, duration_ms: 9 } },
      { type: 'system', subtype: 'task_notification', task_id: 'wtask-1', status: 'completed', summary: 'done' }
    ]
    const [run] = deriveWorkflowRuns([turn(events(messages))], { busy: false })
    expect(run).toMatchObject({ status: 'completed', progress: 'unavailable', agentCount: 0, phases: [] })
  })

  it('历史里缺少较早的增量事件时标记 partial', () => {
    const all = events(workflowFixtureMessages())
    const firstProgress = all.findIndex((event) => event.stage === 'workflow_activity' && (event.input as { rows?: unknown[] }).rows)
    const trimmed = all.filter((_, index) => index !== firstProgress)
    const [run] = deriveWorkflowRuns([turn(trimmed)], { busy: false })
    expect(run.partial).toBe(true)
    expect(run.status).toBe('completed')
  })

  it('启动失败来自 tool_result，不显示成运行中', () => {
    const [launch] = workflowFixtureMessages({ progressSteps: 0 })
    const [run] = deriveWorkflowRuns([turn(events([
      launch,
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_workflow_1', content: 'SyntaxError: Unexpected token', is_error: true }] }
      }
    ]))], { busy: false })
    expect(run).toMatchObject({ status: 'failed', statusSource: 'launch_error', progress: 'pending', agentCount: 0 })
    expect(run.error).toContain('SyntaxError')
  })

  it('没有 tool_use 的 task 事件仍成为独立运行，脚本来自 task_started', () => {
    const messages = workflowFixtureMessages().slice(2)
    const [run] = deriveWorkflowRuns([turn(events(messages))], { busy: false })
    expect(run).toMatchObject({ id: 'task:wtask-1', status: 'completed', agentCount: 6 })
    expect(run.script?.source).toBe('task_started')
    // The id comes from the task event itself, not from an observed tool call.
    expect(run.toolUseId).toBe('toolu_workflow_1')
    // The tool_use event itself is missing here; the panel must say so.
    expect(run.toolCallObserved).toBe(false)
    expect(run.log[0].message).not.toContain('调用 Workflow 工具')
  })

  it('活动行先于 tool_use 到达时仍是一次运行，不出现“状态未知”的第二个运行', () => {
    // History merge can order rows by timestamp, so the task rows may precede the tool call.
    const all = events(workflowFixtureMessages())
    const reordered = [...all.filter((event) => event.kind !== 'tool'), ...all.filter((event) => event.kind === 'tool')]
    const runs = deriveWorkflowRuns([turn(reordered)], { busy: false })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'completed', statusSource: 'task_notification', agentCount: 6, toolCallObserved: true })
    expect(workflowRunForToolUse(runs, 'toolu_workflow_1')).toBe(runs[0])
  })

  it('聊天卡片按 tool_use id 找到自己的运行，同会话两次运行不互相顶替', () => {
    const first = events(workflowFixtureMessages({ taskId: 'wtask-1', toolUseId: 'toolu_workflow_1' }))
    const second = events(workflowFixtureMessages({ taskId: 'wtask-2', toolUseId: 'toolu_workflow_2' }))
    const turns: Turn[] = [
      { runId: 'run-1', userText: 'first', items: first, done: true },
      { runId: 'run-2', userText: 'second', items: second, done: true }
    ]
    const runs = deriveWorkflowRuns(turns, { busy: false })
    expect(runs).toHaveLength(2)
    expect(workflowRunForToolUse(runs, 'toolu_workflow_1')?.taskId).toBe('wtask-1')
    expect(workflowRunForToolUse(runs, 'toolu_workflow_2')?.taskId).toBe('wtask-2')
    // An unloaded or foreign tool call selects nothing instead of the newest run.
    expect(workflowRunForToolUse(runs, 'toolu_missing')).toBeUndefined()
    expect(workflowRunForToolUse(runs, null)).toBeUndefined()
  })

  it('日志按状态转换生成且有上限，不为纯用量心跳刷屏', () => {
    const [run] = deriveWorkflowRuns([turn(events(workflowFixtureMessages()))], { busy: false })
    expect(run.logDropped).toBe(0)
    const messages = run.log.map((entry) => entry.message)
    expect(messages[0]).toBe('调用 Workflow 工具')
    expect(messages.filter((message) => message.includes('auth.ts'))).toEqual([
      'scan · auth.ts 排队', 'scan · auth.ts 开始', 'scan · auth.ts 完成 · auth.ts: 1 finding',
      'edit · auth.ts 排队', 'edit · auth.ts 开始', 'edit · auth.ts 完成 · patched'
    ])
    expect(run.log.at(-1)).toMatchObject({ actor: 'runtime', tone: 'ok' })
    expect(run.log.some((entry) => entry.tone === 'error' && entry.message.includes('billing.ts 失败'))).toBe(true)
    expect(WORKFLOW_FIXTURE_SNAPSHOTS.length).toBeGreaterThan(0)
  })
})
