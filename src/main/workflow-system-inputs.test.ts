import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import { verifyWorkflowCheckInputs } from './workflow-input-snapshot'
import { workflowSystemSourceBody } from './workflow-program'
import * as checks from './workflow-check'
import { CutParentStore, fixture } from './workflow-system.fixture'

describe('SystemStep input and diagnostic evidence', () => {
  it('commits the complete input manifest before a native check, then records only the observed interval differences', async () => {
    const f = await fixture(), save = f.store.save.bind(f.store)
    let beforeCommitted = false
    vi.spyOn(f.store, 'save').mockImplementation(async record => {
      await save(record)
      if (record.systemIntents?.some(intent => intent.inputSnapshot)) beforeCommitted = true
    })
    const execute = checks.executeWorkflowCheck
    const spawn = vi.spyOn(checks, 'executeWorkflowCheck').mockImplementation((...args) => {
      expect(beforeCommitted).toBe(true)
      return execute(...args)
    })
    try {
      expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'completed' })
      const record = (await f.store.load(f.preview.workflowId))!, check = record.systemOutcomes![1].check!, inputs = check.inputs!
      expect(record.systemIntents![1].inputSnapshot).toEqual(inputs.before)
      const missing = structuredClone(record)
      delete missing.systemIntents![1].inputSnapshot
      expect(() => validateWorkflowSystemLedger(missing)).toThrow()
      const foreign = structuredClone(record)
      foreign.systemIntents![1].inputSnapshot!.reference.workflowId = 'another-root'
      expect(() => validateWorkflowSystemLedger(foreign)).toThrow()
      expect(inputs.before.inputHash).toBe(record.systemOutcomes![0].replica!.inputHash)
      expect(inputs.changes).toMatchObject({ state: 'available', source: 'snapshot_comparison', count: 1 })
      expect(inputs.changes.after!.inputHash).not.toBe(inputs.before.inputHash)
      if (inputs.changes.state !== 'available') throw new Error('fixture shape')
      expect(await f.store.loadValue(f.preview.workflowId, inputs.changes.reference)).toMatchObject({ value: [{ path: 'native-count', kind: 'added' }] })
      await verifyWorkflowCheckInputs(f.store, f.preview.workflowId, record.systemIntents![1].stepId, inputs.before, inputs)
      await expect(readFile(join(f.source, 'native-count'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { spawn.mockRestore() }
  })
  it('captures the modified Agent candidate, not the original replica receipt, and excludes prior Agent writes from the check interval', async () => {
    const f = await fixture(), body = workflowSystemSourceBody(f.preview.program.body)
    if (body.kind !== 'sequence') throw new Error('fixture shape')
    body.blocks.splice(1, 0, { kind: 'call', blockId: 'candidate', role: 'orchestrator', prompt: 'write owned candidate', replica: { kind: 'ref', name: 'copy' } })
    f.execute.mockImplementation(request => ({ stop: () => true, result: (async () => {
      await writeFile(join(request.workspace, 'candidate-change'), 'Agent fixture writes before the check')
      return { runId: 'candidate-agent', status: 'completed', output: 'candidate', settled: true }
    })() }))
    const { service } = f.create(f.store, body)
    const preview = await service.planCommand({ command: '/scry-workflow run verify candidate', workspace: f.source, orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    expect(await service.start(preview.workflowId, approval)).toMatchObject({ state: 'completed', finalReport: 'true', dispatchAttempts: 1 })
    const record = (await f.store.load(preview.workflowId))!, inputs = record.systemOutcomes![1].check!.inputs!
    expect(inputs.before.inputHash).not.toBe(record.systemOutcomes![0].replica!.inputHash)
    if (inputs.changes.state !== 'available') throw new Error('fixture shape')
    expect(await f.store.loadValue(preview.workflowId, inputs.changes.reference)).toMatchObject({ value: [{ path: 'native-count', kind: 'added' }] })
    await expect(readFile(join(f.source, 'candidate-change'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('never starts the native check when its input-intent checkpoint fails', async () => {
    const f = await fixture(), save = f.store.save.bind(f.store)
    let rejected = false
    vi.spyOn(f.store, 'save').mockImplementation(async record => {
      if (!rejected && record.systemIntents?.some(intent => intent.inputSnapshot)) { rejected = true; throw new Error('input intent checkpoint failed') }
      return save(record)
    })
    const spawn = vi.spyOn(checks, 'executeWorkflowCheck')
    try {
      expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'failed' })
      expect(rejected).toBe(true)
      expect(spawn).not.toHaveBeenCalled()
      const record = (await f.store.load(f.preview.workflowId))!, receipt = await f.host.replicas.resolve(record.systemOutcomes![0].replica!)
      await expect(readFile(join(receipt.directory, 'native-count'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(record.systemIntents).toHaveLength(2)
      expect(record.progress.dispatchAttempts).toBe(0)
    } finally { spawn.mockRestore() }
  })
  it('does not scan a still-open native scope or release its capacity on a stop ACK', async () => {
    const f = await fixture()
    let close!: () => void
    const physical = new Promise<void>(resolve => { close = resolve })
    const spawn = vi.spyOn(checks, 'executeWorkflowCheck').mockReturnValue({ settled: physical, stop: () => true,
      result: Promise.resolve({ state: 'unknown', settled: false, startedAt: 1, finishedAt: 2, exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, evidence: 'exact', diagnostics: { state: 'unavailable', reason: 'controlled transport loss' } }) })
    let neighbor: Promise<void> | undefined
    try {
      expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'unknown' })
      const record = (await f.store.load(f.preview.workflowId))!, inputs = record.systemOutcomes![1].check!.inputs!
      expect(inputs.before).toEqual(record.systemIntents![1].inputSnapshot)
      expect(inputs.changes).toMatchObject({ state: 'unavailable' })
      expect(inputs.changes.after).toBeUndefined()
      expect(spawn.mock.results[0].value.stop()).toBe(true)
      neighbor = f.slots.withSlot(async () => {}, 'neighbor')
      expect(f.slots.active).toBe(1)
      expect(f.slots.queued).toBe(1)
      close(); await neighbor
      await expect(f.service.resume(f.preview.workflowId, f.approval, 'physical-close-is-not-replay')).rejects.toThrow()
    } finally { close(); await neighbor; spawn.mockRestore() }
  })
  it('keeps an actual passed exit separate from unavailable post-check filesystem evidence', async () => {
    const f = await fixture(), body = workflowSystemSourceBody(f.preview.program.body)
    const script = await readFile(join(f.source, 'check.cjs'), 'utf8')
    await writeFile(join(f.source, 'check.cjs'), script + `; fs.symlinkSync(${JSON.stringify(f.source)}, 'outside-link')`)
    const { service } = f.create(f.store, body)
    const preview = await service.planCommand({ command: '/scry-workflow run opaque post-state', workspace: f.source, orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    expect(await service.start(preview.workflowId, approval)).toMatchObject({ state: 'completed', finalReport: 'true' })
    const record = (await f.store.load(preview.workflowId))!, outcome = record.systemOutcomes![1]
    expect(outcome.check).toMatchObject({ state: 'passed', settled: true, inputs: { changes: { state: 'unavailable' } } })
    expect(outcome.check!.inputs!.changes.after).toBeUndefined()
    expect(await f.store.loadValue(preview.workflowId, outcome.resultRef!)).toMatchObject({ value: { passed: true, inputs: { changes: { state: 'unavailable' } } } })
  })
  it.each(['before', 'after', 'changes'] as const)('refuses cold reuse on missing %s input evidence without native replay', async part => {
    const store = new CutParentStore(), f = await fixture(0, store)
    store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('system parent checkpoint')
    store.cut = false
    const record = (await store.load(f.preview.workflowId))!, inputs = record.systemOutcomes![1].check!.inputs!
    if (inputs.changes.state !== 'available') throw new Error('fixture shape')
    const reference = part === 'before' ? inputs.before.reference : part === 'after' ? inputs.changes.after.reference : inputs.changes.reference
    const load = store.loadValue.bind(store)
    vi.spyOn(store, 'loadValue').mockImplementation((workflowId, ref) => ref.key === reference.key ? Promise.reject(new Error('missing check input evidence')) : load(workflowId, ref))
    const cold = f.create(), execute = vi.spyOn(cold.host, 'execute')
    await cold.service.approve(f.approval)
    await expect(cold.service.resume(f.preview.workflowId, f.approval, 'missing-input-' + part)).rejects.toThrow('missing check input evidence')
    expect(execute).not.toHaveBeenCalled()
    const receipt = await f.host.replicas.resolve(record.systemOutcomes![0].replica!)
    expect(await readFile(join(receipt.directory, 'native-count'), 'utf8')).toBe('1')
    expect((await store.load(f.preview.workflowId))!.systemIntents).toEqual(record.systemIntents)
  })
  it.each([true, false])('feeds actual derived diagnostics into the canonical map; available=%s (unavailable is not [])', async available => {
    const store = new CutParentStore(), f = await fixture(1, store)
    const output = available ? 'src/a.ts(2,3): error TS2322: wrong type\nsrc/b.ts(4,5): error TS7006: missing type' : 'unrecognized compiler protocol'
    const script = await readFile(join(f.source, 'check.cjs'), 'utf8')
    await writeFile(join(f.source, 'check.cjs'), script.replace("console.log('observed')", `console.log(${JSON.stringify(output)})`))
    const body = workflowSystemSourceBody(f.preview.program.body)
    if (body.kind !== 'sequence' || body.blocks[1].kind !== 'check') throw new Error('fixture shape')
    body.blocks[1].check.parser = 'typescript'
    body.blocks.splice(2, 1,
      { kind: 'map', blockId: 'diagnostics', items: { kind: 'field', source: { kind: 'ref', name: 'verify' }, path: ['diagnostics', 'items'] }, item: 'diagnostic', key: ['code'], maxItems: 4,
        body: { kind: 'bind', blockId: 'entry', value: { kind: 'ref', name: 'diagnostic' } } },
      { kind: 'collect', blockId: 'collected', items: { kind: 'ref', name: 'diagnostics' } },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'collected' } })
    const { service } = f.create(store, body)
    const preview = await service.planCommand({ command: '/scry-workflow run inspect diagnostics', workspace: f.source, orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await service.approve(approval)
    if (available) {
      store.cut = true
      await expect(service.start(preview.workflowId, approval)).rejects.toThrow('system parent checkpoint')
      store.cut = false
      const cold = f.create().service
      await cold.approve(approval)
      const progress = (await cold.resume(preview.workflowId, approval, 'consume-recorded-diagnostics')).progress!
      expect(progress.state).toBe('completed')
      const values = JSON.parse(progress.finalReport!).map((row: { value: unknown }) => row.value)
      expect(values).toEqual([{ file: 'src/a.ts', line: 2, column: 3, code: 'TS2322', message: 'wrong type' }, { file: 'src/b.ts', line: 4, column: 5, code: 'TS7006', message: 'missing type' }])
    } else {
      const progress = await service.start(preview.workflowId, approval)
      expect(progress.state).toBe('blocked')
      expect(progress.finalReport).toBeUndefined()
    }
    const record = (await store.load(preview.workflowId))!
    expect(record.progress.dispatchAttempts).toBe(0)
    expect(record.systemOutcomes![1].check!.diagnostics.state).toBe(available ? 'available' : 'unavailable')
    const value = await store.loadValue(preview.workflowId, record.systemOutcomes![1].resultRef!)
    expect(value).toMatchObject({ state: 'known', value: { diagnosticCount: available ? 2 : null, diagnostics: available ? { state: 'available', source: 'derived' } : { state: 'unavailable' } } })
    const receipt = await f.host.replicas.resolve(record.systemOutcomes![0].replica!)
    expect(await readFile(join(receipt.directory, 'native-count'), 'utf8')).toBe('1')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('continues a frozen old check value without inventing diagnostics or rerunning it', async () => {
    const store = new CutParentStore(), f = await fixture(0, store), execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation((preview, block, stepId, input) => {
      const execution = execute(preview, block, stepId, input, async () => {})
      return { ...execution, result: execution.result.then(result => {
        const prior = structuredClone(result)
        if (prior.check) delete prior.check.inputs
        if (prior.value.state === 'known' && prior.value.value && typeof prior.value.value === 'object' && !Array.isArray(prior.value.value)) {
          delete prior.value.value.diagnostics
          delete prior.value.value.inputs
        }
        return prior
      }) }
    })
    store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('system parent checkpoint')
    store.cut = false
    const record = (await store.load(f.preview.workflowId))!, frozen = await store.loadValue(f.preview.workflowId, record.systemOutcomes![1].resultRef!)
    expect(frozen).toMatchObject({ state: 'known', value: { passed: true } })
    if (frozen.state !== 'known' || !frozen.value || typeof frozen.value !== 'object') throw new Error('fixture shape')
    expect(Object.hasOwn(frozen.value, 'diagnostics')).toBe(false)
    const cold = f.create().service
    await cold.approve(f.approval)
    expect((await cold.resume(f.preview.workflowId, f.approval, 'legacy-check-data')).progress).toMatchObject({ state: 'completed', finalReport: 'true' })
    const receipt = await f.host.replicas.resolve(record.systemOutcomes![0].replica!)
    expect(await readFile(join(receipt.directory, 'native-count'), 'utf8')).toBe('1')
    expect(f.execute).not.toHaveBeenCalled()
  })
})
