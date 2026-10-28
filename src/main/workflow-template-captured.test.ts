import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor } from '../shared/provider'
import { taskSubmissionCopy } from '../shared/constants/copy'
import type { WorkflowTemplateInstantiation, WorkflowTemplateSource } from '../shared/workflow-template'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { taskDigest } from './task-submission-record'
import { validateTemplateInstantiation } from './workflow-template-instance'
import { WorkflowSlots } from './workflow-runner'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowTemplateStore } from './workflow-template-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const descriptor: ProviderDescriptor = { id: 'codex', label: 'synthetic', runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
  capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'scry captured template ')); roots.push(directory)
  const workspace = join(directory, 'workspace'), userData = join(directory, 'userData'); await mkdir(workspace); await mkdir(userData)
  const templates = new WorkflowTemplateStore(userData, cwd => cwd, join(directory, 'locks'))
  const draft = await templates.saveDraft({ scope: { kind: 'personal' }, source: JSON.stringify({ schemaVersion: 1, name: 'Frozen source', description: '', parameters: {},
    roles: [{ role: 'worker' }], body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'work', role: 'worker', prompt: 'literal instruction' }, { kind: 'return', blockId: 'done', ref: { nodeId: 'work' } }
    ] } }) })
  expect(draft.validation).toEqual({ state: 'valid' })
  const published = await templates.publish({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: randomUUID() })
  if (published.state !== 'published') throw new Error('fixture publication failed')
  await templates.freeze({ kind: 'saved', ref: published.ref })
  const store = new FileWorkflowStore(userData), slots = new WorkflowSlots(2)
  const plan = vi.fn(async () => { throw new Error('fixed template must not invoke a model') }), execute = vi.fn<WorkflowServiceOptions['execute']>()
  const runControls = vi.fn(async () => ({ descriptor, model: true, stop: true, identity: 'synthetic', independentRun: true, terminalOutput: true }))
  const service = new WorkflowService({ store, templates, slots, plan, execute, runControls, providerRegistered: () => true })
  await service.snapshot('workflow-not-created')
  const request: WorkflowTemplateInstantiation = { source: { kind: 'saved', ref: published.ref }, commandId: randomUUID(), cwd: workspace,
    userGoal: '/scry-workflow template personal:' + published.ref.templateId + ' {}', parameters: {}, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [{ role: 'worker', providerId: 'codex' }] }
  return { service, templates, store, slots, plan, execute, runControls, request, published, draft }
}

