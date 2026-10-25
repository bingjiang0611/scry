import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { WorkflowBlock, WorkflowPlanPreview } from '../shared/workflow'
import type { WorkflowStoreRecord } from './workflow-store'
import { FileWorkflowStore } from './workflow-store'
import { fixture, roots } from './workflow-system.fixture'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { approval, fixture as revisionFixture, changedB } from './workflow-revision.fixture'
import { validateWorkflowRevisions } from './workflow-revisions'
import { governingWorkflowSystemPreview } from './workflow-revision-boundaries'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import { workflowOpaqueProvenance } from './workflow-opaque-provenance'
import { workflowField } from './workflow-expressions'

const ref = (name: string) => ({ kind: 'ref' as const, name })
const systemBody = (suffix = ''): Extract<WorkflowBlock, { kind: 'sequence' }> => ({ kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'replica', blockId: 'candidate' + suffix },
  { kind: 'call', blockId: 'scoped' + suffix, role: 'orchestrator', prompt: 'scoped', replica: ref('candidate' + suffix) },
  { kind: 'replica', blockId: 'checked-copy' + suffix, source: ref('candidate' + suffix) },
  { kind: 'check', blockId: 'check' + suffix, replica: ref('checked-copy' + suffix), check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
  { kind: 'verification', blockId: 'verify' + suffix, required: { check: { check: 'check' + suffix, result: ref('check' + suffix) } } },
  { kind: 'call', blockId: 'ordinary', role: 'orchestrator', prompt: 'ordinary' },
  { kind: 'call', blockId: 'consumer', role: 'orchestrator', prompt: 'consumer', inputRefs: [{ nodeId: 'check' + suffix, path: ['passed'] }] },
  { kind: 'return', blockId: 'report' + suffix, ref: { nodeId: 'verify' + suffix } }
] })

async function preparedRevision(host: { prepare(program: WorkflowPlanPreview['program']): Promise<WorkflowPlanPreview['program']> }, base: WorkflowPlanPreview, body: WorkflowBlock): Promise<WorkflowPlanPreview> {
  const candidate = structuredClone(base.program)
  candidate.body = body
  const prepared = await host.prepare(validateWorkflowProgram(candidate))
  const { programRevision: _revision, ...snapshot } = prepared
  prepared.programRevision = workflowRevision(snapshot)
  return makePlanPreview(prepared, base.roles, base.orchestrator)
}

class LegacyRevisionStore extends FileWorkflowStore {
  legacy = true
  constructor(directory: string) {
    super(directory)
    // Emulate the prior serializer only after real claim/CAS validation. The
    // original publisher still hashes and durably writes coherent artifacts.
    const publisher = this as unknown as { writeRecord(record: WorkflowStoreRecord): Promise<void> }
    const publish = publisher.writeRecord.bind(this)
    publisher.writeRecord = async record => {
      if (this.legacy && record.revisions) record.revisions = record.revisions.map(({ systemIntentOffset: _intent, systemOutcomeOffset: _outcome, ...revision }) => revision)
      await publish(record)
    }
  }
}

