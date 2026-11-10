import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { WORKFLOW_ROWS_PER_EVENT, readWorkflowActivity, type WorkflowRow } from '../shared/claude-workflow'
import { workflowFixtureLargeMessages } from '../shared/claude-workflow.fixture'
import { type NormalizeCtx, normalizeSdkMessage } from './normalize'

function events(messages: Array<Record<string, unknown>>): TraceEvent[] {
  let n = 0
  const ctx: NormalizeCtx = { runId: 'run-large', newId: () => `ev-${n++}`, now: () => '2026-11-10T00:00:00.000Z' }
  return messages.flatMap((message) => normalizeSdkMessage(message, ctx))
}

const activities = (list: TraceEvent[]) => list
  .filter((event) => event.stage === 'workflow_activity')
  .map((event) => readWorkflowActivity(event.input)!)

describe('normalizeWorkflow at fan-out scale', () => {
  it('1,000 个 agent：每个事件最多 128 行，行序号连续，不丢行', () => {
    const items = activities(events(workflowFixtureLargeMessages({ agentCount: 1_000 })))
    expect(items.length).toBeGreaterThan(0)
    for (const activity of items) expect(activity.rows?.length ?? 0).toBeLessThanOrEqual(WORKFLOW_ROWS_PER_EVENT)
    // seq is the per-task counter the renderer uses to detect missing history.
    expect(items.map((activity) => activity.seq)).toEqual(items.map((_, index) => index + 1))
    // rowTotal counts every row of the provider snapshot, phases included.
    const first = items.find((activity) => activity.rowTotal !== undefined)
    expect(first?.rowTotal).toBe(1_002)
    expect(items.reduce((sum, activity) => sum + (activity.rowsUnrecognized ?? 0), 0)).toBe(0)
    // Every agent is delivered exactly once across the delta chain.
    const delivered = new Set(items.flatMap((activity) => (activity.rows ?? [])
      .filter((row): row is Extract<WorkflowRow, { type: 'agent' }> => row.type === 'agent')
      .map((row) => row.index)))
    expect(delivered.size).toBe(1_000)
  })

  it('3,000 个 agent：跟踪行数封顶 2,048（含阶段行），超出部分显式计数而不是静默丢弃', () => {
    const items = activities(events(workflowFixtureLargeMessages({ agentCount: 3_000, snapshots: 2 })))
    const tracked = new Set(items.flatMap((activity) => (activity.rows ?? [])
      .filter((row): row is Extract<WorkflowRow, { type: 'agent' }> => row.type === 'agent')
      .map((row) => row.index)))
    // The cap is on tracked rows, and the two phase rows occupy part of it.
    expect(tracked.size).toBe(2_046)
    expect(items.some((activity) => (activity.rowsOmitted ?? 0) > 0)).toBe(true)
  })

  it('1,000 个 agent、6 份快照的归一化耗时（单次，含分片）', () => {
    const messages = workflowFixtureLargeMessages({ agentCount: 1_000 })
    const started = performance.now()
    const items = events(messages)
    const elapsed = performance.now() - started
    console.log(JSON.stringify({ largeNormalizeMs: Math.round(elapsed), events: items.length, messages: messages.length }))
    // Generous bound: catches an accidental per-row rescan, not machine noise.
    expect(elapsed).toBeLessThan(2_000)
  })
})
