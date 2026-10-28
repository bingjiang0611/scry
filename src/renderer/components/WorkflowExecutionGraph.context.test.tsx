import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkflowExecutionInspectionRecord } from '@shared/workflow-inspection'
import type { WorkflowFrameInspection } from '@shared/workflow-api'
import { WORKFLOW_INSPECTION_COPY as copy } from '../constants/workflow-inspection-copy'
import { WorkflowExecutionGraph, workflowGraphItems } from './WorkflowExecutionGraph'

const attempt: WorkflowExecutionInspectionRecord = {
  attemptId: 'attempt-2', taskId: 'workflow:worker',
  intent: { state: 'available', value: { nodeId: 'worker', programRevision: 'revision', createdAt: 1, role: 'worker', providerId: 'pi', previousAttemptId: 'attempt-1', retryCommandId: 'retry-1', frame: { state: 'available', frameId: 'frame-2' } } },
  outcome: { state: 'available', value: { nodeId: 'worker', role: 'worker', providerId: 'pi', actualModelStatus: 'unknown', state: 'completed', settled: true } }
}
const frame: Extract<WorkflowFrameInspection, { state: 'available' }> = {
  state: 'available', source: 'canonical_frame', observedAt: 1,
  frame: { frameId: 'frame-2', nodeId: 'worker', programRevision: 'revision', phase: 'completed', revision: 2, arm: 'then', parentage: { state: 'root' } }
}

describe('same-source workflow execution graph', () => {
  it('projects retry, branch and unavailable usage without inventing output evidence', () => {
    const [item] = workflowGraphItems([attempt], new Map([['frame-2', frame]]))
    expect(item).toMatchObject({ category: 'turn', nodeId: 'worker', retryOf: 'attempt-1', retryCommand: 'retry-1', branch: 'then', usage: 'unavailable' })
  })

  it('starts as a read-only bounded view and does not expose reinjection controls', () => {
    const html = renderToStaticMarkup(<WorkflowExecutionGraph workflowId="workflow" preview={{} as never} onFrame={() => undefined} onOutput={() => undefined} />)
    expect(html).toContain(copy.graph)
    expect(html).toContain(copy.graphLoading)
    expect(html).not.toContain('回注')
  })
})
