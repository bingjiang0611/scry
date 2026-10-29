import { mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock } from '../shared/workflow'
import { FileWorkflowStore, type WorkflowStoreRecord } from './workflow-store'
import { storageProbe } from './workflow-storage-probe.fixture'
import { workflowFrameId } from './workflow-frames'
import { fixture, roots } from './workflow-system.fixture'

async function setup(following = false) {
  const directory = await realpath(await mkdtemp('/tmp/scry-native-checkpoint-'))
  roots.push(directory)
  const store = new FileWorkflowStore(directory), f = await fixture(0, store)
  const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'candidate' },
    ...(following ? [{ kind: 'call' as const, blockId: 'next', role: 'orchestrator' as const, prompt: 'must wait for the native frame' }] : []),
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'candidate' } }
  ] }
  const { service } = f.create(store, body)
  const preview = await service.planCommand({ workspace: f.source, command: '/scry-workflow run native checkpoint', orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await service.approve(approval)
  return { ...f, service, store, directory, preview, approval }
}

describe('canonical native result frame checkpoint', () => {
  it('cold-reads the exact durable main outcome reference instead of another value copy', async () => {
    const f = await setup()
    const progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress.state).toBe('completed')
    const cold = new FileWorkflowStore(f.directory), record = (await cold.load(f.preview.workflowId))!
    const frame = await cold.loadFrame(f.preview.workflowId, workflowFrameId('candidate', ['revision:' + f.preview.programRevision]))
    expect(record.systemOutcomes).toHaveLength(1)
    const outcome = record.systemOutcomes![0]
    expect(frame).toMatchObject({ phase: 'completed', resultRef: outcome.resultRef })
    expect(frame!.resultRef).toEqual(outcome.resultRef)
    expect(await cold.loadValue(f.preview.workflowId, frame!.resultRef!)).toMatchObject({ state: 'known', value: outcome.replica, replica: outcome.replica })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('retains the committed native fact but does not advance when the real frame CAS rejects publication', async () => {
    const f = await setup(true), save = f.store.saveFrame.bind(f.store)
    let committedBeforeFrame = false
    const publication = vi.spyOn(f.store, 'saveFrame').mockImplementation(async (frame, revision) => {
      if (frame.nodeId === 'candidate' && frame.phase === 'completed') {
        // A must already be visible to an independent canonical reader before
        // attempting B, not reconstructed by failure handling after B rejects.
        const record = JSON.parse(await storageProbe.readMetadata(join(f.directory, 'workflows', f.preview.workflowId + '.json'))) as WorkflowStoreRecord
        committedBeforeFrame = record.systemOutcomes?.length === 1 && record.systemOutcomes[0].state === 'completed' && record.systemOutcomes[0].settled === true
        return save(frame, revision - 1)
      }
      return save(frame, revision)
    })
    try {
      await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow()
      expect(committedBeforeFrame).toBe(true)
      expect(f.execute).not.toHaveBeenCalled()
      const cold = new FileWorkflowStore(f.directory), record = (await cold.load(f.preview.workflowId))!
      expect(record.progress.state).toBe('failed')
      expect(record.progress.dispatchAttempts).toBe(0)
      expect(record.systemOutcomes).toHaveLength(1)
      expect(record.systemOutcomes![0]).toMatchObject({ state: 'completed', settled: true })
      expect(await cold.loadValue(f.preview.workflowId, record.systemOutcomes![0].resultRef!)).toMatchObject({ state: 'known' })
      const frame = await cold.loadFrame(f.preview.workflowId, workflowFrameId('candidate', ['revision:' + f.preview.programRevision]))
      expect(frame).toMatchObject({ phase: 'entered' })
      expect(frame!.resultRef).toBeUndefined()
    } finally { publication.mockRestore() }
  })
})
