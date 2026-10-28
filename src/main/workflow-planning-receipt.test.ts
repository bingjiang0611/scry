import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor } from '../shared/provider'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowStore } from './workflow-store'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowSlots } from './workflow-runner'

const role = { role: 'orchestrator' as const, providerId: 'codex' as const }
const request = { commandId: 'planning-receipt-command', command: '/scry-workflow run inspect', workspace: '/fixture', orchestrator: role,
  roles: [{ role: 'worker' as const, providerId: 'codex' as const }] }
const output = JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'call', blockId: 'scan', role: 'worker', prompt: 'inspect' },
  { kind: 'return', blockId: 'done', ref: { nodeId: 'scan' } }
] } })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const id = `workflow-${hash(request.commandId)}`
const descriptor: ProviderDescriptor = { id: 'codex', label: 'fixture', runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
  capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
function fixture(store: WorkflowStore) {
  const plan = vi.fn(async () => ({ output }))
  const execute = vi.fn<WorkflowServiceOptions['execute']>()
  const slots = new WorkflowSlots(2)
  const service = new WorkflowService({ store, slots, plan, execute, providerRegistered: () => true,
    runControls: async () => ({ descriptor, model: true, stop: true, identity: 'fixture', independentRun: true, terminalOutput: true }) })
  return { service, plan, execute, slots }
}

for (const storage of ['memory', 'file'] as const) describe(`planning receipt reconciliation (${storage})`, () => {
  async function withStore(run: (store: WorkflowStore, reopen: () => WorkflowStore, directory: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'scry planning receipt '))
    const store = storage === 'file' ? new FileWorkflowStore(directory) : new MemoryWorkflowStore()
    try { await run(store, () => storage === 'file' ? new FileWorkflowStore(directory) : store, directory) }
    finally { await rm(directory, { recursive: true, force: true }) }
  }

  it('observes a committed root after completion-write failure, live and cold, without a second planner', async () => withStore(async (store, reopen) => {
    const original = store.savePlanningIntent.bind(store)
    const write = vi.spyOn(store, 'savePlanningIntent').mockImplementation(async intent => {
      if (intent.status === 'completed') throw new Error('fixture completion write failed')
      return original(intent)
    })
    const first = fixture(store)
    const observed = await first.service.planCommand(request)
    const root = await store.load(id)
    expect(observed).toEqual(root?.preview)
    expect(root?.planningRequestHash).toBe(hash(JSON.stringify(request)))
    expect(root?.progress.state).toBe('awaiting_approval')
    const prior = await store.loadPlanningIntent(id)
    expect(prior).toMatchObject({ status: 'failed', scopeSettled: true })
    const live = await first.service.planCommand(request)
    expect(live).toEqual(root?.preview)
    expect(first.plan).toHaveBeenCalledTimes(1)
    expect(first.execute).not.toHaveBeenCalled()
    expect(first.slots.active).toBe(0)
    write.mockRestore()
    const coldStore = reopen(), cold = fixture(coldStore)
    expect(await cold.service.planCommand(request)).toEqual(live)
    expect(cold.plan).not.toHaveBeenCalled()
    expect(cold.execute).not.toHaveBeenCalled()
    expect(await coldStore.loadPlanningIntent(id)).toEqual(prior)
    await expect(cold.service.planCommand({ ...request, command: '/scry-workflow run changed' })).rejects.toThrow('另一请求')
  }))

  it('recovers a lost root publication acknowledgement without rewriting either journal', async () => withStore(async (store, reopen) => {
    const original = store.save.bind(store)
    const save = vi.spyOn(store, 'save').mockImplementation(async record => {
      await original(record)
      throw new Error('fixture root acknowledgement lost')
    })
    const first = fixture(store), preview = await first.service.planCommand(request)
    save.mockRestore()
    const before = await store.load(id), prior = await store.loadPlanningIntent(id)
    expect(prior).toMatchObject({ status: 'failed', scopeSettled: true })
    const coldStore = reopen(), cold = fixture(coldStore)
    expect(await cold.service.planCommand(request)).toEqual(preview)
    expect(await coldStore.load(id)).toEqual(before)
    expect(await coldStore.loadPlanningIntent(id)).toEqual(prior)
    expect(first.plan).toHaveBeenCalledTimes(1)
    expect(cold.plan).not.toHaveBeenCalled()
  }))

  it('cannot graft, replace or delete the request correlation on an existing root', async () => withStore(async store => {
    const first = fixture(store)
    await first.service.planCommand(request)
    const root = (await store.load(id))!
    for (const next of [undefined, 'invalid', 'a'.repeat(64)]) {
      await expect(store.save({ ...root, planningRequestHash: next })).rejects.toThrow()
      expect(await store.load(id)).toEqual(root)
    }
    const original = store.save.bind(store)
    const save = vi.spyOn(store, 'save').mockImplementation(record => {
      const legacy = structuredClone(record)
      delete legacy.planningRequestHash
      return original(legacy)
    })
    const legacyPreview = await first.service.planCommand({ ...request, commandId: 'legacy-planning-command' })
    save.mockRestore()
    const legacy = (await store.load(legacyPreview.workflowId))!
    // A root without this new evidence remains legacy, never backfilled.
    await expect(store.save({ ...legacy, planningRequestHash: root.planningRequestHash })).rejects.toThrow()
  }))

  it('does not upgrade unknown scope or release its reserved slot when a root happens to exist', async () => withStore(async (store, reopen) => {
    const first = fixture(store)
    await first.service.planCommand(request)
    const prior = (await store.loadPlanningIntent(id))!
    await store.savePlanningIntent({ ...prior, status: 'unknown', scopeSettled: false, error: 'fixture unknown scope' })
    const coldStore = reopen(), cold = fixture(coldStore)
    await expect(cold.service.planCommand(request)).rejects.toThrow('unknown scope')
    expect(cold.slots.active).toBe(1)
    expect(cold.plan).not.toHaveBeenCalled()
    expect(await coldStore.loadPlanningIntent(id)).toMatchObject({ status: 'unknown', scopeSettled: false })
  }))

  it('does not infer a planning correlation for a legacy root', async () => withStore(async (store, reopen) => {
    const originalSave = store.save.bind(store), originalIntent = store.savePlanningIntent.bind(store)
    const save = vi.spyOn(store, 'save').mockImplementation(record => {
      const legacy = structuredClone(record)
      delete legacy.planningRequestHash
      return originalSave(legacy)
    })
    const write = vi.spyOn(store, 'savePlanningIntent').mockImplementation(intent => {
      if (intent.status === 'completed') throw new Error('fixture legacy completion failed')
      return originalIntent(intent)
    })
    const first = fixture(store)
    await expect(first.service.planCommand(request)).rejects.toThrow('legacy completion failed')
    save.mockRestore()
    write.mockRestore()
    expect((await store.load(id))?.planningRequestHash).toBeUndefined()
    const cold = fixture(reopen())
    await expect(cold.service.planCommand(request)).rejects.toThrow('legacy completion failed')
    expect(cold.plan).not.toHaveBeenCalled()
    expect(first.plan).toHaveBeenCalledTimes(1)
  }))

  it('retains the atomic planning correlation when the canonical Runner claims execution', async () => withStore(async store => {
    const f = fixture(store)
    f.execute.mockReturnValue({ result: Promise.resolve({ runId: 'fixture-worker', status: 'completed', settled: true, output: 'done' }), stop: () => true })
    const preview = await f.service.planCommand(request)
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await f.service.approve(approval)
    expect((await f.service.start(preview.workflowId, approval)).state).toBe('completed')
    const record = (await store.load(id))!
    expect(record.planningRequestHash).toBe(hash(JSON.stringify(request)))
    expect(record.intents).toHaveLength(1)
    expect(record.outcomes).toHaveLength(1)
    expect(f.plan).toHaveBeenCalledTimes(1)
  }))

  it('does not call the planner again when a canonical root has a missing planning intent', async () => withStore(async (store, reopen, directory) => {
    const first = fixture(store)
    await first.service.planCommand(request)
    const root = await store.load(id)
    const coldStore = reopen(), cold = fixture(coldStore)
    await cold.service.snapshot(id)
    const missing = storage === 'memory' ? vi.spyOn(coldStore, 'loadPlanningIntent').mockResolvedValue(undefined) : undefined
    if (storage === 'file') await rm(join(directory, 'workflows', id + '.planning.json'))
    await expect(cold.service.planCommand(request)).rejects.toThrow('不会重新规划')
    expect(cold.plan).not.toHaveBeenCalled()
    expect(cold.execute).not.toHaveBeenCalled()
    expect(await coldStore.load(id)).toEqual(root)
    missing?.mockRestore()
  }))

  it('keeps a failed planning intent without a committed root fenced', async () => withStore(async store => {
    const save = vi.spyOn(store, 'save').mockRejectedValue(new Error('fixture root write failed'))
    const first = fixture(store)
    await expect(first.service.planCommand(request)).rejects.toThrow('root write failed')
    await expect(first.service.planCommand(request)).rejects.toThrow('root write failed')
    save.mockRestore()
    const cold = fixture(store)
    await expect(cold.service.planCommand(request)).rejects.toThrow('root write failed')
    expect(first.plan).toHaveBeenCalledTimes(1)
    expect(cold.plan).not.toHaveBeenCalled()
    expect(await store.load(id)).toBeUndefined()
  }))
})
