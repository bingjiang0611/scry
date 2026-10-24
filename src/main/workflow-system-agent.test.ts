import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowReplicaRun } from './workflow-system-host'
import type { WorkflowProviderExecutionRequest } from './workflow-runner'
import { CutParentStore, fixture } from './workflow-system.fixture'

describe('Owned-copy Agent authority and scope', () => {
  it('dispatches one Agent in the owned copy, links its intent, and expires its unforgeable main grant', async () => {
    const f = await fixture(0, new CutParentStore(), 'copy')
    let grant: WorkflowReplicaRun | undefined
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      grant = request.replicaRun!
      expect(await f.host.assertRun(grant, request.workspace)).toBe(grant)
      await expect(f.host.assertRun(structuredClone(grant), request.workspace)).rejects.toThrow()
      await expect(f.create().host.assertRun(grant, request.workspace)).rejects.toThrow()
      await expect(f.host.assertRun(grant, f.source)).rejects.toThrow()
      await writeFile(join(request.workspace, 'agent-output'), 'copy only')
      return { runId: 'copy-agent', status: 'completed', output: 'done', archiveRef: 'fixture-archive', settled: true }
    })() }))
    expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'completed', dispatchAttempts: 1, finalReport: 'done' })
    expect(f.execute).toHaveBeenCalledTimes(1)
    const record = (await f.store.load(f.preview.workflowId))!, reference = record.systemOutcomes![0].replica!
    expect(record.intents[0].replica).toEqual(reference)
    expect(record.outcomes[0].archiveRef).toBe('fixture-archive')
    const copy = await f.host.replicas.resolve(reference)
    expect(await readFile(join(copy.directory, 'agent-output'), 'utf8')).toBe('copy only')
    await expect(readFile(join(f.source, 'agent-output'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(f.host.assertRun(grant!, copy.directory)).rejects.toThrow()
    expect(f.slots.active).toBe(0)
  })
  it('rejects literal copy descriptors before invoking the Agent, without refunding its durable reservation', async () => {
    const f = await fixture(0, new CutParentStore(), 'forged')
    expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'failed', dispatchAttempts: 1 })
    expect(f.execute).not.toHaveBeenCalled()
    expect((await f.store.load(f.preview.workflowId))!.outcomes[0]).toMatchObject({ settled: true, providerDispatch: 'not_attempted' })
    expect(f.slots.active).toBe(0)
  })
  it('reuses a committed copy-Agent outcome after a parent checkpoint failure, never dispatching a second Agent', async () => {
    const store = new CutParentStore(), f = await fixture(0, store, 'copy')
    f.execute.mockImplementation(() => ({ result: Promise.resolve({ runId: 'copy-agent', status: 'completed', output: 'done', settled: true }), stop: () => true }))
    store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('system parent checkpoint')
    store.cut = false
    const before = (await store.load(f.preview.workflowId))!, cold = f.create()
    await cold.service.approve(f.approval)
    expect((await cold.service.resume(f.preview.workflowId, f.approval, 'resume-copy-agent')).progress).toMatchObject({ state: 'completed', dispatchAttempts: 1, finalReport: 'done' })
    expect((await store.load(f.preview.workflowId))!.intents).toEqual(before.intents)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('refuses cold replay when a copy-Agent intent loses its copy association', async () => {
    const store = new CutParentStore(), f = await fixture(0, store, 'copy')
    f.execute.mockImplementation(() => ({ result: Promise.resolve({ runId: 'copy-agent', status: 'completed', output: 'done', settled: true }), stop: () => true }))
    store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('system parent checkpoint')
    store.cut = false
    const record = (await store.load(f.preview.workflowId))!
    delete record.intents[0].replica
    await store.save(record)
    const cold = f.create()
    await cold.service.approve(f.approval)
    await expect(cold.service.resume(f.preview.workflowId, f.approval, 'lost-copy-association')).rejects.toThrow('控制帧')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('never treats a stored descriptor as a live main run grant', async () => {
    const f = await fixture()
    await f.service.start(f.preview.workflowId, f.approval)
    const reference = (await f.store.load(f.preview.workflowId))!.systemOutcomes![0].replica!, receipt = await f.host.replicas.resolve(reference)
    const forged: WorkflowReplicaRun = { workflowId: f.preview.workflowId, sourceWorkspace: f.source, workspace: receipt.directory, reference }
    await expect(f.host.assertRun(forged, receipt.directory)).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('cancels an Agent waiting for a copy lease without executing it or releasing the existing owner', async () => {
    const f = await fixture()
    await f.service.start(f.preview.workflowId, f.approval)
    const reference = (await f.store.load(f.preview.workflowId))!.systemOutcomes![0].replica!, owner = await f.host.replicas.acquire(reference)
    const execute = vi.fn()
    const request: WorkflowProviderExecutionRequest = { workflowId: f.preview.workflowId, taskId: 'cancel-task', attemptId: 'cancel-attempt', role: f.preview.program.roles[0], prompt: 'fixture', cwd: f.source }
    try {
      const running = f.host.executeAgent(f.preview, { state: 'known', value: { ...reference }, replica: reference, derivedFrom: [] }, request, execute)
      expect(running.stop()).toBe(true)
      await expect(running.result).rejects.toMatchObject({ settled: true, providerDispatch: 'not_attempted' })
      await running.settled
      expect(execute).not.toHaveBeenCalled()
    } finally { owner.release() }
    const next = await f.host.replicas.acquire(reference)
    next.release()
  })
  it('holds the copy lease until both result production and physical settlement, not a stop ACK', async () => {
    const f = await fixture()
    await f.service.start(f.preview.workflowId, f.approval)
    const reference = (await f.store.load(f.preview.workflowId))!.systemOutcomes![0].replica!
    let close!: () => void, finish!: (result: { runId: string; status: 'unknown'; settled: false }) => void, entered!: () => void
    const physical = new Promise<void>(resolve => { close = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
    const result = new Promise<{ runId: string; status: 'unknown'; settled: false }>(resolve => { finish = resolve })
    const acquire = f.host.replicas.acquire.bind(f.host.replicas), release = vi.fn()
    const leaseSpy = vi.spyOn(f.host.replicas, 'acquire').mockImplementation(async (...args) => {
      const lease = await acquire(...args)
      return { ...lease, release: () => { release(); lease.release() } }
    })
    const request: WorkflowProviderExecutionRequest = { workflowId: f.preview.workflowId, taskId: 'lease-task', attemptId: 'lease-attempt', role: f.preview.program.roles[0], prompt: 'fixture', cwd: f.source }
    const running = f.host.executeAgent(f.preview, { state: 'known', value: { ...reference }, replica: reference, derivedFrom: [] }, request, () => { entered(); return { result, settled: physical, stop: () => true } })
    await ready
    try {
      expect(running.stop()).toBe(true)
      expect(release).not.toHaveBeenCalled()
      close()
      await physical
      expect(release).not.toHaveBeenCalled()
      finish({ runId: 'lease-agent', status: 'unknown', settled: false })
      await running.result
      await running.settled
      expect(release).toHaveBeenCalledTimes(1)
      leaseSpy.mockRestore()
      const lease = await f.host.replicas.acquire(reference)
      lease.release()
    } finally { close(); finish({ runId: 'lease-agent', status: 'unknown', settled: false }); await running.result; await running.settled; leaseSpy.mockRestore() }
  })
})
