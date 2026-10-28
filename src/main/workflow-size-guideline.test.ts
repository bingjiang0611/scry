import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileWorkflowStore, MemoryWorkflowStore } from './workflow-store'
import { WORKFLOW_SIZE_GUIDELINES, validateWorkflowSizeSnapshot, type WorkflowSizeGuideline } from '../shared/workflow-size'
import { workflowPlanningPrompt } from './workflow-program'
import { fixture, deferred } from './workflow-node-stop.fixture'
import type { WorkflowPlanRequest } from './workflow-service'
import type { WorkflowBlock } from '../shared/workflow'

const temporary: string[] = []
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'scry-workflow-size-'))
  temporary.push(directory)
  return { directory, files: join(directory, 'workflows'), store: new FileWorkflowStore(directory) }
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const request = (commandId = 'size-first', goal = 'review the task'): WorkflowPlanRequest => ({
  command: '/scry-workflow run ' + goal, commandId, workspace: '/fixture',
  orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [{ role: 'worker', providerId: 'pi', agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } }]
})
function program(count: number): WorkflowBlock {
  return { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'parallel', blockId: 'reviews', blocks: Array.from({ length: count }, (_, index) => ({ kind: 'call', blockId: 'review_' + index, role: 'worker', prompt: 'Review ' + index })) },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'reviews' } }
  ] }
}

