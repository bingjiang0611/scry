import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WORKFLOW_COPY as copy } from '../constants/copy'
import { WorkflowNodeStopButton } from './WorkflowNodeStopButton'

const props = {
  workflowId: 'root', target: { kind: 'attempt' as const, id: 'attempt' },
  nodeId: 'first', settled: false, onChanged: () => {}
}

describe('node stop evidence presentation', () => {
  it('offers an unsettled admitted target without claiming a stop receipt', () => {
    const html = renderToStaticMarkup(createElement(WorkflowNodeStopButton, props))
    expect(html).toContain(copy.nodeStop)
    expect(html).toContain('data-workflow-target="attempt"')
    expect(html).not.toContain(copy.nodeStopRecorded)
  })

  it('treats a restored main intent as an identity to retry, not an acknowledgment', () => {
    const html = renderToStaticMarkup(createElement(WorkflowNodeStopButton, {
      ...props, stopRequested: { commandId: 'same-command', requestedAt: 1 }
    }))
    expect(html).toContain(copy.nodeStopRetry)
    expect(html).not.toContain(copy.nodeStopRecorded)
    expect(html).not.toContain(copy.nodeStopAgain)
  })

  it('distinguishes an automatic policy receipt from a user retry or acknowledgment', () => {
    const stopRequested = { commandId: 'automatic-command', requestedAt: 1,
      provenance: { source: 'auto' as const, policy: 'fail_fast' as const, trigger: { nodeId: 'failed-node', phase: 'failed' as const, frameId: 'parallel-frame' } } }
    const html = renderToStaticMarkup(createElement(WorkflowNodeStopButton, { ...props, stopRequested }))
    expect(html).toContain(copy.nodeStopAutomatic('failed-node'))
    expect(html).toContain(copy.nodeStopAgain)
    expect(html).not.toContain(copy.nodeStopRetry)
    expect(html).not.toContain(copy.nodeStopRecorded)
    const closed = renderToStaticMarkup(createElement(WorkflowNodeStopButton, { ...props, settled: true, stopRequested }))
    expect(closed).toContain(copy.nodeStopAutomatic('failed-node'))
    expect(closed).toContain(copy.scopeClosed)
    expect(closed).toContain('aria-disabled="true"')
  })

  it('does not offer new stop commands for a settled scope', () => {
    expect(renderToStaticMarkup(createElement(WorkflowNodeStopButton, { ...props, settled: true }))).toBe('')
    const html = renderToStaticMarkup(createElement(WorkflowNodeStopButton, {
      ...props, settled: true, stopRequested: { commandId: 'old-command', requestedAt: 1 }
    }))
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain(copy.scopeClosed)
    expect(html).not.toContain(copy.nodeStopRecorded)
  })
})