async function systemFixture(options: { legacy?: boolean; diagnostics?: boolean } = {}) {
  const { legacy = false, diagnostics = false } = options
  const storage = await realpath(await mkdtemp(join('/tmp', 'scry-system-revision-')))
  roots.push(storage)
  const store = legacy ? new LegacyRevisionStore(storage) : new FileWorkflowStore(storage), f = await fixture(0, store), body = systemBody()
  if (diagnostics) body.blocks.find(block => block.kind === 'check')!.check.parser = 'typescript'
  const running = f.create(store, body)
  await writeFile(join(f.source, 'check.cjs'), diagnostics ? "console.log('check.cjs(1,1): error TS9999: synthetic diagnostic'); process.exitCode = 1\n" : "console.log('ok')\n")
  await writeFile(join(f.source, 'check-alt.cjs'), "console.log('ok')\n")
  f.execute.mockImplementation(request => ({ result: (async () => {
    if (request.prompt === 'scoped') await writeFile(join(request.workspace, 'agent-output'), 'fresh')
    return { runId: request.attemptId, status: 'completed', settled: true, actualModel: 'fixture', output: request.prompt }
  })(), stop: () => true }))
  const preview = await running.service.planCommand({ command: '/scry-workflow run mixed', workspace: f.source, orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
  const firstApproval = approval(preview)
  await running.service.approve(firstApproval)
  return { ...f, ...running, store, preview, firstApproval }
}

describe('same-root revisions with closed SystemSteps', () => {
  it('runs fresh replica/check/verification/scoped Agent effects while reusing only the independent call', async () => {
    const f = await systemFixture()
    const first = await f.service.start(f.preview.workflowId, f.firstApproval), old = (await f.store.load(f.preview.workflowId))!
    const body = systemBody()
    body.blocks.at(-1)!.blockId = 'report-next'
    const next = await preparedRevision(f.host, f.preview, body)
    const second = await f.service.revise(next, approval(next), { expectedRevision: old.progress.revision! }, 'mixed-revision')
    const current = (await f.store.load(f.preview.workflowId))!
    expect(second.workflowId).toBe(f.preview.workflowId)
    expect(second.dispatchAttempts).toBe(first.dispatchAttempts + 2)
    expect(f.execute).toHaveBeenCalledTimes(5)
    expect(current.revisions).toHaveLength(2)
    expect(current.systemIntents).toHaveLength(8)
    expect(current.systemOutcomes).toHaveLength(8)
    expect(current.revisions?.[1].systemIntentOffset).toBe(old.systemIntents?.length)
    expect(current.revisions?.[1].systemOutcomeOffset).toBe(old.systemOutcomes?.length)
    expect(new Set(current.systemIntents!.slice(4).map(value => value.stepId)).size).toBe(4)
    expect(current.systemIntents!.slice(4).every(value => value.programRevision === next.programRevision)).toBe(true)
    expect(current.systemOutcomes!.slice(0, 4).every(value => value.resultRef && old.systemOutcomes!.some(previous => previous.resultRef?.hash === value.resultRef?.hash))).toBe(true)
    for (const outcome of old.systemOutcomes!) if (outcome.resultRef) await f.store.loadValue(f.preview.workflowId, outcome.resultRef)
  })

  it('invalidates a consumer when the same native node definition changes despite identical selected scalar JSON', async () => {
    const f = await systemFixture()
    const first = await f.service.start(f.preview.workflowId, f.firstApproval), old = (await f.store.load(f.preview.workflowId))!
    const body = structuredClone(f.preview.program.body) as Extract<WorkflowBlock, { kind: 'sequence' }>
    const check = body.blocks.find(value => value.kind === 'check')
    if (!check || check.kind !== 'check') throw new Error('fixture check')
    check.check = { ...check.check, argv: [process.execPath, 'check-alt.cjs'] }
    delete check.authorization
    const next = await preparedRevision(f.host, f.preview, body)
    const second = await f.service.revise(next, approval(next), { expectedRevision: old.progress.revision! }, 'same-node-check-change')
    expect(second.dispatchAttempts).toBe(first.dispatchAttempts + 2)
    expect(f.execute).toHaveBeenCalledTimes(5)
    const current = (await f.store.load(f.preview.workflowId))!, before = current.systemOutcomes!.find(value => value.stepId === old.systemOutcomes!.find(item => item.check)!.stepId)!, after = current.systemOutcomes!.find(value => value.stepId !== before.stepId && value.check)!
    const beforeValue = await f.store.loadValue(f.preview.workflowId, before.resultRef!), afterValue = await f.store.loadValue(f.preview.workflowId, after.resultRef!)
    const passed = (value: typeof beforeValue) => value.state === 'known' && value.value !== null && typeof value.value === 'object' && !Array.isArray(value.value) ? (value.value as { passed?: unknown }).passed : undefined
    expect(passed(beforeValue)).toBe(passed(afterValue))
  })

  it('accepts projected scalar provenance but rejects fake labels and a tampered canonical result reference', async () => {
    const f = await systemFixture()
    await f.service.start(f.preview.workflowId, f.firstApproval)
    const record = (await f.store.load(f.preview.workflowId))!, outcome = record.systemOutcomes!.find(value => value.check)!, full = await f.store.loadValue(f.preview.workflowId, outcome.resultRef!)
    if (full.state !== 'known') throw new Error('fixture result')
    const step = record.systemIntents!.find(value => value.stepId === outcome.stepId)!
    const projected = workflowField(full.value, ['passed'], full.derivedFrom, full)
    if (projected.state !== 'known') throw new Error('fixture projection')
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, { ...projected, derivedFrom: [`value:${outcome.resultRef!.key}:${outcome.resultRef!.hash}`] }, { record })).resolves.toEqual([JSON.stringify(['system', step.programRevision, step.stepId, outcome.resultRef!.hash])])
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, { state: 'known', value: true, derivedFrom: ['system:' + step.stepId] }, { record })).rejects.toThrow()
    const tampered = structuredClone(record), bad = tampered.systemOutcomes!.find(value => value.stepId === outcome.stepId)!
    bad.resultRef = { ...bad.resultRef!, hash: '0'.repeat(64) }
    expect(() => validateWorkflowSystemLedger(tampered)).not.toThrow()
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, { state: 'known', value: full.value, derivedFrom: ['system:' + step.stepId] }, { record: tampered })).rejects.toThrow()
  })

  it('recomputes diagnostic-bearing verification with the actual Host and rejects a hash-valid forged pass', async () => {
    const f = await systemFixture({ diagnostics: true })
    await f.service.start(f.preview.workflowId, f.firstApproval)
    const record = (await f.store.load(f.preview.workflowId))!, intent = record.systemIntents!.find(item => item.kind === 'verification')!, outcome = record.systemOutcomes!.find(item => item.stepId === intent.stepId)!
    const value = await f.store.loadValue(f.preview.workflowId, outcome.resultRef!)
    expect(value).toMatchObject({ state: 'known', value: { state: 'available', passed: false, diagnostics: { state: 'available', items: [{ file: 'check.cjs', code: 'TS9999' }] } } })
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, value, { record, verification: f.host.verification })).resolves.toEqual([JSON.stringify(['system', intent.programRevision, intent.stepId, outcome.resultRef!.hash])])
    if (value.state !== 'known' || !value.value || typeof value.value !== 'object' || Array.isArray(value.value)) throw new Error('fixture verification')
    const forged = { ...value, value: { ...value.value, passed: true } }, corrupted = structuredClone(record)
    corrupted.systemOutcomes!.find(item => item.stepId === intent.stepId)!.resultRef = await f.store.saveValue(f.preview.workflowId, intent.stepId, forged)
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, forged, { record: corrupted, verification: f.host.verification })).rejects.toThrow()
  })

  it.each(['unknown', 'unsettled', 'intent-only'] as const)('blocks a new revision when a removed historical SystemStep is %s', async mode => {
    const f = await systemFixture()
    await f.service.start(f.preview.workflowId, f.firstApproval)
    const record = (await f.store.load(f.preview.workflowId))!
    if (mode === 'unknown') record.systemOutcomes!.at(-1)!.state = 'unknown'
    else if (mode === 'unsettled') record.systemOutcomes!.at(-1)!.settled = false
    else record.systemOutcomes = []
    await f.store.save(record)
    const next = await preparedRevision(f.host, f.preview, { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'ordinary-only', role: 'orchestrator', prompt: 'ordinary' },
      { kind: 'return', blockId: 'report-only', ref: { nodeId: 'ordinary-only' } }
    ] })
    await expect(f.service.revise(next, approval(next), { expectedRevision: record.progress.revision! }, 'blocked-system-history')).rejects.toThrow()
  })

  it('rejects a hash-valid copied payload which disagrees with the main materialization receipt', async () => {
    const f = await systemFixture()
    await f.service.start(f.preview.workflowId, f.firstApproval)
    const record = (await f.store.load(f.preview.workflowId))!, originalIntent = record.systemIntents![0], originalOutcome = record.systemOutcomes![0]
    const secondStep = 'second-system', taskId = `${f.preview.workflowId}:${'a'.repeat(64)}:${originalIntent.nodeId}`
    const original = await f.store.loadValue(f.preview.workflowId, originalOutcome.resultRef!)
    const second = original.state === 'known' ? { ...original, derivedFrom: ['system:' + secondStep] } : original
    const secondRef = await f.store.saveValue(f.preview.workflowId, secondStep, second)
    record.systemIntents!.push({ ...originalIntent, stepId: secondStep, taskId, createdAt: originalIntent.createdAt + 1 })
    record.systemOutcomes!.push({ ...originalOutcome, stepId: secondStep, taskId, resultRef: secondRef, replica: { ...originalOutcome.replica!, replicaId: secondStep } })
    await f.store.save(record)
    const firstLeaves = await workflowOpaqueProvenance(f.store, f.preview.workflowId, original, { record })
    expect(firstLeaves).toEqual([JSON.stringify(['system', originalIntent.programRevision, originalIntent.stepId, originalOutcome.resultRef!.hash])])
    await expect(workflowOpaqueProvenance(f.store, f.preview.workflowId, second, { record })).rejects.toThrow()
  })

  it('retains a legacy first SystemStep revision and appends cumulative boundaries on the next revision', async () => {
    const f = await systemFixture({ legacy: true }), legacy = f.store as LegacyRevisionStore
    await f.service.start(f.preview.workflowId, f.firstApproval)
    legacy.legacy = false
    const old = (await f.store.load(f.preview.workflowId))!
    expect(old.revisions?.[0].systemIntentOffset).toBeUndefined()
    const next = await preparedRevision(f.host, f.preview, systemBody('-legacy-next'))
    await f.service.revise(next, approval(next), { expectedRevision: old.progress.revision! }, 'legacy-system-revision')
    const current = (await f.store.load(f.preview.workflowId))!
    expect(current.revisions).toHaveLength(2)
    expect(current.revisions?.[1].systemIntentOffset).toBe(old.systemIntents?.length)
    expect(current.revisions?.[1].systemOutcomeOffset).toBe(old.systemOutcomes?.length)
  })

  it('keeps legacy pure multi-revision boundaries at zero and rejects relabelled known boundaries', async () => {
    const storage = await realpath(await mkdtemp(join('/tmp', 'scry-legacy-revision-'))), legacy = new LegacyRevisionStore(storage)
    roots.push(storage)
    const f = await revisionFixture(false, true, false, undefined, legacy)
    await f.start()
    await f.revise(changedB(f.preview))
    legacy.legacy = false
    const record = await f.record()
    const pure = structuredClone(record)
    for (const item of pure.revisions!) { delete item.systemIntentOffset; delete item.systemOutcomeOffset }
    pure.systemIntents = undefined; pure.systemOutcomes = undefined
    validateWorkflowRevisions(pure)
    expect(pure.systemIntents).toBeUndefined()
    await f.store.save(pure)
    await writeFile(join(f.workspace, 'check.cjs'), "console.log('ok')\n")
    const body = structuredClone(pure.preview.program.body) as Extract<WorkflowBlock, { kind: 'sequence' }>
    body.blocks = [
      ...body.blocks.slice(0, -1),
      { kind: 'replica', blockId: 'legacy-candidate' },
      { kind: 'check', blockId: 'legacy-check', replica: ref('legacy-candidate'), check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
      { kind: 'verification', blockId: 'legacy-verify', required: { check: { check: 'legacy-check', result: ref('legacy-check') } } },
      { kind: 'return', blockId: 'legacy-report', ref: { nodeId: 'legacy-verify' } }
    ]
    const next = await preparedRevision(f.host!, pure.preview, body)
    const revised = await f.revise(next, 'legacy-to-system')
    expect(revised.state, revised.error).toBe('completed')
    const mixed = await f.record()
    expect(mixed.revisions).toHaveLength(3)
    expect(mixed.revisions?.[2].systemIntentOffset).toBe(0)
    expect(mixed.revisions?.[2].systemOutcomeOffset).toBe(0)
    expect(mixed.systemIntents).toHaveLength(3)
    expect(governingWorkflowSystemPreview(mixed, 'intent', 0)).toEqual(mixed.revisions![2].preview)
    const relabelled = structuredClone(mixed)
    relabelled.revisions![2].systemIntentOffset = 4
    expect(() => governingWorkflowSystemPreview(relabelled, 'intent', 0)).toThrow()
    expect(() => governingWorkflowSystemPreview(mixed, 'intent', mixed.systemIntents!.length)).toThrow()
    expect(pure.revisions).toHaveLength(2)
    await f.cleanup()
  })
})