describe('captured template source preparation', () => {
  it('uses the captured App-owned revision after source deletion, while the ordinary saved-source path still refuses it', async () => {
    const f = await fixture()
    expect((await f.templates.delete({ ref: f.published.ref, commandId: randomUUID() })).state).toBe('deleted')
    await expect(f.service.instantiateTemplate({ ...f.request, commandId: randomUUID() })).rejects.toThrow()
    const preview = await f.service.instantiateTemplate(f.request, { frozenSource: true })
    expect(preview.program.template?.ref).toEqual(f.published.ref)
    expect(preview.program.template?.origin).toEqual(f.request.source)
    expect(preview.program.userGoal).toBe(f.request.userGoal)
    if (preview.program.body.kind !== 'sequence') throw new Error('expected compiled sequence')
    expect(preview.program.body.blocks.some(block => block.kind === 'call' && block.prompt === 'literal instruction')).toBe(true)
    expect((await f.store.load(preview.workflowId))?.progress.state).toBe('awaiting_approval')
    expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.slots.active).toBe(0)
  })
  it('observes canonical state rather than a cached receipt and never prepares a missing instance', async () => {
    const f = await fixture(), preview = await f.service.instantiateTemplate(f.request, { frozenSource: true })
    const before = await f.store.load(preview.workflowId), capabilities = f.runControls.mock.calls.length
    expect(await f.service.instantiateTemplate(f.request, { frozenSource: true, observeOnly: true })).toEqual(preview)
    expect(await f.store.load(preview.workflowId)).toEqual(before)
    const missing = vi.spyOn(f.store, 'load').mockResolvedValue(undefined)
    try { await expect(f.service.instantiateTemplate(f.request, { frozenSource: true, observeOnly: true })).rejects.toThrow(taskSubmissionCopy.unknown) }
    finally { missing.mockRestore() }
    expect(f.runControls).toHaveBeenCalledTimes(capabilities)
    expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('does not authorize a new preparation from a frozen reference alone', async () => {
    const f = await fixture()
    await expect(f.service.instantiateTemplate(f.request, { frozenSource: true, observeOnly: true })).rejects.toThrow(taskSubmissionCopy.unknown)
    expect(f.runControls).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('requires the exact canonical command, configuration and source when observing a captured instance', async () => {
    const f = await fixture(), preview = await f.service.instantiateTemplate(f.request, { frozenSource: true })
    const hash = taskDigest(JSON.stringify(validateTemplateInstantiation(f.request))), before = await f.store.load(preview.workflowId)
    const capabilities = f.runControls.mock.calls.length
    const observe = (requestHash = hash, ref = f.published.ref, command = f.request.userGoal, cwd = f.request.cwd) =>
      f.service.observeCapturedTemplate(f.request.commandId, requestHash, ref, command, cwd)
    expect(await observe()).toEqual({ preview, progressState: 'awaiting_approval' })
    expect(await observe('f'.repeat(64))).toBeNull()
    expect(await observe(hash, { ...f.published.ref, domainId: 'e'.repeat(64) })).toBeNull()
    expect(await observe(hash, f.published.ref, f.request.userGoal + ' changed')).toBeNull()
    expect(await observe(hash, f.published.ref, f.request.userGoal, join(f.request.cwd, 'other'))).toBeNull()
    expect(await f.store.load(preview.workflowId)).toEqual(before)
    expect(f.runControls).toHaveBeenCalledTimes(capabilities)
    expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('observes a revised root through its original governing template without preparing or executing again', async () => {
    const f = await fixture()
    f.execute.mockImplementation(() => ({ result: Promise.resolve({ runId: 'synthetic-template', status: 'completed', output: 'finished', settled: true }), stop: () => true }))
    const preview = await f.service.instantiateTemplate(f.request, { frozenSource: true })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await f.service.approve(approval)
    const completed = await f.service.start(preview.workflowId, approval, 'template-history-start')
    expect(completed.state).toBe('completed')
    const expectedRevision = completed.revision
    if (expectedRevision === undefined) throw new Error('missing canonical fixture revision')
    const candidate = await f.service.prepareRevision({ workflowId: preview.workflowId, expectedRevision,
      userGoal: 'Explicitly revised task', roles: [f.request.orchestrator, ...f.request.roles], body: { kind: 'sequence', blockId: 'revised', blocks: [
        { kind: 'bind', blockId: 'value', value: { kind: 'literal', value: 'revised output' } }, { kind: 'return', blockId: 'return', ref: { nodeId: 'value' } }
      ] } })
    const progress = await f.service.revisePrepared(preview.workflowId, { ...approval, programRevision: candidate.programRevision },
      { expectedRevision }, 'template-history-revision')
    expect(progress.state).toBe('completed')
    expect(candidate.program.template).toBeUndefined()
    const before = await f.store.load(preview.workflowId), capabilities = f.runControls.mock.calls.length
    expect(await f.service.observeCapturedTemplate(f.request.commandId, taskDigest(JSON.stringify(validateTemplateInstantiation(f.request))),
      f.published.ref, f.request.userGoal, f.request.cwd)).toEqual({ preview: candidate, progressState: 'completed' })
    expect(await f.store.load(preview.workflowId)).toEqual(before)
    expect(f.runControls).toHaveBeenCalledTimes(capabilities)
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.plan).not.toHaveBeenCalled()
  })
  it.each([1, 2, 3])('respects the private captured-task fence at preparation boundary %s without publishing a root', async boundary => {
    const f = await fixture(), create = vi.spyOn(f.store, 'create')
    const beforePrepare = vi.fn(async (): Promise<void> => { if (beforePrepare.mock.calls.length === boundary) throw new Error('captured task fenced') })
    await expect(f.service.instantiateTemplate(f.request, { frozenSource: true, beforePrepare })).rejects.toThrow('captured task fenced')
    expect(beforePrepare).toHaveBeenCalledTimes(boundary)
    expect(f.runControls).toHaveBeenCalledTimes(boundary === 1 ? 0 : 2)
    expect(create).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
    expect((await f.store.listPage()).records).toEqual([])
  })
  it('rechecks admission after an asynchronous private task fence', async () => {
    const f = await fixture(), create = vi.spyOn(f.store, 'create')
    const beforePrepare = vi.fn(async (): Promise<void> => { if (beforePrepare.mock.calls.length === 2) await f.service.close() })
    await expect(f.service.instantiateTemplate(f.request, { frozenSource: true, beforePrepare })).rejects.toThrow()
    expect(beforePrepare).toHaveBeenCalledTimes(2); expect(create).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects a mutable draft in the Main-only captured-source path before discovering capabilities', async () => {
    const f = await fixture(), source: WorkflowTemplateSource = { kind: 'draft', draftId: f.draft.draftId, draftRevision: f.draft.draftRevision, candidateHash: f.draft.candidateHash }
    await expect(f.service.instantiateTemplate({ ...f.request, source }, { frozenSource: true })).rejects.toThrow()
    expect(f.runControls).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled()
  })
})
