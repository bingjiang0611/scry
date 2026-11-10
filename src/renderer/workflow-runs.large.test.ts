import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { workflowFixtureLargeMessages } from '@shared/claude-workflow.fixture'
import { type NormalizeCtx, normalizeSdkMessage } from '../main/normalize'
import type { Turn } from './format-types'
import { WorkflowFlow } from './components/WorkflowFlow'
import { WorkflowSurface } from './components/WorkflowSurface'
import { deriveWorkflowRuns } from './workflow-runs'

function events(agentCount: number, snapshots = 6): TraceEvent[] {
  let n = 0
  const ctx: NormalizeCtx = { runId: 'run-large', newId: () => `ev-${n++}`, now: () => '2026-11-10T00:00:00.000Z' }
  return workflowFixtureLargeMessages({ agentCount, snapshots }).flatMap((message) => normalizeSdkMessage(message, ctx))
}

const turn = (items: TraceEvent[]): Turn => ({ runId: 'run-large', userText: 'large fan-out', items, done: true })

describe('workflow projection at fan-out scale', () => {
  it('1,000 个 agent 折叠成一次运行，阶段与 agent 数来自事件', () => {
    const [run, ...rest] = deriveWorkflowRuns([turn(events(1_000))], { busy: false })
    expect(rest).toEqual([])
    expect(run.agentCount).toBe(1_000)
    expect(run.phases.map((phase) => [phase.title, phase.agents.length])).toEqual([['scan', 500], ['fan', 500]])
    expect(run.status).toBe('completed')
    expect(run.log.length).toBeLessThanOrEqual(300)
  })

  it('每阶段最多渲染 48 个 chip，其余明确写成“还有 N 个”', () => {
    const [run] = deriveWorkflowRuns([turn(events(1_000))], { busy: false })
    const html = renderToStaticMarkup(createElement(WorkflowFlow, { run }))
    const chips = html.match(/class="workflow-agent-chip"/g) ?? []
    expect(chips.length).toBe(96) // 48 per phase
    expect(html).toContain('workflow-phase-more')
    expect(html).toContain('452') // 500 - 48 in the first phase
  })

  it('超出上限的运行在面板上说明省略了多少行，而不是当作完整运行', () => {
    const [run] = deriveWorkflowRuns([turn(events(3_000, 2))], { busy: false })
    expect(run.agentCount).toBe(2_046)
    expect(run.rowsOmitted).toBeGreaterThan(0)
    // The log is capped too, and the dropped count is kept so the panel can say so.
    expect(run.log.length).toBeLessThanOrEqual(300)
    expect(run.logDropped).toBeGreaterThan(0)
    const html = renderToStaticMarkup(createElement(WorkflowSurface, { turns: [turn(events(3_000, 2))], busy: false }))
    expect(html).toContain('被省略')
  })

  it('流式更新下折叠 1,000 个 agent 的耗时（累计，单次运行）', () => {
    const all = events(1_000)
    const started = performance.now()
    let runs = 0
    for (let step = 1; step <= 40; step++) {
      const slice = all.slice(0, Math.ceil((all.length * step) / 40))
      runs += deriveWorkflowRuns([turn(slice)], { busy: true }).length
    }
    const elapsed = performance.now() - started
    console.log(JSON.stringify({ deriveUpdates: 40, runs, deriveTotalMs: Math.round(elapsed) }))
    // 40 full re-folds over a 1,000-agent history must stay well under a second per frame budget.
    expect(elapsed).toBeLessThan(3_000)
  })
})
