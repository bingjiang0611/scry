import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkflowExecutionInspectionRequest } from '../shared/workflow-inspection'
import { FileWorkflowStore, MemoryWorkflowStore, type WorkflowStore } from './workflow-store'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowSlots } from './workflow-runner'

const services: WorkflowService[] = []
const roots: string[] = []
afterEach(async () => {
  const owned = services.splice(0)
  await Promise.all(owned.map(service => service.prepareForShutdown()))
  for (const service of owned) service.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const canary = 'PRIVATE_INTERMEDIATE_BODY'
async function fixture(count = 2, store: WorkflowStore = new MemoryWorkflowStore()) {
  const role = { role: 'orchestrator' as const, providerId: 'codex' as const }
  const plan = vi.fn(async () => ({ output: JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
    ...Array.from({ length: count }, (_, index) => ({ kind: 'call', blockId: `call_${index}`, role: 'orchestrator', prompt: canary })),
    { kind: 'return', blockId: 'finish', ref: { nodeId: `call_${count - 1}` } }
  ] } }) }))
  const execute = vi.fn<WorkflowServiceOptions['execute']>(({ attemptId }) => ({ result: Promise.resolve({
    runId: `run-${attemptId}`, status: 'completed', settled: true, output: canary, actualModel: 'observed-model'
  }), stop: () => true }))
  const runControls = vi.fn<WorkflowServiceOptions['runControls']>(async () => ({
    descriptor: { id: 'codex', label: 'fixture', runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
      capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } },
    model: true, stop: true, identity: 'fixture-runtime', independentRun: true, terminalOutput: true
  }))
  const service = new WorkflowService({ store, slots: new WorkflowSlots(2), providerRegistered: () => true, plan, execute, runControls })
  services.push(service)
  const preview = await service.planCommand({ command: '/scry-workflow run inspection fixture', commandId: 'inspection-plan', workspace: '/fixture', orchestrator: role, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await service.approve(approval)
  expect((await service.start(preview.workflowId, approval)).state).toBe('completed')
  const query: WorkflowExecutionInspectionRequest = { workflowId: preview.workflowId, programRevision: preview.programRevision, kind: 'attempts' }
  plan.mockClear(); execute.mockClear(); runControls.mockClear()
  return { store, service, query, plan, execute, runControls }
}

describe('canonical execution inspection', () => {
  it('pages beyond the progress tail, coalesces intent/result and never dispatches or transfers bodies', async () => {
    const f = await fixture(35)
    const before = await f.store.load(f.query.workflowId)
    const load = vi.spyOn(f.store, 'load')
    const authorize = vi.fn()
    const first = await f.service.inspectExecution(f.query, authorize)
    expect(load).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledExactlyOnceWith('/fixture')
    expect(first).toMatchObject({ state: 'available', source: 'canonical_ledger', total: 35, nextOffset: 32 })
    if (first.state !== 'available') throw new Error('missing page')
    expect(first.records).toHaveLength(32)
    const second = await f.service.inspectExecution({ ...f.query, offset: first.nextOffset }, authorize)
    expect(second).toMatchObject({ state: 'available', total: 35, offset: 32 })
    if (second.state !== 'available') throw new Error('missing second page')
    expect(second.records).toHaveLength(3)
    expect(second.nextOffset).toBeUndefined()
    const ids = [...first.records, ...second.records].map(row => 'attemptId' in row ? row.attemptId : row.stepId)
    expect(new Set(ids).size).toBe(35)
    expect(JSON.stringify([first, second])).not.toContain(canary)
    expect(await f.store.load(f.query.workflowId)).toEqual(before)
    expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.runControls).not.toHaveBeenCalled()
  })

  it('uses the admission frame before an older call reference, preserving original source/model and unsettled result', async () => {
    const f = await fixture()
    const record = (await f.store.load(f.query.workflowId))!
    record.intents[0].callFrameId = 'older-call-reference'
    record.intents[0].programRevision = 'a'.repeat(64)
    record.intents[0].previousAttemptId = 'previous-attempt'
    record.intents[0].retryCommandId = 'retry-command'
    record.outcomes[0].settled = false
    record.outcomes[0].error = 'e'.repeat(5000)
    await f.store.save(record)
    const page = await f.service.inspectExecution(f.query, () => {})
    if (page.state !== 'available') throw new Error('missing page')
    expect(page.records[0]).toMatchObject({ intent: { state: 'available', value: {
      programRevision: 'a'.repeat(64), previousAttemptId: 'previous-attempt', retryCommandId: 'retry-command',
      frame: { state: 'available', frameId: record.intents[0].frameId }
    } }, outcome: { state: 'available', value: { state: 'completed', settled: false, actualModel: 'observed-model', actualModelStatus: 'observed', errorTruncated: true } } })
    const row = page.records[0]
    if ('attemptId' in row && row.outcome.state === 'available') expect(row.outcome.value.error).toHaveLength(4096)
    expect(JSON.stringify(page)).not.toMatch(/"(output|outputRef|tokens|cost)":/)
  })

  it('retains intent-only and legacy outcome-only records without fabricating a result or frame', async () => {
    const f = await fixture()
    const record = (await f.store.load(f.query.workflowId))!
    record.outcomes = record.outcomes.slice(1)
    record.intents = record.intents.slice(0, 1)
    await f.store.save(record)
    const page = await f.service.inspectExecution(f.query, () => {})
    if (page.state !== 'available') throw new Error('missing page')
    expect(page.total).toBe(2)
    expect(page.records[0]).toMatchObject({ intent: { state: 'available' }, outcome: { state: 'unavailable', reason: 'missing_outcome' } })
    expect(page.records[1]).toMatchObject({ intent: { state: 'unavailable', reason: 'missing_intent' }, outcome: { state: 'available' } })
    expect((await f.service.inspectExecution({ ...f.query, nodeId: 'call_1' }, () => {}))).toMatchObject({ state: 'available', total: 1 })
  })

  it('preserves system outcomes without inventing a legacy node/kind and excludes check payloads', async () => {
    const f = await fixture()
    const record = (await f.store.load(f.query.workflowId))!
    record.systemIntents = [{ stepId: 'system-one', taskId: 'system-task', nodeId: 'check', programRevision: 'b'.repeat(64), kind: 'check', createdAt: 1, frameId: 'system-frame' }]
    record.systemOutcomes = [
      { stepId: 'system-one', taskId: 'system-task', state: 'unknown', settled: false, startedAt: 2, finishedAt: 3,
        check: { state: 'unknown', startedAt: 2, finishedAt: 3, settled: false, exitCode: null, signal: null, truncated: false, evidence: 'exact', error: canary,
          stdoutRef: { workflowId: f.query.workflowId, key: 'stdout', hash: 'a'.repeat(64) },
          stderrRef: { workflowId: f.query.workflowId, key: 'stderr', hash: 'b'.repeat(64) }, diagnostics: { state: 'unavailable', reason: canary } } },
      { stepId: 'system-legacy', taskId: 'opaque-legacy-task', state: 'failed', settled: true, startedAt: 4, finishedAt: 5 }
    ]
    await f.store.save(record)
    const query = { ...f.query, kind: 'systems' as const }
    const page = await f.service.inspectExecution(query, () => {})
    if (page.state !== 'available') throw new Error('missing page')
    expect(page.total).toBe(2)
    expect(page.records[0]).toMatchObject({ intent: { value: { nodeId: 'check', programRevision: 'b'.repeat(64), frame: { frameId: 'system-frame' } } }, outcome: { value: { state: 'unknown', settled: false } } })
    expect(page.records[1]).toMatchObject({ intent: { state: 'unavailable' }, outcome: { value: { state: 'failed', settled: true } } })
    expect(await f.service.inspectExecution({ ...query, nodeId: 'opaque-legacy-task' }, () => {})).toMatchObject({ state: 'available', total: 0 })
    expect(JSON.stringify(page)).not.toMatch(/"(check|stdout|stderr|diagnostics|replica|inputSnapshot)":/)
    expect(JSON.stringify(page)).not.toContain(canary)
  })

  it('reads the same canonical ledger after a cold file-backed service without another execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-execution-inspection-'))
    roots.push(root)
    const f = await fixture(1, new FileWorkflowStore(root))
    const before = await f.service.inspectExecution(f.query, () => {})
    const cold = new WorkflowService({ store: new FileWorkflowStore(root), slots: new WorkflowSlots(2), providerRegistered: () => true,
      plan: f.plan, execute: f.execute, runControls: f.runControls })
    services.push(cold)
    const after = await cold.inspectExecution(f.query, () => {})
    if (before.state !== 'available' || after.state !== 'available') throw new Error('missing canonical page')
    expect(after.records).toEqual(before.records)
    expect(after.total).toBe(1)
    expect(JSON.stringify(after)).not.toContain(canary)
    expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.runControls).not.toHaveBeenCalled()
  })

  it('refuses source changes and workspace denial without probing runtime or changing the ledger', async () => {
    const f = await fixture()
    const before = await f.store.load(f.query.workflowId)
    const authorize = vi.fn(() => { throw new Error('authority denied') })
    await expect(f.service.inspectExecution(f.query, authorize)).rejects.toThrow('authority denied')
    await expect(f.service.inspectExecution(f.query, async () => { throw new Error('async authority denied') })).rejects.toThrow('async authority denied')
    expect(await f.service.inspectExecution({ ...f.query, programRevision: 'f'.repeat(64) }, () => {})).toMatchObject({ state: 'unavailable', reason: 'source_changed' })
    expect(await f.service.inspectExecution({ ...f.query, workflowId: 'missing-root' }, () => {})).toMatchObject({ state: 'unavailable', reason: 'root_missing' })
    expect(await f.store.load(f.query.workflowId)).toEqual(before)
    expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.runControls).not.toHaveBeenCalled()
  })
})