describe('App-owned workflow size preferences', () => {
  it('distinguishes default from explicit medium, resets, and retains other shared preferences', async () => {
    const h = await home()
    const initial = await h.store.sizeGuideline()
    expect(initial).toMatchObject({ value: 'medium', source: 'default' })
    expect(await readdir(h.directory)).toEqual([])
    await mkdir(h.files)
    await writeFile(join(h.files, 'preferences.json'), JSON.stringify({ otherPreference: { revision: 7 } }))
    const selected = await h.store.setSizeGuideline('medium')
    expect(selected).toMatchObject({ value: 'medium', source: 'preference' })
    expect(selected.fingerprint).not.toBe(initial.fingerprint)
    expect(await new FileWorkflowStore(h.directory).sizeGuideline()).toEqual(selected)
    expect(JSON.parse(await readFile(join(h.files, 'preferences.json'), 'utf8'))).toEqual({ otherPreference: { revision: 7 }, workflowSizeGuideline: 'medium' })
    expect(await h.store.setSizeGuideline(null)).toMatchObject({ value: 'medium', source: 'default' })
    expect(JSON.parse(await readFile(join(h.files, 'preferences.json'), 'utf8'))).toEqual({ otherPreference: { revision: 7 } })
  })

  it('treats a not-yet-created userData directory as unconfigured, without creating it on read', async () => {
    const h = await home()
    const directory = join(h.directory, 'userData')
    const store = new FileWorkflowStore(directory)
    expect(await store.sizeGuideline()).toMatchObject({ value: 'medium', source: 'default' })
    expect(await readdir(h.directory)).toEqual([])
    expect(await store.setSizeGuideline('small')).toMatchObject({ value: 'small', source: 'preference' })
    expect(await new FileWorkflowStore(directory).sizeGuideline()).toEqual(await store.sizeGuideline())
  })

  it.each(WORKFLOW_SIZE_GUIDELINES)('persists %s without planning or execution', async value => {
    const h = await home()
    expect(await h.store.setSizeGuideline(value)).toMatchObject({ value, source: 'preference' })
    expect(await new FileWorkflowStore(h.directory).sizeGuideline()).toEqual(await h.store.sizeGuideline())
  })

  it('rejects a preference update beyond the read bound without replacing the existing shared file', async () => {
    const h = await home()
    await mkdir(h.files)
    const original = JSON.stringify({ anotherPreference: 'x'.repeat(65500) })
    const path = join(h.files, 'preferences.json')
    await writeFile(path, original)
    expect(Buffer.byteLength(original)).toBeLessThanOrEqual(64 * 1024)
    await expect(h.store.sizeGuideline()).resolves.toMatchObject({ value: 'medium', source: 'default' })
    await expect(h.store.setSizeGuideline('small')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(h.store.sizeGuideline()).resolves.toMatchObject({ value: 'medium', source: 'default' })
  })

  it('gives the file precedence, rejects changes/reset, and restores the preserved preference on key removal', async () => {
    const h = await home()
    await h.store.setSizeGuideline('small')
    const preference = await readFile(join(h.files, 'preferences.json'), 'utf8')
    await writeFile(join(h.files, 'settings.json'), JSON.stringify({ workflowSizeGuideline: 'large', workflowConcurrency: 1 }))
    expect(await h.store.sizeGuideline()).toMatchObject({ value: 'large', source: 'file' })
    await expect(h.store.setSizeGuideline('unrestricted')).rejects.toThrow('settings.json')
    await expect(h.store.setSizeGuideline(null)).rejects.toThrow('settings.json')
    expect(await readFile(join(h.files, 'preferences.json'), 'utf8')).toBe(preference)
    await writeFile(join(h.files, 'settings.json'), JSON.stringify({ workflowConcurrency: 1 }))
    expect(await h.store.sizeGuideline()).toMatchObject({ value: 'small', source: 'preference' })
    expect(await h.store.readConcurrency()).toBe(1)
  })

  it.each(['settings.json', 'preferences.json'])('rejects malformed, null and unsupported %s values instead of falling back', async name => {
    const h = await home()
    await mkdir(h.files)
    for (const text of ['{', 'null', '[]', '{"workflowSizeGuideline":null}', '{"workflowSizeGuideline":"tiny"}']) {
      await writeFile(join(h.files, name), text)
      await expect(h.store.sizeGuideline()).rejects.toThrow(name)
    }
    await writeFile(join(h.files, name), ' '.repeat(64 * 1024 + 1))
    await expect(h.store.sizeGuideline()).rejects.toThrow('64 KiB')
    await expect(h.store.setSizeGuideline('tiny' as WorkflowSizeGuideline)).rejects.toThrow('无效')
  })

  it('rejects non-owned symlink files and directories without writing their targets', async () => {
    const h = await home()
    const target = join(h.directory, 'target')
    await mkdir(target)
    await writeFile(join(target, 'settings.json'), '{"workflowSizeGuideline":"small"}')
    await symlink(target, h.files)
    await expect(h.store.sizeGuideline()).rejects.toThrow('App')
    await expect(h.store.setSizeGuideline('large')).rejects.toThrow('App')
    expect(await readdir(target)).toEqual(['settings.json'])
    await rm(h.files)
    await mkdir(h.files)
    await symlink(join(target, 'settings.json'), join(h.files, 'settings.json'))
    await expect(h.store.sizeGuideline()).rejects.toThrow('App')
    expect(await readFile(join(target, 'settings.json'), 'utf8')).toBe('{"workflowSizeGuideline":"small"}')
  })

  it('fingerprints source bytes and rejects malformed recorded snapshots', async () => {
    const h = await home()
    const first = await h.store.setSizeGuideline('small')
    await writeFile(join(h.files, 'preferences.json'), '{ "workflowSizeGuideline": "small" }')
    const second = await h.store.sizeGuideline()
    expect(second.value).toBe(first.value)
    expect(second.source).toBe(first.source)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(() => validateWorkflowSizeSnapshot({ ...first, source: ['file'] })).toThrow()
    expect(() => validateWorkflowSizeSnapshot({ ...first, value: 'small', source: 'default' })).toThrow()
  })
})

describe('planning receives a frozen soft guideline', () => {
  it('freezes before slot admission and preserves it through changed preferences and a cold duplicate', async () => {
    const h = await home()
    const f = fixture(h.store)
    await h.store.setSizeGuideline('small')
    const release = deferred<void>()
    const entered = deferred<void>()
    f.slots.configure(1)
    const held = f.slots.withSlot(async () => { entered.resolve(); await release.promise })
    await entered.promise
    const planning = f.service.planCommand(request())
    try {
      await vi.waitFor(() => expect(f.slots.queued).toBe(1))
      expect(f.plan).not.toHaveBeenCalled()
      await h.store.setSizeGuideline('large')
    } finally { release.resolve(); await held }
    const preview = await planning
    expect(f.plan).toHaveBeenCalledTimes(1)
    const supplied = f.plan.mock.calls[0][0]
    expect(supplied.sizeGuideline).toMatchObject({ value: 'small', source: 'preference' })
    expect(supplied.goal).toBe('review the task')
    const recorded = (await h.store.loadPlanningIntent(preview.workflowId))!
    expect(recorded.sizeGuideline).toEqual(supplied.sizeGuideline)
    expect(preview.planningSize?.snapshot).toEqual(recorded.sizeGuideline)
    expect((await f.service.snapshot(preview.workflowId))?.planningSize?.snapshot).toEqual(recorded.sizeGuideline)
    const coldStore = new FileWorkflowStore(h.directory)
    const cold = fixture(coldStore)
    expect((await cold.service.planCommand(request())).programRevision).toBe(preview.programRevision)
    expect(cold.plan).not.toHaveBeenCalled()
    expect((await coldStore.loadPlanningIntent(preview.workflowId))!.sizeGuideline).toEqual(recorded.sizeGuideline)
    expect((await cold.service.preview(preview.workflowId)).planningSize).toEqual(preview.planningSize)
    const record = (await coldStore.load(preview.workflowId))!
    await expect(coldStore.save({ ...record, preview: { ...record.preview, planningSize: { snapshot: { ...supplied.sizeGuideline, value: 'large' } } } })).rejects.toThrow('改写')
    await cold.service.planCommand(request('size-second'))
    expect(cold.plan.mock.calls[0][0].sizeGuideline.value).toBe('large')
    await expect(coldStore.savePlanningIntent({ ...recorded, sizeGuideline: { ...recorded.sizeGuideline!, value: 'large' } })).rejects.toThrow('改写')
  })

  it.each([5, 20])('does not clip or reject %s requested reviewers under small', async count => {
    const store = new MemoryWorkflowStore()
    const f = fixture(store, undefined, program(count))
    await store.setSizeGuideline('small')
    const goal = `Use ${count} independent reviewers`
    const preview = await f.service.planCommand(request('reviewers', goal))
    expect(f.plan).toHaveBeenCalledTimes(1)
    expect(f.plan.mock.calls[0][0]).toMatchObject({ goal, sizeGuideline: { value: 'small' } })
    if (preview.program.body.kind !== 'sequence' || preview.program.body.blocks[0].kind !== 'parallel') throw new Error('Expected canonical review group')
    expect(preview.program.body.blocks[0].blocks).toHaveLength(count)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('records the model override explanation without another model call or rewriting the setting', async () => {
    const store = new MemoryWorkflowStore()
    await store.setSizeGuideline('small')
    const f = fixture(store)
    f.plan.mockResolvedValueOnce({ output: JSON.stringify({ body: program(20), sizeOverrideReason: 'The user requested 20 independent reviewers' }) })
    const preview = await f.service.planCommand(request())
    expect((await store.loadPlanningIntent(preview.workflowId))!).toMatchObject({ sizeGuideline: { value: 'small' }, sizeOverrideReason: 'The user requested 20 independent reviewers' })
    expect(f.plan).toHaveBeenCalledTimes(1)
    expect((await store.sizeGuideline()).value).toBe('small')
  })

  it('rejects corrupt configuration before any planner invocation', async () => {
    const h = await home()
    await mkdir(h.files)
    await writeFile(join(h.files, 'preferences.json'), '{"workflowSizeGuideline":null}')
    const f = fixture(h.store)
    await expect(f.service.planCommand(request())).rejects.toThrow('preferences.json')
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('retains the 4096 batch hard gate under unrestricted', async () => {
    const store = new MemoryWorkflowStore()
    await store.setSizeGuideline('unrestricted')
    const f = fixture(store, undefined, program(4097))
    await expect(f.service.planCommand(request())).rejects.toThrow('4096')
    expect(f.plan).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('sends exact soft targets and no quantity advice under unrestricted, retaining hard limits and the original goal', () => {
    const goal = 'Use 20 independent reviewers'
    for (const [value, limit] of [['small', 5], ['medium', 10], ['large', 50]] as const) {
      const prompt = workflowPlanningPrompt([], goal, value)
      expect(prompt).toContain(`fewer than ${limit} logical Agent calls`)
      expect(prompt).toContain('Explicit current user instructions override')
      expect(prompt).toContain(`Goal:\n${goal}`)
    }
    const unrestricted = workflowPlanningPrompt([], goal, 'unrestricted')
    expect(unrestricted).not.toContain('Soft workflow size guideline')
    expect(unrestricted).not.toContain('prefer fewer than')
    expect(unrestricted).toContain('Never exceed 1000 Agent calls')
    expect(unrestricted).toContain('4096')
  })
})
