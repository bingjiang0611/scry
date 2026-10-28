import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowValue } from '../shared/workflow'
import { workflowBatchMigrationTemplate } from '../shared/workflow-batch-migration'
import { fixture } from './workflow-system.fixture'

function executableBody(items = [{ key: 'left', value: { path: 'left.txt' } }, { key: 'right', value: { path: 'right.txt' } }]): WorkflowBlock {
  const definition = workflowBatchMigrationTemplate({
    items,
    goal: 'migrate both items', instruction: 'write the requested item file',
    check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' }
  })
  if (definition.body.kind !== 'sequence') throw new Error('batch fixture shape')
  const body = structuredClone(definition.body), mapped = body.blocks.find(block => block.kind === 'map')
  if (!mapped || mapped.kind !== 'map' || mapped.body.kind !== 'sequence' || mapped.body.blocks[0].kind !== 'bind') throw new Error('batch map fixture shape')
  delete mapped.body.blocks[0].schema
  const value = (name: 'items' | 'goal' | 'instruction'): WorkflowValue => {
    const defaultValue = definition.parameters[name].default
    if (defaultValue === undefined) throw new Error('batch parameter default')
    return defaultValue
  }
  return { ...body, blocks: [
    { kind: 'bind', blockId: 'items', value: { kind: 'literal', value: value('items') } },
    { kind: 'bind', blockId: 'goal', value: { kind: 'literal', value: value('goal') } },
    { kind: 'bind', blockId: 'instruction', value: { kind: 'literal', value: value('instruction') } },
    ...body.blocks
  ] }
}

