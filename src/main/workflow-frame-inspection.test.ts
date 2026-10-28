import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkflowStore } from './workflow-memory-store'
import { FileWorkflowStore, type WorkflowStore } from './workflow-store'
import { WorkflowService } from './workflow-service'
import { WorkflowSlots } from './workflow-slots'
import { workflowFrameId } from './workflow-frames'
import type { WorkflowServiceOptions } from './workflow-service-contracts'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'

const role = { role: 'orchestrator' as const, providerId: 'codex' as const }
const worker = { role: 'worker' as const, providerId: 'pi' as const, agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } }
const descriptor = (id: ProviderId): ProviderDescriptor => ({ id, label: id, runtimeProvider: id === 'pi' ? 'pi_rpc' : 'codex_cli', transport: 'fixture', available: true,
  capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } })

function fixture(store: WorkflowStore = new MemoryWorkflowStore()) {
  const execute = vi.fn<WorkflowServiceOptions['execute']>(() => ({
    result: Promise.resolve({ runId: 'unused', status: 'completed', output: 'unused', settled: true }), stop: () => true
  }))
  const service = new WorkflowService({ store, slots: new WorkflowSlots(1), providerRegistered: () => true,
    runControls: async value => ({ descriptor: descriptor(value.providerId), model: true, stop: true, identity: 'fixture', independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'available' as const, hostToolsDisabled: 'available' as const }),
    plan: vi.fn<WorkflowServiceOptions['plan']>(async () => ({ output: JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'call', blockId: 'worker_call', role: 'worker', prompt: 'offline' }, { kind: 'return', blockId: 'report', ref: { nodeId: 'worker_call' } }] } }) })), execute })
  return { service, store, execute }
}
async function completed(store: WorkflowStore, commandId: string) {
  const f = fixture(store)
  const preview = await f.service.planCommand({ command: '/scry-workflow run inspect', commandId, workspace: '/fixture', orchestrator: role, roles: [worker] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await f.service.approve(approval)
  expect((await f.service.start(preview.workflowId, approval)).state).toBe('completed')
  const record = (await store.load(preview.workflowId))!
  const intent = record.intents.find(admission => admission.frameId !== undefined)
  expect(intent).toBeDefined()
  return { ...f, preview, record, frameId: intent!.frameId! }
}

describe('bounded canonical frame inspection', () => {
  it('uses authorized context once and returns metadata only without changing canonical outcomes', async () => {
    const store = new MemoryWorkflowStore()
    const f = await completed(store, 'inspect-command')
    const before = structuredClone(f.record.outcomes)
    const load = vi.spyOn(store, 'load')
    const inspection = await f.service.inspectFrame(f.preview, f.frameId)
    expect(load).not.toHaveBeenCalled()
    expect(inspection.state).toBe('available')
    if (inspection.state !== 'available') throw new Error('Expected the actual admitted frame')
    expect(inspection.source).toBe('canonical_frame')
    expect(inspection.frame.frameId).toBe(f.frameId)
    for (const field of ['callInputRef', 'prompt', 'output', 'bindings', 'resultRef']) {
      expect(inspection.frame).not.toHaveProperty(field)
    }
    expect(inspection.frame.parentage.state).toBe('available')
    if (inspection.frame.parentage.state !== 'available') throw new Error('Expected recorded parentage')
    const parent = await f.service.inspectFrame(f.preview, inspection.frame.parentage.frameId)
    expect(parent).toMatchObject({ state: 'available', frame: { nodeId: 'root', parentage: { state: 'root' } } })
    expect((await store.load(f.preview.workflowId))!.outcomes).toEqual(before)
    expect(before.every(outcome => !Object.hasOwn(outcome, 'frameId'))).toBe(true)
    await expect(f.service.inspectFrame(f.preview, 'missing-frame')).resolves.toMatchObject({ state: 'unavailable', reason: 'frame_missing' })
  })

  it('retains canonical ancestry and row references through a new FileStore and Service without re-execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scry-frame-inspection-'))
    try {
      const f = await completed(new FileWorkflowStore(directory), 'inspect-file-command')
      const warm = await f.service.inspectFrame(f.preview, f.frameId)
      const cold = fixture(new FileWorkflowStore(directory))
      const canonicalPreview = await cold.service.preview(f.preview.workflowId)
      const inspection = await cold.service.inspectFrame(canonicalPreview, f.frameId)
      expect(inspection.state).toBe('available')
      if (inspection.state !== 'available' || warm.state !== 'available') throw new Error('Expected persisted canonical frames')
      expect(inspection.frame).toEqual(warm.frame)
      const snapshot = await cold.service.snapshot(f.preview.workflowId)
      const listed = await cold.service.list('/fixture')
      expect(snapshot?.attempts.find(attempt => attempt.frameId === f.frameId)).toBeDefined()
      expect(listed.records.find(record => record.workflowId === f.preview.workflowId)?.attempts.find(attempt => attempt.frameId === f.frameId)).toBeDefined()
      expect((await cold.store.load(f.preview.workflowId))!.outcomes).toEqual(f.record.outcomes)
      await expect(cold.service.inspectFrame({ ...canonicalPreview, workflowId: 'other-root' }, f.frameId)).resolves.toMatchObject({ state: 'unavailable', reason: 'frame_missing' })
      expect(cold.execute).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports absent legacy parentage as unavailable rather than inventing a root', async () => {
    const store = new MemoryWorkflowStore()
    const f = await completed(store, 'inspect-legacy-command')
    const legacyFrameId = workflowFrameId('worker_call', [])
    await store.saveFrame({ schemaVersion: 1, workflowId: f.preview.workflowId, programRevision: f.preview.programRevision,
      frameId: legacyFrameId, nodeId: 'worker_call', scopePath: [], inputKey: 'a'.repeat(64), phase: 'selected', arm: 'then',
      decisionRef: { workflowId: f.preview.workflowId, key: 'decision', hash: 'b'.repeat(64) } }, 0)
    await expect(f.service.inspectFrame(f.preview, legacyFrameId)).resolves.toMatchObject({
      state: 'available', frame: { arm: 'then', parentage: { state: 'unavailable', reason: 'legacy_parentage' } }
    })
    expect(await store.loadFrame(f.preview.workflowId, legacyFrameId)).not.toHaveProperty('parentFrameId')
  })
})
