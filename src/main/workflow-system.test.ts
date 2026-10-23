import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowStore } from './workflow-store'
import { WorkflowSystemHost, type WorkflowReplicaRun } from './workflow-system-host'
import type { WorkflowControlFrame } from '../shared/workflow'
import { WorkflowSlots, type WorkflowProviderExecutionRequest } from './workflow-runner'
import * as checks from './workflow-check'
import { templateExtractionSource } from './workflow-template-extraction'
import { validateWorkflowTemplate } from './workflow-template-definition'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
class CutParentStore extends MemoryWorkflowStore {
  cut = false
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, expected: number) {
    if (this.cut && frame.nodeId === 'root' && frame.cursor === 2) throw new Error('fixture system parent checkpoint failure')
    return super.saveFrame(frame, expected)
  }
}
async function fixture(code = 0, store: WorkflowStore = new CutParentStore(), agent: false | 'copy' | 'forged' = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-system-runner-')))
  roots.push(root)
  const source = join(root, 'source'), directory = join(root, 'copies')
  await mkdir(source)
  await writeFile(join(source, 'check.cjs'), `const fs = require('node:fs'); const path = 'native-count'; let n = 0; try { n = Number(fs.readFileSync(path, 'utf8')) } catch (e) { if(e.code !== 'ENOENT') throw e } fs.writeFileSync(path, String(n + 1)); console.log('observed'); process.exitCode = ${code}`)
  const body = agent ? { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'call', blockId: 'work', role: 'orchestrator', prompt: 'modify copy', replica: agent === 'copy' ? { kind: 'ref', name: 'copy' }
      : { kind: 'literal', value: { workflowId: 'forged', replicaId: 'forged', inputHash: 'a'.repeat(64) } } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'work' } }
  ] } : { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'check', blockId: 'verify', replica: { kind: 'ref', name: 'copy' }, check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'verify', path: ['passed'] } }
  ] }
  const role = { role: 'orchestrator' as const, providerId: 'claude' as const }
  const execute = vi.fn<WorkflowServiceOptions['execute']>()
  const env = { HOME: root, PATH: '/usr/bin:/bin' }
  const create = (currentStore = store) => {
    const host = new WorkflowSystemHost(directory, currentStore, () => env), slots = new WorkflowSlots(1)
    const service = new WorkflowService({ store: currentStore, slots, systems: host, execute, plan: async () => ({ output: JSON.stringify({ body }) }), providerRegistered: () => true,
      runControls: async () => ({ descriptor: { id: 'claude', label: 'fixture', runtimeProvider: 'claude_sdk', transport: 'fixture', available: true, capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }, identity: 'fixture', model: true, stop: true, independentRun: true, terminalOutput: true }) })
    return { service, host, slots }
  }
  const instance = create(), preview = await instance.service.planCommand({ command: '/scry-workflow run check', workspace: source, orchestrator: role, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await instance.service.approve(approval)
  return { ...instance, create, preview, approval, store, root, source, execute }
}

describe('SystemSteps under canonical Service/Runner/Interpreter', () => {
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
  it('prepares an owned current-input copy, runs frozen main check in it, and spends zero Agent attempts', async () => {
    const f = await fixture()
    const progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress).toMatchObject({ state: 'completed', finalReport: 'true', dispatchAttempts: 0 })
    expect(f.execute).not.toHaveBeenCalled()
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.systemIntents?.map(value => value.kind)).toEqual(['prepare_replica', 'check'])
    expect(record.systemOutcomes?.map(value => [value.state, value.settled])).toEqual([['completed', true], ['completed', true]])
    const replica = record.systemOutcomes![0].replica!, copy = await f.host.replicas.resolve(replica)
    expect(await readFile(join(copy.directory, 'native-count'), 'utf8')).toBe('1')
    await expect(readFile(join(f.source, 'native-count'))).rejects.toMatchObject({ code: 'ENOENT' })
    const output = record.systemOutcomes![1].check!.stdoutRef!
    expect(await f.store.loadValue(f.preview.workflowId, output)).toMatchObject({ state: 'known', value: 'observed\n' })
    expect(f.slots.active).toBe(0)
  })
  it('freezes an identical check once within one plan instead of rereading the same executable', async () => {
    const f = await fixture(), program = structuredClone(f.preview.program)
    if (program.body.kind !== 'sequence' || program.body.blocks[1].kind !== 'check') throw new Error('fixture shape')
    program.body.blocks.splice(2, 0, { ...program.body.blocks[1], blockId: 'verify_again' })
    const freeze = vi.spyOn(checks, 'freezeWorkflowCheck')
    try { await f.host.prepare(program); expect(freeze).toHaveBeenCalledTimes(1) } finally { freeze.mockRestore() }
  })
  it('exposes actual failed check as false, not a fabricated passing Agent outcome', async () => {
    const f = await fixture(17)
    expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'completed', finalReport: 'false', dispatchAttempts: 0 })
    const check = (await f.store.load(f.preview.workflowId))!.systemOutcomes![1].check!
    expect(check).toMatchObject({ state: 'failed', exitCode: 17, evidence: 'exact', settled: true })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('continues a committed system result after a parent checkpoint failure without rerunning the command or copying again', async () => {
    const store = new CutParentStore(), f = await fixture(0, store)
    store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('system parent checkpoint')
    const before = (await f.store.load(f.preview.workflowId))!, replica = before.systemOutcomes![0].replica!
    expect(before.systemOutcomes).toHaveLength(2)
    store.cut = false
    const cold = f.create()
    await cold.service.approve(f.approval)
    expect((await cold.service.resume(f.preview.workflowId, f.approval, 'resume-system')).progress).toMatchObject({ state: 'completed', finalReport: 'true', dispatchAttempts: 0 })
    const after = (await f.store.load(f.preview.workflowId))!
    expect(after.systemIntents).toEqual(before.systemIntents)
    expect(after.systemOutcomes).toEqual(before.systemOutcomes)
    const copy = await cold.host.replicas.resolve(replica)
    expect(await readFile(join(copy.directory, 'native-count'), 'utf8')).toBe('1')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('reserves shared capacity for missing SystemStep outcomes at restart and refuses replay', async () => {
    const f = await fixture()
    await f.service.start(f.preview.workflowId, f.approval)
    const record = (await f.store.load(f.preview.workflowId))!
    record.systemOutcomes = record.systemOutcomes!.slice(0, 1)
    record.progress.state = 'running'
    await f.store.save(record)
    const cold = f.create()
    await cold.service.list(f.source)
    expect(cold.slots.reserved).toBe(1)
    expect((await cold.service.snapshot(f.preview.workflowId))?.state).toBe('unknown')
    await cold.service.approve(f.approval)
    await expect(cold.service.resume(f.preview.workflowId, f.approval, 'resume-unknown-system')).rejects.toThrow()
    expect((await f.store.load(f.preview.workflowId))!.systemIntents).toHaveLength(2)
    expect(f.execute).not.toHaveBeenCalled()
    expect(await cold.service.prepareForShutdown()).toMatchObject({ state: 'unconfirmed', workflowIds: [f.preview.workflowId] })
    expect(cold.slots.reserved).toBe(1)
  })
  it('keeps shared capacity after an unknown SystemStep result until the original physical scope closes', async () => {
    const f = await fixture()
    let close!: () => void
    const physical = new Promise<void>(resolve => { close = resolve })
    const original = f.host.execute.bind(f.host)
    const spy = vi.spyOn(f.host, 'execute').mockImplementation((preview, block, stepId, input) => block.kind !== 'check' ? original(preview, block, stepId, input) : {
      result: Promise.resolve({ state: 'unknown', settled: false, value: { state: 'unknown', reason: 'controlled unknown result', derivedFrom: ['system:' + stepId] } }), settled: physical, stop: () => true
    })
    let neighbor: Promise<void> | undefined
    try {
      expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'unknown' })
      let entered = false
      neighbor = f.slots.withSlot(async () => { entered = true }, 'neighbor')
      expect(f.slots.active).toBe(1)
      expect(f.slots.queued).toBe(1)
      expect(entered).toBe(false)
      close()
      await neighbor
      expect((await f.store.load(f.preview.workflowId))!.systemOutcomes![1]).toMatchObject({ state: 'unknown', settled: true })
      await expect(f.service.resume(f.preview.workflowId, f.approval, 'still-unsafe')).rejects.toThrow()
      expect(spy).toHaveBeenCalledTimes(2)
    } finally { close(); await neighbor }
  })
  it('does not free a started unknown scope when its result artifact cannot be persisted', async () => {
    const f = await fixture()
    let close!: () => void
    const physical = new Promise<void>(resolve => { close = resolve })
    const original = f.host.execute.bind(f.host), save = f.store.saveValue.bind(f.store)
    let failingStep: string | undefined
    vi.spyOn(f.store, 'saveValue').mockImplementation((workflowId, key, value) => key === failingStep ? Promise.reject(new Error('fixture result artifact failure')) : save(workflowId, key, value))
    vi.spyOn(f.host, 'execute').mockImplementation((preview, block, stepId, input) => {
      if (block.kind !== 'check') return original(preview, block, stepId, input)
      failingStep = stepId
      return { result: Promise.resolve({ state: 'unknown', settled: false, value: { state: 'unknown', reason: 'controlled unknown', derivedFrom: [] } }), settled: physical, stop: () => true }
    })
    let neighbor: Promise<void> | undefined
    try {
      await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('result artifact failure')
      neighbor = f.slots.withSlot(async () => {}, 'neighbor')
      expect(f.slots.active).toBe(1)
      expect(f.slots.queued).toBe(1)
      close()
      await neighbor
      expect((await f.store.load(f.preview.workflowId))!.systemOutcomes![1]).toMatchObject({ state: 'unknown', settled: true })
    } finally { close(); await neighbor }
  })
  it('blocks recovery on missing stdout evidence rather than rerunning a previously successful command', async () => {
    const store = new CutParentStore(), f = await fixture(0, store)
    store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('system parent checkpoint')
    store.cut = false
    const before = (await store.load(f.preview.workflowId))!, missing = before.systemOutcomes![1].check!.stdoutRef.key
    const load = store.loadValue.bind(store)
    vi.spyOn(store, 'loadValue').mockImplementation((workflowId, reference) => reference.key === missing ? Promise.reject(new Error('missing system stdout evidence')) : load(workflowId, reference))
    const cold = f.create(), execution = vi.spyOn(cold.host, 'execute')
    await cold.service.approve(f.approval)
    await expect(cold.service.resume(f.preview.workflowId, f.approval, 'missing-stdout')).rejects.toThrow('missing system stdout evidence')
    expect(execution).not.toHaveBeenCalled()
    expect((await store.load(f.preview.workflowId))!.systemIntents).toEqual(before.systemIntents)
  })
  it('exports portable check requests without main authority and rejects authority injected into a template', async () => {
    const f = await fixture(), source = JSON.parse(templateExtractionSource(f.preview.program, { workflowId: f.preview.workflowId, programRevision: f.preview.programRevision, scope: { kind: 'personal' }, name: 'Checks', description: '', parameters: {} }))
    const templateId = '123e4567-e89b-42d3-a456-426614174000'
    source.templateId = templateId
    expect(source.body.blocks[1].authorization).toBeUndefined()
    expect(validateWorkflowTemplate(JSON.stringify(source), templateId).body.blocks[1].kind).toBe('check')
    if (f.preview.program.body.kind !== 'sequence' || f.preview.program.body.blocks[1].kind !== 'check') throw new Error('fixture shape')
    source.body.blocks[1].authorization = f.preview.program.body.blocks[1].authorization
    expect(() => validateWorkflowTemplate(JSON.stringify(source), templateId)).toThrow()
  })
  it('persists real SystemSteps and immutable outputs through a fresh filesystem store instance', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'scry-system-durable-')))
    roots.push(directory)
    const f = await fixture(0, new FileWorkflowStore(directory))
    expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'completed' })
    const coldStore = new FileWorkflowStore(directory), record = (await coldStore.load(f.preview.workflowId))!
    expect(record.systemIntents).toHaveLength(2)
    const output = await coldStore.loadValue(f.preview.workflowId, record.systemOutcomes![1].check!.stdoutRef)
    expect(output).toMatchObject({ state: 'known', value: 'observed\n' })
    const cold = f.create(coldStore)
    expect((await cold.service.resume(f.preview.workflowId, f.approval, 'cold-complete')).progress).toMatchObject({ state: 'completed', finalReport: 'true' })
    expect(f.execute).not.toHaveBeenCalled()
  })
})