async function startBatch(f: Awaited<ReturnType<typeof fixture>>, body = executableBody(), runtime = f.create(f.store, body)) {
  const preview = await runtime.service.planCommand({ command: '/scry-workflow run batch migration', workspace: f.source,
    orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [{ role: 'worker', providerId: 'claude' }] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 5 }
  await runtime.service.approve(approval)
  return { runtime, preview, approval, progress: await runtime.service.start(preview.workflowId, approval) }
}

async function checkSourceBytes(f: Awaited<ReturnType<typeof fixture>>, before: string) {
  expect(await readFile(join(f.source, 'check.cjs'), 'utf8')).toBe(before)
}

describe('batch migration canonical runtime', () => {
  it('edits isolated candidates, combines accepted bytes, checks integration and leaves source unchanged', async () => {
    const f = await fixture(), before = await readFile(join(f.source, 'check.cjs'), 'utf8')
    let call = 0
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      call++
      await writeFile(join(request.workspace, call === 1 ? 'left.txt' : 'right.txt'), String(call))
      return { runId: `migration-${call}`, status: 'completed', output: 'done', settled: true }
    })() }))
    const { runtime, preview, progress } = await startBatch(f)
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 2 })
    const record = (await f.store.load(preview.workflowId))!, combined = record.systemOutcomes?.find(outcome => outcome.combine)?.combine
    expect(combined).toMatchObject({ state: 'combined', candidateCount: 2 })
    if (combined?.state !== 'combined') throw new Error('missing integration')
    const receipt = await runtime.host.replicas.resolve(combined.integration)
    expect(await readFile(join(receipt.directory, 'left.txt'), 'utf8')).toBe('1')
    expect(await readFile(join(receipt.directory, 'right.txt'), 'utf8')).toBe('2')
    await checkSourceBytes(f, before)
    const cold = f.create()
    expect(await cold.service.snapshot(preview.workflowId)).toMatchObject({ state: 'completed', finalReport: expect.stringContaining('"passed":true') })
    await expect(cold.host.replicas.resolve(combined.integration)).resolves.toMatchObject(combined.integration)
  })

  it('excludes a failed candidate from combine while retaining the passing candidate', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'check.cjs'), "const fs = require('node:fs'); if (fs.existsSync('left.txt') && fs.readFileSync('left.txt', 'utf8') === 'failed') process.exitCode = 17")
    const before = await readFile(join(f.source, 'check.cjs'), 'utf8')
    let call = 0
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      call++
      await writeFile(join(request.workspace, call === 1 ? 'left.txt' : 'right.txt'), call === 1 ? 'failed' : 'passed')
      return { runId: `migration-${call}`, status: 'completed', output: 'done', settled: true }
    })() }))
    const { preview, progress } = await startBatch(f)
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 2 })
    const record = (await f.store.load(preview.workflowId))!, checks = record.systemOutcomes?.filter(outcome => outcome.check)
    expect(checks?.map(outcome => outcome.check?.state)).toEqual(['failed', 'passed', 'passed'])
    expect(record.systemOutcomes?.find(outcome => outcome.combine)?.combine).toMatchObject({ state: 'combined', candidateCount: 1 })
    await checkSourceBytes(f, before)
  })

  it.each(['unknown', 'stopped'] as const)('excludes a %s candidate from combine and retains its durable status', async state => {
    const f = await fixture(), before = await readFile(join(f.source, 'check.cjs'), 'utf8'), runtime = f.create(f.store, executableBody([{ key: 'only', value: { path: 'only.txt' } }]))
    const original = runtime.host.execute.bind(runtime.host)
    f.execute.mockImplementation(_request => ({ stop: () => true, result: Promise.resolve({ runId: 'candidate-status', status: 'completed', output: 'done', settled: true }) }))
    vi.spyOn(runtime.host, 'execute').mockImplementation((preview, block, stepId, input, beforeCheck) => block.kind !== 'check' ? original(preview, block, stepId, input, beforeCheck) : {
      result: Promise.resolve({ state, settled: true, value: { state: 'unknown', reason: `candidate ${state}`, derivedFrom: ['system:' + stepId] } }),
      settled: Promise.resolve(), stop: () => true
    })
    const { preview, progress } = await startBatch(f, executableBody([{ key: 'only', value: { path: 'only.txt' } }]), runtime)
    const record = (await f.store.load(preview.workflowId))!
    const candidate = record.systemOutcomes?.find(outcome => outcome.state === state)
    expect(candidate).toMatchObject({ state, settled: true })
    expect(record.systemIntents?.some(intent => intent.kind === 'combine')).toBe(false)
    await checkSourceBytes(f, before)
    await expect(f.create().service.snapshot(preview.workflowId)).resolves.toMatchObject({ state: progress.state })
  })

  it('skips combine when no candidate passes and leaves source bytes unchanged', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'check.cjs'), 'process.exitCode = 17')
    const before = await readFile(join(f.source, 'check.cjs'), 'utf8')
    let call = 0
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      call++
      await writeFile(join(request.workspace, call === 1 ? 'left.txt' : 'right.txt'), 'candidate')
      return { runId: `migration-${call}`, status: 'completed', output: 'done', settled: true }
    })() }))
    const { preview, progress } = await startBatch(f)
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 2 })
    const record = (await f.store.load(preview.workflowId))!
    expect(record.systemIntents?.some(intent => intent.kind === 'combine')).toBe(false)
    expect(record.systemIntents?.some(intent => intent.kind === 'check')).toBe(true)
    await checkSourceBytes(f, before)
  })

  it('preserves a durable conflict and skips integration check for conflicting accepted candidates', async () => {
    const f = await fixture(), before = await readFile(join(f.source, 'check.cjs'), 'utf8')
    let call = 0
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      call++
      await writeFile(join(request.workspace, 'shared.txt'), call === 1 ? 'left' : 'right')
      return { runId: `migration-${call}`, status: 'completed', output: 'done', settled: true }
    })() }))
    const { preview, progress } = await startBatch(f)
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 2 })
    const record = (await f.store.load(preview.workflowId))!, conflict = record.systemOutcomes?.find(outcome => outcome.combine)?.combine
    expect(conflict).toMatchObject({ state: 'conflict', integration: null, candidateCount: 2, conflicts: [{ path: 'shared.txt' }] })
    expect(record.systemIntents?.filter(intent => intent.kind === 'check')).toHaveLength(2)
    await expect(f.create().service.snapshot(preview.workflowId)).resolves.toMatchObject({ state: 'completed' })
    await checkSourceBytes(f, before)
  })

  it('does not report integration failure as a successful migration', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'check.cjs'), "const fs = require('node:fs'); if (fs.existsSync('left.txt') && fs.existsSync('right.txt')) process.exitCode = 17")
    const before = await readFile(join(f.source, 'check.cjs'), 'utf8')
    let call = 0
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      call++
      await writeFile(join(request.workspace, call === 1 ? 'left.txt' : 'right.txt'), 'passed')
      return { runId: `migration-${call}`, status: 'completed', output: 'done', settled: true }
    })() }))
    const { preview, progress } = await startBatch(f)
    expect(progress).toMatchObject({ state: 'completed', finalReport: expect.not.stringContaining('"passed":true') })
    expect((await f.store.load(preview.workflowId))!.systemOutcomes?.at(-1)).toMatchObject({ check: { state: 'failed' } })
    await checkSourceBytes(f, before)
  })

  it('does not upgrade an unknown integration check into completed success', async () => {
    const f = await fixture(), runtime = f.create(f.store, executableBody()), before = await readFile(join(f.source, 'check.cjs'), 'utf8')
    let call = 0
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      call++
      await writeFile(join(request.workspace, call === 1 ? 'left.txt' : 'right.txt'), 'passed')
      return { runId: `migration-${call}`, status: 'completed', output: 'done', settled: true }
    })() }))
    const original = runtime.host.execute.bind(runtime.host)
    let checks = 0
    vi.spyOn(runtime.host, 'execute').mockImplementation((preview, block, stepId, input, beforeCheck) => {
      if (block.kind === 'check' && ++checks === 3) return {
        result: Promise.resolve({ state: 'unknown', settled: true, value: { state: 'unknown', reason: 'integration evidence lost', derivedFrom: ['system:' + stepId] } }),
        settled: Promise.resolve(), stop: () => true
      }
      return original(preview, block, stepId, input, beforeCheck)
    })
    const { preview, progress } = await startBatch(f, executableBody(), runtime)
    expect(progress).toMatchObject({ state: 'unknown' })
    const record = (await f.store.load(preview.workflowId))!
    expect(record.systemOutcomes?.find(outcome => outcome.combine)?.combine).toMatchObject({ state: 'combined' })
    expect(record.systemOutcomes?.at(-1)).toMatchObject({ state: 'unknown', settled: true })
    await checkSourceBytes(f, before)
  })
})
