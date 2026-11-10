import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { workflowFixtureMessages } from '@shared/claude-workflow.fixture'
import { type NormalizeCtx, normalizeSdkMessage } from '../../main/normalize'
import type { Turn } from '../format'
import { analyzeBilling } from '../format-billing'
import { WORKFLOW_COPY } from '../constants/workflow-copy'
import { WorkflowSurface } from './WorkflowSurface'

function events(messages: Array<Record<string, unknown>>): TraceEvent[] {
  let n = 0
  const ctx: NormalizeCtx = { runId: 'run-1', newId: () => `ev-${n++}`, now: () => '2026-11-10T00:00:00.000Z' }
  return messages.flatMap((message) => normalizeSdkMessage(message, ctx))
}

/** The provider's turn result stays the only source for turn totals. */
const turnResult: TraceEvent = {
  id: 'result-1', runId: 'run-1', ts: '2026-11-10T00:01:00.000Z', kind: 'harness', stage: 'result',
  text: 'claude result', tokensIn: 1_000, tokensOut: 200, durationMs: 60_000
}

const turnOf = (items: TraceEvent[]): Turn => ({
  runId: 'run-1', userText: 'ultracode: audit routes', items: [...items, turnResult], done: true
})

describe('workflow usage is not counted twice', () => {
  it('任务级用量只来自 workflow 事件，总览只认 Provider 的 result', () => {
    const turn = turnOf(events(workflowFixtureMessages()))
    const analysis = analyzeBilling([turn])
    // task_notification carries 26,600 tokens for the workflow's agents; if that leaked into the
    // turn total the number would be 27,800.
    expect(analysis.totalTokens).toBe(1_200)
    expect(analysis.tokensIn).toBe(1_000)
    expect(analysis.tokensOut).toBe(200)
  })

  it('面板把任务级用量标成 workflow 自己的数字，而不是本会话总量', () => {
    const html = renderToStaticMarkup(createElement(WorkflowSurface, { turns: [turnOf(events(workflowFixtureMessages()))], busy: false }))
    // 26.6k comes from the workflow task events (see the fixture), formatted by fmtTok.
    expect(html).toContain('26.6k')
    expect(html).toContain(WORKFLOW_COPY.usageNote)
    // The turn's own 1.2k total belongs to the turn footer and must not appear as task usage.
    expect(html).not.toContain('>1.2k<')
  })
})
