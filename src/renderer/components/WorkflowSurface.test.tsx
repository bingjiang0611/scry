import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { workflowFixtureMessages } from '@shared/claude-workflow.fixture'
import { type NormalizeCtx, normalizeSdkMessage } from '../../main/normalize'
import type { Turn } from '../format'
import { WORKFLOW_COPY } from '../constants/workflow-copy'
import { WorkflowSurface } from './WorkflowSurface'

function events(messages: Array<Record<string, unknown>>): TraceEvent[] {
  let n = 0
  const ctx: NormalizeCtx = { runId: 'run-1', newId: () => `ev-${n++}`, now: () => '2026-11-10T21:13:00.000Z' }
  return messages.flatMap((message) => normalizeSdkMessage(message, ctx))
}

function render(items: TraceEvent[], partial: Partial<Turn> = {}, busy = false): string {
  const turn: Turn = { runId: 'run-1', userText: 'ultracode', items, done: true, ...partial }
  return renderToStaticMarkup(createElement(WorkflowSurface, { turns: [turn], busy }))
}

describe('WorkflowSurface', () => {
  it('没有 workflow 时说明这是 Claude Code 才有的能力，而不是显示 0 个阶段', () => {
    const html = render([])
    expect(html).toContain(WORKFLOW_COPY.emptyTitle)
    expect(html).not.toContain('workflow-phase')
    expect(html).not.toContain('agents 0/0')
  })

  it('完成的运行显示脚本原文、三个阶段、失败的 agent 与终态来源', () => {
    const html = render(events(workflowFixtureMessages()))
    expect(html).toContain('audit-routes')
    expect(html).toContain('agents 6/6')
    expect(html).toContain('phase(&#x27;scan&#x27;)')
    expect(html.match(/class="workflow-phase"/g)).toHaveLength(3)
    expect(html).toMatch(/class="workflow-phase" data-status="failed"[^>]*aria-label="阶段 edit"/)
    expect(html).toMatch(/data-status="failed"[^>]*aria-label="billing\.ts：失败"/)
    expect(html).toContain('来自 Claude Code 的 task_notification 终态')
    expect(html).toContain(WORKFLOW_COPY.evidenceNote)
  })

  it('运行中的阶段高亮对应的脚本行，尚无 agent 的阶段写明未观测', () => {
    const html = render(events(workflowFixtureMessages({ progressSteps: 4 })), { done: false }, true)
    expect(html).toContain('agents 3/5')
    expect(html.match(/data-active="true"/g)).toHaveLength(1)
    expect(html).toMatch(/data-active="true"[^>]*><code>phase\(&#x27;edit&#x27;\)/)
    expect(html).toContain(WORKFLOW_COPY.phaseEmpty)
    expect(html).toContain(WORKFLOW_COPY.handbackWaiting)
  })

  it('轮次已结束但没有终态时，状态与 agent 都保持未知，不显示完成', () => {
    const html = render(events(workflowFixtureMessages({ progressSteps: 4 })))
    expect(html).toContain('状态未知')
    expect(html).toContain(WORKFLOW_COPY.handbackUnknown)
    expect(html).toMatch(/data-status="unsettled"[^>]*aria-label="auth\.ts：终态未上报"/)
    expect(html).not.toContain('已完成 ·')
  })

  it('Provider 不下发明细与脚本时显示 unavailable 说明', () => {
    const messages = workflowFixtureMessages({ progressSteps: 0 }).map((message) =>
      message.type === 'assistant'
        ? { ...message, message: { content: [{ type: 'tool_use', id: 'toolu_workflow_1', name: 'Workflow', input: { name: 'deep-research' } }] } }
        : message.subtype === 'task_started' ? { ...message, prompt: '' } : message)
    const html = render(events([
      ...messages,
      { type: 'system', subtype: 'task_progress', task_id: 'wtask-1', usage: { total_tokens: 4_200, tool_uses: 6, duration_ms: 9_000 } }
    ]), { done: false }, true)
    expect(html).toContain(WORKFLOW_COPY.progressUnavailable)
    expect(html).toContain(WORKFLOW_COPY.scriptUnavailable('deep-research'))
    expect(html).toContain(WORKFLOW_COPY.mainSessionCall)
    expect(html).toContain('4.2k tokens')
    expect(html).not.toContain('workflow-phase')
  })

  it('活动行先于 tool_use 到达时仍显示“调用了 Workflow 工具”，不是“没有对应的调用”', () => {
    const all = events(workflowFixtureMessages())
    const reordered = [...all.filter((event) => event.kind !== 'tool'), ...all.filter((event) => event.kind === 'tool')]
    const html = render(reordered)
    expect(html).toContain(WORKFLOW_COPY.mainSessionAction)
    expect(html).not.toContain(WORKFLOW_COPY.mainSessionUnobserved)
  })

  it('历史不完整时给出 partial 提示', () => {
    const all = events(workflowFixtureMessages())
    const firstRows = all.findIndex((event) => event.stage === 'workflow_activity' && (event.input as { rows?: unknown[] }).rows)
    const html = render(all.filter((_, index) => index !== firstRows))
    expect(html).toContain(WORKFLOW_COPY.partial)
  })
})
