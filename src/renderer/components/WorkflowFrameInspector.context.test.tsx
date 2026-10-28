import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkflowFrameInspection } from '@shared/workflow-api'
import { WORKFLOW_FRAME_COPY as copy } from '../constants/workflow-frame-copy'
import { WorkflowFrameInspector, WorkflowFrameMetadata } from './WorkflowFrameInspector'

const evidence: Extract<WorkflowFrameInspection, { state: 'available' }> = {
  state: 'available', source: 'canonical_frame', observedAt: 1,
  frame: { frameId: 'current', nodeId: 'worker', programRevision: 'program', phase: 'completed', revision: 2,
    parentage: { state: 'available', frameId: 'parent' } }
}
const noop = () => {}
function render(value = evidence, path = ['current']) {
  return renderToStaticMarkup(<WorkflowFrameMetadata evidence={value} path={path} onFollow={noop} onOutput={noop} />)
}

describe('canonical frame metadata presentation', () => {
  it('shows record state and real parent identity without serializing business fields', () => {
    const extra = { ...evidence, frame: { ...evidence.frame, prompt: 'secret-prompt', bindings: { input: 'secret-input' }, output: 'secret-output' } }
    const html = render(extra)
    expect(html).toContain(copy.phase.completed)
    expect(html).toContain(copy.parent)
    expect(html).toContain('<code>parent</code>')
    expect(html).not.toContain('secret-')
  })
  it('distinguishes legacy unknown parentage from an explicit root', () => {
    const legacy = render({ ...evidence, frame: { ...evidence.frame, parentage: { state: 'unavailable', reason: 'legacy_parentage' } } })
    expect(legacy).toContain(copy.legacy)
    expect(legacy).not.toContain(copy.root)
    const root = render({ ...evidence, frame: { ...evidence.frame, parentage: { state: 'root' } } })
    expect(root).toContain(copy.root)
    expect(root).not.toContain(copy.parent)
  })
  it('blocks a relation back into the current directed path instead of following a cycle', () => {
    const html = render(evidence, ['parent', 'current'])
    expect(html).toContain(copy.cycle)
    expect(html).toContain('disabled=""')
  })
  it('bounds the navigation path and keeps source timestamps visible', () => {
    const html = render(evidence, Array.from({ length: 32 }, (_, index) => `visited-${index}`))
    expect(html).toContain(copy.limit)
    expect(html).toContain('disabled=""')
    expect(html).toContain('<time dateTime="1970-01-01T00:00:00.001Z">')
  })
  it('starts with an accessible loading dialog, not optimistic metadata or physical closure', () => {
    const html = renderToStaticMarkup(<WorkflowFrameInspector workflowId="root" frameId="current" programRevision={'r'.repeat(64)} onClose={noop} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain(copy.loading)
    expect(html).toContain(copy.scope)
    expect(html).not.toContain(copy.phase.completed)
  })
})
