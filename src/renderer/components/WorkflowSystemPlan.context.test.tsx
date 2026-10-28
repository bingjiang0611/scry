import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkflowPlanPreview } from '@shared/workflow'
import { WorkflowSystemPlan } from './WorkflowSystemPlan'

function preview(): WorkflowPlanPreview {
  return { workflowId: 'fixture', programRevision: 'f'.repeat(64), workspace: '/fixture', userGoal: 'fixture',
    orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [], plannedCalls: 0, state: 'ready', unavailableReasons: [], observedAt: 1,
    program: { workflowId: 'fixture', programRevision: 'f'.repeat(64), workspace: '/fixture', userGoal: 'fixture', schemaVersion: 1, roles: [],
      body: { kind: 'sequence', blockId: 'root', blocks: [
        { kind: 'replica', blockId: 'first' },
        { kind: 'parallel', blockId: 'group', blocks: [{ kind: 'replica', blockId: 'second' }, { kind: 'replica', blockId: 'third' }] }
      ] } } }
}

describe('frozen plan source integrity', () => {
  it('inspects platform steps without changing any source order or the frozen revision', () => {
    const source = preview()
    const before = JSON.stringify(source)
    const html = renderToStaticMarkup(<WorkflowSystemPlan preview={source} />)
    expect(html.indexOf('data-workflow-system-node="first"')).toBeLessThan(html.indexOf('data-workflow-system-node="second"'))
    expect(html.indexOf('data-workflow-system-node="second"')).toBeLessThan(html.indexOf('data-workflow-system-node="third"'))
    expect(JSON.stringify(source)).toBe(before)
  })

  it('accepts actually frozen container arrays rather than depending on mutable preview data', () => {
    const source = preview()
    const body = source.program.body
    if (body.kind !== 'sequence') throw new Error('Invalid fixture')
    Object.freeze(body.blocks)
    const nested = body.blocks[1]
    if (nested.kind !== 'parallel') throw new Error('Invalid fixture')
    Object.freeze(nested.blocks)
    expect(() => renderToStaticMarkup(<WorkflowSystemPlan preview={source} />)).not.toThrow()
  })
})
