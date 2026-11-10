import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { readWorkflowActivity } from '../shared/claude-workflow'
import { workflowFixtureMessages } from '../shared/claude-workflow.fixture'
import { type NormalizeCtx, normalizeSdkMessage } from './normalize'
import { mergeTraceItems } from './session-history-trace-merge'

function liveEvents(): TraceEvent[] {
  let n = 0
  const ctx: NormalizeCtx = { runId: 'run-1', newId: () => `live-${n++}`, now: () => `2026-11-10T00:00:${String(n).padStart(2, '0')}.000Z` }
  return workflowFixtureMessages().flatMap((message) => normalizeSdkMessage(message, ctx))
}

describe('mergeTraceItems with workflow activity', () => {
  it('归档里的 workflow 进度增量逐条保留，不因共用 tool_use_id 被合并成一条', () => {
    const archive = liveEvents()
    // The Provider transcript only carries the tool call and its result, never task_* events.
    const transcript = archive
      .filter((event) => event.kind === 'tool')
      .map((event, index) => ({ ...event, id: `transcript-${index}` }))
    const merged = mergeTraceItems(transcript, archive)

    const liveActivity = archive.filter((event) => event.stage === 'workflow_activity')
    const mergedActivity = merged.filter((event) => event.stage === 'workflow_activity')
    expect(liveActivity.length).toBeGreaterThan(5)
    expect(mergedActivity.map((event) => readWorkflowActivity(event.input)?.seq))
      .toEqual(liveActivity.map((event) => readWorkflowActivity(event.input)?.seq))
    // The tool call itself is still one logical call: transcript copy wins, archive copy is dropped.
    expect(merged.filter((event) => event.kind === 'tool' && event.stage !== 'tool_result')).toHaveLength(1)
    expect(merged.filter((event) => event.stage === 'tool_result')).toHaveLength(1)
  })

  it('同一条 workflow 进度事件在两侧重复出现时仍只保留一份', () => {
    const archive = liveEvents()
    const merged = mergeTraceItems(archive.map((event) => ({ ...event, id: `copy-${event.id}` })), archive)
    expect(merged.filter((event) => event.stage === 'workflow_activity'))
      .toHaveLength(archive.filter((event) => event.stage === 'workflow_activity').length)
  })
})
