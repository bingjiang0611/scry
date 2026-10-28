import { describe, expect, it } from 'vitest'
import { enqueueWorkflowClassifier } from './workflow-classifier'
import { WorkflowSlots } from './workflow-runner'
import type { WorkflowClassifierIntent } from '../shared/workflow-classifier'

const intent: WorkflowClassifierIntent = { classifierId: 'c', workflowId: 'w', programRevision: 'a'.repeat(64), nodeId: 'n', frame: { frameId: 'f', revision: 0, resultRef: { workflowId: 'w', key: 'r', hash: 'b'.repeat(64) } }, checkpointKey: 'cp', recoveryGeneration: 'g', createdAt: 1, kind: 'score', prompt: 'score', criteria: 'score it', score: { min: 0, max: 10 }, inputRefs: [], inputs: [] }
describe('runner classifier slot seam', () => {
  it('blocks a completed result below the frozen confidence threshold', async () => {
    const thresholdIntent = { ...intent, threshold: { min: 0.8 } }
    const run = enqueueWorkflowClassifier(new WorkflowSlots(1), thresholdIntent, async () => ({ classifierId: 'c', state: 'completed', settled: true, value: 7, confidence: 0.4, provenance: 'provider' }))
    await expect(run.outcome).resolves.toMatchObject({ state: 'blocked', settled: true, reason: expect.stringContaining('threshold') })
  })
  it('uses the shared slot queue and preserves a provider score', async () => {
    const run = enqueueWorkflowClassifier(new WorkflowSlots(1), intent, async () => ({ classifierId: 'c', state: 'completed', settled: true, value: 7, confidence: 0.9, provenance: 'provider' }))
    await expect(run.outcome).resolves.toMatchObject({ value: 7, confidence: 0.9 })
    await expect(run.settled).resolves.toBeUndefined()
  })
})
