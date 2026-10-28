import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import type { WorkflowTemplateInstantiation, WorkflowTemplateSource } from '../shared/workflow-template'
import type { WorkflowControlFrame, WorkflowValue } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowTemplateStore } from './workflow-template-store'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowSlots } from './workflow-runner'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const orchestrator = { role: 'orchestrator' as const, providerId: 'codex' as const }
const worker = { role: 'worker' as const, providerId: 'pi' as const, agentProfileId: 'pi:test', requestedModel: { providerId: 'openai', id: 'fixture' }, permissionMode: 'default' as const }
const rawDefinition = () => ({ schemaVersion: 1, name: 'Parameterized fixture', description: '',
  parameters: { message: { schema: { type: 'string' }, default: 'seed' }, count: { schema: { type: 'number' }, default: 0 }, enabled: { schema: { type: 'boolean' }, default: false } },
  roles: [{ role: 'worker', providerId: 'codex' }], body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'call', blockId: 'work', role: 'worker', prompt: 'literal {message}; never interpolate', inputRefs: [{ nodeId: 'message' }, { nodeId: 'count' }, { nodeId: 'enabled' }] },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'work' } }
  ] } })
function descriptor(id: ProviderId): ProviderDescriptor {
  return { id, label: id, runtimeProvider: id === 'pi' ? 'pi_rpc' : id === 'qoder' ? 'qoder_cli' : 'codex_cli', transport: 'fixture', available: true,
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
}
async function fixture(definition: unknown = rawDefinition()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-template-instance-'))); roots.push(root)
  const project = join(root, 'project'), userData = join(root, 'user'); await mkdir(project); await mkdir(userData)
  const templates = new WorkflowTemplateStore(userData, cwd => { if (cwd !== project) throw new Error('unauthorized fixture project'); return cwd }, join(root, 'locks'))
  const draft = await templates.saveDraft({ scope: { kind: 'project', workspace: project }, source: JSON.stringify(definition) })
  expect(draft.validation).toEqual({ state: 'valid' })
  const draftSource: WorkflowTemplateSource = { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash }
  const sourcePath = join(project, '.scry-workflows', draft.templateId + '.json')
  const publish = async (): Promise<WorkflowTemplateSource> => {
    const result = await templates.publish({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: randomUUID() })
    if (result.state !== 'published') throw new Error('fixture publish failed')
    return { kind: 'saved', ref: result.ref }
  }
  const store = new FileWorkflowStore(userData)
  const make = (changes: Partial<WorkflowServiceOptions> = {}) => {
    const plan = vi.fn(async () => { throw new Error('template must not call the planning Agent') })
    const execute = vi.fn<WorkflowServiceOptions['execute']>(() => ({ result: Promise.resolve({ runId: 'fixture-run', status: 'completed', output: 'finished', settled: true }), stop: () => true }))
    const slots = new WorkflowSlots(2)
    const runControls = vi.fn<WorkflowServiceOptions['runControls']>(async role => ({ descriptor: descriptor(role.providerId), model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true }))
    const service = new WorkflowService({ store, templates, slots, plan, execute, runControls, providerRegistered: () => true, ...changes })
    return { service, plan, execute, slots, runControls }
  }
  const request = (source: WorkflowTemplateSource = draftSource, parameters: Record<string, WorkflowValue> = {}): WorkflowTemplateInstantiation => ({ source, commandId: randomUUID(), cwd: project, userGoal: 'Use the frozen template', parameters, orchestrator, roles: [worker] })
  return { root, project, userData, templates, store, draft, draftSource, sourcePath, publish, make, request }
}
const approvalFor = (preview: { workflowId: string; programRevision: string }) => ({ workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 })

describe('template lowering and frozen instances through the canonical Service/Runner', () => {
  it('executes a Qoder-shaped frozen binding without authoring capability, while planning rejects before dispatch', async () => {
    const f = await fixture(), qoder = { role: 'orchestrator' as const, providerId: 'qoder' as const }
    const controls = vi.fn<WorkflowServiceOptions['runControls']>(async role => ({ descriptor: descriptor(role.providerId), model: true, stop: true,
      identity: 'qoder-runtime', independentRun: true, terminalOutput: true, structuredCandidateAuthoring: 'unavailable', hostToolsDisabled: 'unavailable' }))
    const running = f.make({ runControls: controls })
    const preview = await running.service.instantiateTemplate({ ...f.request(), orchestrator: qoder })
    expect(preview.state).toBe('ready')
    await running.service.approve(approvalFor(preview))
    await expect(running.service.start(preview.workflowId, approvalFor(preview))).resolves.toMatchObject({ state: 'completed' })
    expect(running.execute).toHaveBeenCalled()
    const request = { command: '/scry-workflow run qoder', commandId: randomUUID(), workspace: f.project, orchestrator: qoder, roles: [] }
    await expect(running.service.planCommand(request)).rejects.toThrow('编排角色不可用')
    expect(running.plan).not.toHaveBeenCalled()
    const unknown = f.make({ runControls: vi.fn<WorkflowServiceOptions['runControls']>(async role => ({ descriptor: descriptor(role.providerId), model: true, stop: true,
      identity: 'qoder-runtime', independentRun: true, terminalOutput: true })) })
    await expect(unknown.service.planCommand({ ...request, commandId: randomUUID() })).rejects.toThrow('编排角色不可用')
    expect(unknown.plan).not.toHaveBeenCalled()
  })
  it('extracts only portable definition fields with explicit parameter/default choices without executing or changing a run', async () => {
    const f = await fixture(), running = f.make(), preview = await running.service.instantiateTemplate(f.request())
    const before = await f.store.load(preview.workflowId)
    const extracted = await running.service.extractTemplate({ workflowId: preview.workflowId, programRevision: preview.programRevision, scope: { kind: 'personal' }, name: 'Portable extracted definition', description: '',
      parameters: { count: { schema: { type: 'number' }, default: 'include' }, enabled: { schema: { type: 'boolean' }, default: 'include' }, message: { schema: { type: 'string' }, default: 'omit' } } })
    expect(extracted.validation).toEqual({ state: 'valid' })
    const definition = JSON.parse(extracted.source)
    expect(definition.parameters).toEqual({ count: { schema: { type: 'number' }, default: 0 }, enabled: { schema: { type: 'boolean' }, default: false }, message: { schema: { type: 'string' } } })
    expect(definition.roles[1]).toEqual({ role: 'worker', providerId: worker.providerId, requestedModel: worker.requestedModel })
    expect(Object.keys(definition).sort()).toEqual(['body', 'description', 'name', 'parameters', 'roles', 'schemaVersion', 'templateId'])
    expect(definition.body.blocks).toHaveLength(2)
    expect(extracted.source).not.toContain(f.project); expect(extracted.source).not.toContain('fixture-runtime'); expect(extracted.source).not.toContain(worker.agentProfileId)
    expect(await f.store.load(preview.workflowId)).toEqual(before)
    expect(running.plan).not.toHaveBeenCalled(); expect(running.execute).not.toHaveBeenCalled()
    await expect(readFile(join(f.userData, 'workflows', 'templates', extracted.templateId + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const source = { kind: 'draft' as const, draftId: extracted.draftId, draftRevision: extracted.draftRevision, candidateHash: extracted.candidateHash }
    await expect(running.service.instantiateTemplate(f.request(source))).rejects.toThrow('message')
    const rebound = await running.service.instantiateTemplate(f.request(source, { message: 'new binding' }))
    expect(rebound.state).toBe('ready')
  })
  it('does not extract output/attempt data, nonliteral binds, stale programs or unknown source fields as parameter defaults', async () => {
    const f = await fixture(), running = f.make(), preview = await running.service.instantiateTemplate(f.request())
    const request = { workflowId: preview.workflowId, programRevision: preview.programRevision, scope: { kind: 'personal' }, name: 'Extracted', description: '', parameters: {} }
    await expect(running.service.extractTemplate({ ...request, programRevision: 'a'.repeat(64) })).rejects.toThrow('修订已变化')
    await expect(running.service.extractTemplate({ ...request, transcript: 'not portable' })).rejects.toThrow()
    await expect(running.service.extractTemplate({ ...request, parameters: { work: { schema: { type: 'string' }, default: 'include' } } })).rejects.toThrow('work')
    await expect(running.service.extractTemplate({ ...request, parameters: { message: { schema: { type: 'string' } } } })).rejects.toThrow()
    expect(running.execute).not.toHaveBeenCalled(); expect(running.plan).not.toHaveBeenCalled()
  })
  it('prepares typed parameters without a planner, slot, attempt, execution, or source publication', async () => {
    const f = await fixture(), running = f.make(), request = f.request(undefined, { message: 'literal input' })
    const preview = await running.service.instantiateTemplate(request)
    expect(preview.state).toBe('ready')
    expect(preview.program.roles[1]).toMatchObject({ ...worker, runtimeIdentity: 'fixture-runtime' })
    expect(preview.program.template).toMatchObject({ origin: f.draftSource, parameterNames: ['count', 'enabled', 'message'], commandId: request.commandId })
    if (preview.program.body.kind !== 'sequence') throw new Error('fixture root')
    expect(preview.program.body.blocks.slice(0, 3)).toMatchObject([
      { kind: 'bind', blockId: 'count', value: { kind: 'literal', value: 0 }, schema: { type: 'number' } },
      { kind: 'bind', blockId: 'enabled', value: { kind: 'literal', value: false }, schema: { type: 'boolean' } },
      { kind: 'bind', blockId: 'message', value: { kind: 'literal', value: 'literal input' }, schema: { type: 'string' } }
    ])
    const record = await f.store.load(preview.workflowId)
    expect(record?.progress).toMatchObject({ state: 'awaiting_approval', dispatchAttempts: 0, attempts: [] })
    expect(record?.execution).toBeUndefined()
    expect(record?.intents).toEqual([])
    const planningIntents = []
    for await (const intent of f.store.planningIntents()) planningIntents.push(intent)
    expect(planningIntents).toEqual([])
    expect(running.plan).not.toHaveBeenCalled(); expect(running.execute).not.toHaveBeenCalled(); expect(running.slots.active).toBe(0)
    await expect(readFile(f.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(running.service.start(preview.workflowId, approvalFor(preview))).rejects.toThrow()
    expect(running.execute).not.toHaveBeenCalled()
  })
  it('runs the frozen source after source deletion and never interpolates parameter names into prompt code', async () => {
    const f = await fixture(), source = await f.publish(), first = f.make(), request = f.request(source, { message: 'frozen input' })
    const preview = await first.service.instantiateTemplate(request)
    await rm(f.sourcePath)
    const cold = f.make(), restored = await cold.service.preview(preview.workflowId), approval = approvalFor(restored)
    expect(restored).toEqual(preview)
    await cold.service.approve(approval)
    const progress = await cold.service.start(preview.workflowId, approval, 'start-template')
    expect(progress.state).toBe('completed'); expect(progress.dispatchAttempts).toBe(1)
    expect(cold.plan).not.toHaveBeenCalled(); expect(cold.execute).toHaveBeenCalledTimes(1)
    expect(cold.execute.mock.calls[0][0].prompt).toContain('literal {message}; never interpolate')
    expect(cold.execute.mock.calls[0][0].prompt).toContain('frozen input')
    expect(await cold.service.instantiateTemplate(request)).toEqual(preview)
    expect((await f.store.load(preview.workflowId))?.progress.state).toBe('completed')
    expect(cold.execute).toHaveBeenCalledTimes(1)
  })
  it('isolates a genuinely slot-queued and then active call from source edits and deletion', async () => {
    const f = await fixture(), source = await f.publish()
    let queued!: () => void, entered!: () => void, unblock!: () => void, finish!: () => void
    const queuedSignal = new Promise<void>(resolve => { queued = resolve }), enteredSignal = new Promise<void>(resolve => { entered = resolve })
    class ObservedSlots extends WorkflowSlots {
      override enqueue(item: Parameters<WorkflowSlots['enqueue']>[0]) { const result = super.enqueue(item); queued(); return result }
    }
    const slots = new ObservedSlots(1), blocker = slots.withSlot(() => new Promise<void>(resolve => { unblock = resolve }), 'fixture-blocker')
    const terminal = new Promise<void>(resolve => { finish = resolve })
    const execute = vi.fn<WorkflowServiceOptions['execute']>(() => { entered(); return { result: terminal.then(() => ({ runId: 'held-fixture', status: 'completed', output: 'finished', settled: true })), stop: () => true } })
    const running = f.make({ slots, execute }), preview = await running.service.instantiateTemplate(f.request(source)), approval = approvalFor(preview)
    await running.service.approve(approval)
    const completion = running.service.start(preview.workflowId, approval)
    try {
      await queuedSignal
      expect(slots.queued).toBe(1); expect(execute).not.toHaveBeenCalled()
      await writeFile(f.sourcePath, f.draft.source.replace('seed', 'queued source change'))
      unblock(); await blocker; await enteredSignal
      expect(execute.mock.calls[0][0].prompt).toContain('seed')
      expect(execute.mock.calls[0][0].prompt).not.toContain('queued source change')
      expect(slots.active).toBe(1)
      await rm(f.sourcePath)
      expect(await running.service.preview(preview.workflowId)).toEqual(preview)
    } finally { unblock(); finish(); await blocker }
    expect((await completion).state).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1); expect(running.plan).not.toHaveBeenCalled()
  })
  it('continues the original frozen instance after a committed-call checkpoint failure without replay', async () => {
    const f = await fixture(), source = await f.publish()
    class CheckpointStore extends FileWorkflowStore {
      fail = true
      override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
        if (this.fail && frame.nodeId === 'root' && frame.cursor === 4) throw new Error('fixture checkpoint failure')
        return super.saveFrame(frame, revision)
      }
    }
    const store = new CheckpointStore(f.userData), first = f.make({ store }), preview = await first.service.instantiateTemplate(f.request(source)), approval = approvalFor(preview)
    await first.service.approve(approval)
    await expect(first.service.start(preview.workflowId, approval)).rejects.toThrow('fixture checkpoint failure')
    expect(first.execute).toHaveBeenCalledTimes(1)
    await rm(f.sourcePath); store.fail = false
    const cold = f.make({ store }); await cold.service.approve(approval)
    const result = await cold.service.resume(preview.workflowId, approval, 'continue-frozen-template')
    expect(result).toMatchObject({ state: 'continued', progress: { state: 'completed', dispatchAttempts: 1 } })
    expect(cold.execute).not.toHaveBeenCalled(); expect(cold.plan).not.toHaveBeenCalled()
    expect((await store.load(preview.workflowId))?.execution?.segments).toHaveLength(2)
  })

})
