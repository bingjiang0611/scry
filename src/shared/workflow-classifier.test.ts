import { describe, expect, it } from 'vitest'
import { normalizeWorkflowClassifierOutcome, unavailableWorkflowClassifier, validateWorkflowClassifierOutcome, type WorkflowClassifierIntent } from './workflow-classifier'

const intent: WorkflowClassifierIntent = { classifierId: 'classifier-1', workflowId: 'workflow-1', programRevision: 'a'.repeat(64), nodeId: 'decision', frame: { frameId: 'frame-1', revision: 0, resultRef: { workflowId: 'workflow-1', key: 'result', hash: 'b'.repeat(64) } }, checkpointKey: 'checkpoint-1', recoveryGeneration: 'generation-1', createdAt: 1, kind: 'choice', prompt: 'choose', criteria: 'select one', choices: ['a', 'b'], inputRefs: [], inputs: [] }
describe('workflow classifier seam', () => {
  it('defaults explicitly unavailable and never fabricates probability', async () => {
    const outcome = await unavailableWorkflowClassifier(intent)
    expect(outcome).toMatchObject({ state: 'unavailable', provenance: 'unavailable' })
    expect(outcome.probability).toBeUndefined()
  })
  it('requires completed outcomes to carry a typed value, confidence and required probability', () => {
    expect(() => validateWorkflowClassifierOutcome(intent, { classifierId: intent.classifierId, state: 'completed', settled: true, provenance: 'provider', value: 'a' })).toThrow('confidence')
    expect(() => validateWorkflowClassifierOutcome(intent, { classifierId: intent.classifierId, state: 'completed', settled: true, provenance: 'provider', value: 'a', confidence: 0.8 })).toThrow('probability')
  })
  it('preserves valid provider probability, drops invalid usage, and rejects invalid choices', () => {
    const outcome = normalizeWorkflowClassifierOutcome(intent, { state: 'completed', settled: true, value: 'a', probability: { a: 0.8, b: 0.2 }, confidence: 0.8, provenance: 'provider',
      usage: { provenance: 'exact', source: 'none', cost: 1 } })
    expect(validateWorkflowClassifierOutcome(intent, outcome)).toMatchObject({ value: 'a', probability: { a: 0.8, b: 0.2 }, confidence: 0.8 })
    expect(outcome.usage).toBeUndefined()
    expect(() => validateWorkflowClassifierOutcome(intent, { ...outcome, value: 'c' })).toThrow()
  })
})
