import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkflowStore } from './workflow-store'
import { WorkflowService } from './workflow-service'
import type { WorkflowServiceOptions } from './workflow-service-contracts'
import { validateWorkflowClassifierLedgerCanonical } from './workflow-recovery'
import type { WorkflowClassifierAdapter } from '../shared/workflow-classifier'
import type { ProviderDescriptor } from '../shared/provider'

const descriptor: ProviderDescriptor = { id: 'claude', label: 'Claude', runtimeProvider: 'claude_sdk', transport: 'fixture', available: true,
  capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
const body = { kind: 'sequence' as const, blockId: 'root', blocks: [
  { kind: 'bind' as const, blockId: 'evidence', value: { kind: 'literal' as const, value: 'canonical evidence' } },
  { kind: 'classifier' as const, blockId: 'decision', classifierId: 'decision', classifier: 'bool' as const, prompt: 'is it valid?', criteria: 'use the evidence', threshold: { min: 0.8 }, inputRefs: [{ nodeId: 'evidence' }] },
  { kind: 'return' as const, blockId: 'finish', ref: { nodeId: 'decision' } }
] }

function fixture(store = new MemoryWorkflowStore(), classifierAdapter?: WorkflowClassifierAdapter) {
  const plan = vi.fn(async () => ({ output: JSON.stringify({ body }) }))
  const execute = vi.fn<WorkflowServiceOptions['execute']>(() => ({ result: Promise.resolve({ runId: 'unused', status: 'completed' as const, settled: true }), stop: () => true }))
  const service = new WorkflowService({ store, plan, execute, classifierAdapter, providerRegistered: () => true,
    runControls: async () => ({ descriptor, model: true, stop: true, identity: 'fixture', independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }) })
  return { service, store, plan, execute }
}

async function start(f: ReturnType<typeof fixture>) {
  const preview = await f.service.planCommand({ commandId: 'plan-' + Math.random(), command: '/scry-workflow run classifier test', workspace: '/fixture', orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await f.service.approve(approval)
  return { preview, progress: await f.service.start(preview.workflowId, approval) }
}

describe('classifier canonical runner and service recovery', () => {
  it('records unavailable by default and refuses replay after a durable outcome', async () => {
    const first = fixture()
    const run = await start(first)
    expect(run.progress.state).toBe('blocked')
    const record = await first.store.load(run.preview.workflowId)
    expect(record?.classifierIntents?.[0]).toMatchObject({ inputRefs: [{ nodeId: 'evidence' }], inputs: [{ nodeId: 'evidence', value: { state: 'known', value: 'canonical evidence' }, valueRef: { key: expect.stringMatching(/^classifier_input_/) } }], frame: { resultRef: { key: expect.stringMatching(/^classifier_intent_/) } } })
    expect(record?.classifierOutcomes?.[0]).toMatchObject({ state: 'unavailable', settled: true })
    const cold = fixture(first.store)
    await expect(cold.service.start(run.preview.workflowId, { workflowId: run.preview.workflowId, programRevision: run.preview.programRevision, approvedAt: 1 })).rejects.toThrow()
    expect(cold.plan).not.toHaveBeenCalled()
    expect(cold.execute).not.toHaveBeenCalled()
  })

  it('accepts a valid completed classifier through the value store and blocks low confidence', async () => {
    const adapter = vi.fn(async intent => ({ classifierId: intent.classifierId, state: 'completed' as const, settled: true, value: true, confidence: 0.9, probability: { true: 0.9, false: 0.1 }, provenance: 'provider' as const }))
    const valid = fixture(new MemoryWorkflowStore(), adapter)
    const completed = await start(valid)
    expect(completed.progress.state).toBe('completed')
    const completedRecord = await valid.store.load(completed.preview.workflowId)
    expect(completedRecord?.classifierOutcomes?.[0]).toMatchObject({ state: 'completed', value: true, confidence: 0.9, resultRef: { key: expect.any(String), hash: expect.any(String) } })
    expect(adapter).toHaveBeenCalledOnce()
    expect(adapter.mock.calls[0][0].inputs[0]?.valueRef.key).toMatch(/^classifier_input_/)
    const tampered = { ...completedRecord!, classifierIntents: completedRecord!.classifierIntents!.map(intent => ({ ...intent, prompt: 'tampered' })) }
    await expect(validateWorkflowClassifierLedgerCanonical(tampered, valid.store)).rejects.toThrow()
    ;(valid.store as unknown as { records: Map<string, unknown> }).records.set(completed.preview.workflowId, tampered)
    const coldTampered = fixture(valid.store)
    await expect(coldTampered.service.start(completed.preview.workflowId, { workflowId: completed.preview.workflowId, programRevision: completed.preview.programRevision, approvedAt: 1 })).rejects.toThrow()
    await expect(valid.store.loadValue(completed.preview.workflowId, adapter.mock.calls[0][0].inputs[0]!.valueRef)).resolves.toMatchObject({ state: 'known', value: 'canonical evidence' })

    const low = fixture(new MemoryWorkflowStore(), async intent => ({ classifierId: intent.classifierId, state: 'completed' as const, settled: true, value: true, confidence: 0.2, probability: { true: 0.2, false: 0.8 }, provenance: 'provider' as const }))
    const blocked = await start(low)
    expect(blocked.progress.state).toBe('blocked')
    expect((await low.store.load(blocked.preview.workflowId))?.classifierOutcomes?.[0]).toMatchObject({ state: 'blocked', settled: true, reason: expect.stringContaining('threshold') })
  })
})
