import { mkdtemp, open, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowProgress } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'
import { workflowFrameId } from './workflow-frames'
import { fixture, roots } from './workflow-system.fixture'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

async function setup() {
  const directory = await realpath(await mkdtemp('/tmp/scry-sequence-checkpoint-'))
  roots.push(directory)
  const store = new FileWorkflowStore(directory), f = await fixture(0, store)
  const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'bind', blockId: 'seed', value: { kind: 'literal', value: 1 } },
    { kind: 'sequence', blockId: 'nested', blocks: [{ kind: 'call', blockId: 'work', role: 'orchestrator', prompt: 'known' }] },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'nested' } }
  ] }
  f.execute.mockImplementation(() => ({ result: Promise.resolve({ runId: randomUUID(), status: 'completed', settled: true, actualModel: 'fixture-model', output: 'known' }), stop: () => true }))
  const { service } = f.create(store, body)
  const preview = await service.planCommand({ workspace: f.source, command: '/scry-workflow run sequence checkpoint', orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await service.approve(approval)
  const frameId = (node: string) => workflowFrameId(node, ['revision:' + preview.programRevision])
  return { ...f, directory, store, service, preview, approval, body, frameId }
}

describe('terminal sequence child checkpoint', () => {
  it('cold-reads the final child link and result without a separate final entered-parent publication', async () => {
    const f = await setup(), publications = vi.spyOn(f.store, 'saveFrame')
    try {
      expect((await f.service.start(f.preview.workflowId, f.approval)).state).toBe('completed')
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect(publications.mock.calls.filter(([frame]) => frame.nodeId === 'nested' && frame.phase === 'entered').map(([frame]) => frame.cursor ?? 0)).toEqual([0])
      const cold = new FileWorkflowStore(f.directory), parent = (await cold.loadFrame(f.preview.workflowId, f.frameId('nested')))!
      expect(parent).toMatchObject({ phase: 'completed', cursor: 1 })
      expect(parent.children).toHaveLength(1)
      const child = (await cold.loadFrame(f.preview.workflowId, f.frameId('work')))!
      expect(parent.children![0]).toEqual({ frameId: child.frameId, revision: child.revision, resultRef: child.resultRef })
      expect(await cold.loadValue(f.preview.workflowId, parent.resultRef!)).toMatchObject({ state: 'known', value: 'known' })
      expect(await cold.loadValue(f.preview.workflowId, child.resultRef!)).toMatchObject({ state: 'known', value: 'known' })
    } finally { publications.mockRestore() }
  })

  it('refuses stale final CAS and cold-resumes a completed child without another Agent dispatch', async () => {
    const f = await setup(), save = f.store.saveFrameWithValue.bind(f.store)
    const fault = vi.spyOn(f.store, 'saveFrameWithValue').mockImplementation((frame, revision, checkpoint) => save(frame,
      frame.nodeId === 'nested' && frame.phase === 'completed' ? revision - 1 : revision, checkpoint))
    try {
      await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow()
      expect(f.execute).toHaveBeenCalledTimes(1)
      const coldStore = new FileWorkflowStore(f.directory), record = (await coldStore.load(f.preview.workflowId))!
      expect(record.progress.state).toBe('failed')
      expect(record.outcomes).toHaveLength(1)
      expect(record.outcomes[0]).toMatchObject({ state: 'completed', settled: true })
      const parent = (await coldStore.loadFrame(f.preview.workflowId, f.frameId('nested')))!
      expect(parent).toMatchObject({ phase: 'entered' })
      expect(parent.cursor ?? 0).toBe(0)
      expect(parent.children ?? []).toEqual([])
      expect(parent.resultRef).toBeUndefined()
      expect(await coldStore.loadFrame(f.preview.workflowId, f.frameId('work'))).toMatchObject({ phase: 'completed' })
      fault.mockRestore()
      f.service.close()
      const cold = f.create(coldStore, f.body).service
      await cold.approve(f.approval)
      expect(await cold.resume(f.preview.workflowId, f.approval, 'cold-final-sequence')).toMatchObject({ state: 'continued', progress: { state: 'completed', dispatchAttempts: 1 } })
      expect(f.execute).toHaveBeenCalledTimes(1)
      const resumed = (await coldStore.load(f.preview.workflowId))!, generation = resumed.execution!.segments.at(-1)!.generationId
      expect(generation).toBeDefined()
      expect(await coldStore.loadFrame(f.preview.workflowId, workflowFrameId('nested', ['revision:' + f.preview.programRevision], generation))).toMatchObject({ phase: 'completed', cursor: 1 })
      // Resume appends a generation; it must not rewrite the failed parent's
      // historical entered frame into a completed one.
      expect(await coldStore.loadFrame(f.preview.workflowId, f.frameId('nested'))).toMatchObject({ phase: 'entered' })
    } finally { fault.mockRestore() }
  })

  it.each([false, true])('does not acknowledge the terminal parent before its real directory barrier: fail=%s', async fail => {
    const f = await setup(), save = f.store.saveFrameWithValue.bind(f.store)
    let gate = false, reached!: () => void, release!: () => void
    const barrier = new Promise<void>(resolve => { reached = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const publication = vi.spyOn(f.store, 'saveFrameWithValue').mockImplementation((frame, revision, checkpoint) => {
      if (frame.nodeId === 'nested' && frame.phase === 'completed') gate = true
      return save(frame, revision, checkpoint)
    })
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (gate && String(args[0]) === join(f.directory, 'workflows') && args[1] === 'r') {
        gate = false
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          reached()
          await held
          if (fail) throw new Error('fixture terminal sequence directory sync failure')
          await sync()
        }
      }
      return handle
    })
    let running: Promise<WorkflowProgress> | undefined
    try {
      let acknowledged = false
      running = f.service.start(f.preview.workflowId, f.approval)
      const result = running.then(progress => { acknowledged = true; return { state: 'resolved' as const, progress } }, error => ({ state: 'rejected' as const, error: error as unknown }))
      await barrier
      expect(acknowledged).toBe(false)
      expect(f.execute).toHaveBeenCalledTimes(1)
      const cold = new FileWorkflowStore(f.directory)
      expect((await cold.load(f.preview.workflowId))!.progress.state).not.toBe('completed')
      release()
      const outcome = await result
      if (fail) {
        expect(outcome).toMatchObject({ state: 'rejected', error: { message: 'fixture terminal sequence directory sync failure' } })
        expect(acknowledged).toBe(false)
        expect((await cold.load(f.preview.workflowId))!.progress.state).toBe('failed')
      } else expect(outcome).toMatchObject({ state: 'resolved', progress: { state: 'completed', dispatchAttempts: 1 } })
      expect(f.execute).toHaveBeenCalledTimes(1)
    } finally {
      release()
      if (running) await Promise.allSettled([running])
      publication.mockRestore()
      vi.mocked(open).mockReset().mockImplementation(actual.open)
    }
  })
})
