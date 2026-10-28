import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { FileWorkflowStore } from './workflow-store'
import * as checks from './workflow-check'
import { templateExtractionSource } from './workflow-template-extraction'
import { validateWorkflowTemplate } from './workflow-template-definition'
import { roots, CutParentStore, fixture } from './workflow-system.fixture'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import type { WorkflowBlock } from '../shared/workflow'

const combineCheckBody: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'replica', blockId: 'base' },
  { kind: 'map', blockId: 'candidate_map', items: { kind: 'literal', value: [{ key: 'left' }, { key: 'right' }] }, item: 'candidate_item', key: ['key'], maxItems: 2,
    body: { kind: 'replica', blockId: 'candidate', source: { kind: 'ref', name: 'base' } } },
  { kind: 'collect', blockId: 'candidates', items: { kind: 'ref', name: 'candidate_map' } },
  { kind: 'combine', blockId: 'combined', base: { kind: 'ref', name: 'base' }, candidates: { kind: 'ref', name: 'candidates' } },
  { kind: 'check', blockId: 'integration_check', replica: { kind: 'field', source: { kind: 'ref', name: 'combined' }, path: ['integration'] },
    check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
  { kind: 'return', blockId: 'report', ref: { nodeId: 'integration_check', path: ['passed'] } }
] }

describe('SystemSteps under canonical Service/Runner/Interpreter', () => {
  it('persists combine through the canonical ledger and runs the integration check without changing the source', async () => {
    const f = await fixture(), combined = f.create(f.store, combineCheckBody)
    const preview = await combined.service.planCommand({ command: '/scry-workflow run combine check', workspace: f.source,
      orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 2 }
    await combined.service.approve(approval)
    const progress = await combined.service.start(preview.workflowId, approval), record = (await f.store.load(preview.workflowId))!
    expect(progress).toMatchObject({ state: 'completed', finalReport: 'true', dispatchAttempts: 0 })
    expect(() => validateWorkflowSystemLedger(record)).not.toThrow()
    expect(record.systemIntents?.map(intent => intent.kind)).toEqual(['prepare_replica', 'prepare_replica', 'prepare_replica', 'combine', 'check'])
    const combination = record.systemOutcomes?.find(outcome => outcome.combine)?.combine
    expect(combination).toMatchObject({ state: 'combined', candidateCount: 2, changedPathCount: 0, conflicts: [], integration: { replicaId: expect.any(String) } })
    const forged = structuredClone(record), forgedCombination = forged.systemOutcomes?.find(outcome => outcome.combine)?.combine
    if (!forgedCombination) throw new Error('missing combination outcome')
    Object.assign(forgedCombination, { baseInputHash: 'a'.repeat(64) })
    expect(() => validateWorkflowSystemLedger(forged)).toThrow()
    await expect(readFile(join(f.source, 'native-count'))).rejects.toMatchObject({ code: 'ENOENT' })
    const cold = f.create()
    expect(await cold.service.snapshot(preview.workflowId)).toMatchObject({ state: 'completed', finalReport: 'true' })
    if (combination?.state !== 'combined') throw new Error('missing integration replica')
    await expect(cold.host.replicas.resolve(combination.integration)).resolves.toMatchObject(combination.integration)
  })
  it('retains a failed integration check after successful combination', async () => {
    const f = await fixture(17), combined = f.create(f.store, combineCheckBody)
    const preview = await combined.service.planCommand({ command: '/scry-workflow run combine failed check', workspace: f.source,
      orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 4 }
    await combined.service.approve(approval)
    expect(await combined.service.start(preview.workflowId, approval)).toMatchObject({ state: 'completed', finalReport: 'false', dispatchAttempts: 0 })
    const outcomes = (await f.store.load(preview.workflowId))!.systemOutcomes!
    expect(outcomes.find(outcome => outcome.combine)).toMatchObject({ state: 'completed', combine: { state: 'combined' } })
    expect(outcomes.at(-1)).toMatchObject({ state: 'completed', check: { state: 'failed', exitCode: 17 } })
  })
  it('does not upgrade an unknown integration check into an applicable combined result', async () => {
    const f = await fixture(), combined = f.create(f.store, combineCheckBody), original = combined.host.execute.bind(combined.host)
    vi.spyOn(combined.host, 'execute').mockImplementation((preview, block, stepId, input, beforeCheck) => block.kind === 'check'
      ? { result: Promise.resolve({ state: 'unknown', settled: true, value: { state: 'unknown', reason: 'lost integration check result', derivedFrom: ['system:' + stepId] } }),
          settled: Promise.resolve(), stop: () => true }
      : original(preview, block, stepId, input, beforeCheck))
    const preview = await combined.service.planCommand({ command: '/scry-workflow run combine unknown check', workspace: f.source,
      orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 3 }
    await combined.service.approve(approval)
    expect(await combined.service.start(preview.workflowId, approval)).toMatchObject({ state: 'unknown' })
    const record = (await f.store.load(preview.workflowId))!
    expect(record.systemOutcomes?.find(outcome => outcome.combine)).toMatchObject({ state: 'completed', combine: { state: 'combined' } })
    expect(record.systemOutcomes?.at(-1)).toMatchObject({ state: 'unknown', settled: true })
  })
  it('prepares an owned current-input copy, runs frozen main check in it, and spends zero Agent attempts', async () => {
    const f = await fixture()
    const progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress).toMatchObject({ state: 'completed', finalReport: 'true', dispatchAttempts: 0 })
    expect(f.execute).not.toHaveBeenCalled()
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.systemIntents?.map(value => value.kind)).toEqual(['prepare_replica', 'check'])
    expect(record.systemOutcomes?.map(value => [value.state, value.settled])).toEqual([['completed', true], ['completed', true]])
    const intent = record.systemIntents!.find(value => value.kind === 'check')!
    expect(typeof intent.frameId).toBe('string')
    const metadata = await f.service.inspectFrame(f.preview, intent.frameId!)
    expect(metadata).toMatchObject({ state: 'available', frame: { nodeId: intent.nodeId, parentage: { state: 'available' } } })
    const corrupt = structuredClone(record)
    Object.assign(corrupt.systemIntents!.find(value => value.stepId === intent.stepId)!, { frameId: 7 })
    expect(() => validateWorkflowSystemLedger(corrupt)).toThrow()
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
    const spy = vi.spyOn(f.host, 'execute').mockImplementation((preview, block, stepId, input, beforeCheck) => block.kind !== 'check' ? original(preview, block, stepId, input, beforeCheck) : {
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
    vi.spyOn(f.host, 'execute').mockImplementation((preview, block, stepId, input, beforeCheck) => {
      if (block.kind !== 'check') return original(preview, block, stepId, input, beforeCheck)
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
