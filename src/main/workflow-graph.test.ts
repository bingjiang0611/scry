import { describe, expect, it } from 'vitest'
import { projectWorkflowGraph } from './workflow-graph'

describe('workflow graph inspection projection', () => {
  it('does not claim standalone control frames without a bounded Main frame list', () => {
    const nodes = projectWorkflowGraph([], [{ schemaVersion: 1, workflowId: 'w', programRevision: 'a'.repeat(64), frameId: 'f', nodeId: 'branch', scopePath: [], parentFrameId: null, inputKey: 'i', revision: 0, phase: 'completed' }],
      [{ classifierId: 'classifier-1', state: 'unavailable', settled: true, provenance: 'unavailable' }],
      [{ operationId: 'application-1', requestFingerprint: 'a'.repeat(64), state: 'unknown', requestedAt: 1, baseHash: 'b', candidateHash: 'c', trustFingerprint: 'd' }])
    expect(nodes.map(node => node.kind)).toEqual(['classifier', 'application'])
    expect(nodes.every(node => node.provenance === 'canonical_ledger')).toBe(true)
  })
})
