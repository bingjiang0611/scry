import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowControlFrame } from '../shared/workflow'
import { MemoryWorkflowStore } from './workflow-store'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import { fixture } from './workflow-system.fixture'
import * as checks from './workflow-check'

class CutBindingStore extends MemoryWorkflowStore {
  cut = false
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, expected: number) {
    if (this.cut && frame.nodeId === 'root' && frame.cursor === 4) throw new Error('binding parent checkpoint cut')
    return super.saveFrame(frame, expected)
  }
}

async function candidate(store = new CutBindingStore(), changedVerification = false) {
  const f = await fixture(0, store)
  f.execute.mockImplementation(request => ({ result: (async () => {
    await writeFile(join(request.workspace, request.prompt === 'candidate' ? 'candidate-output' : 'verification-output'), 'actual changed input')
    return { runId: 'binding-' + request.attemptId, status: 'completed', output: 'done', settled: true }
  })(), stop: () => true }))
  const ref = (name: string) => ({ kind: 'ref', name })
  const body = { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'candidate' },
    { kind: 'call', blockId: 'edit', role: 'orchestrator', prompt: 'candidate', replica: ref('candidate') },
    { kind: 'replica', blockId: 'verification', source: ref('candidate') },
    ...(changedVerification ? [{ kind: 'call', blockId: 'alter', role: 'orchestrator', prompt: 'verification', replica: ref('verification') }] : []),
    { kind: 'check', blockId: 'verify', replica: ref('verification'), check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'verify', path: ['inputs', 'materialization'] } }
  ] }
  const instance = f.create(store, body), preview = await instance.service.planCommand({ command: '/scry-workflow run bind candidate inputs', workspace: f.source, orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await instance.service.approve(approval)
  return { ...f, ...instance, preview, approval, store }
}

const state = async (f: Awaited<ReturnType<typeof candidate>>) => {
  const record = (await f.store.load(f.preview.workflowId))!
  return { record, input: record.systemIntents!.find(intent => intent.kind === 'check')!, output: record.systemOutcomes!.find(outcome => outcome.check)! }
}

describe('Check inputs bind to a committed materialization, not Agent assertions', () => {
  it('persists the actual edited candidate association before native launch and consumes it through field dataflow', async () => {
    const f = await candidate(), save = f.store.save.bind(f.store), execute = checks.executeWorkflowCheck
    let committed = false
    vi.spyOn(f.store, 'save').mockImplementation(async record => {
      await save(record)
      if (record.systemIntents?.some(intent => intent.inputMaterialization)) committed = true
    })
    vi.spyOn(checks, 'executeWorkflowCheck').mockImplementation((...args) => {
      expect(committed).toBe(true)
      return execute(...args)
    })
    const progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 1 })
    const { record, input, output } = await state(f), binding = input.inputMaterialization!
    expect(binding).toMatchObject({ state: 'available', source: 'main_ledger', candidate: record.systemOutcomes![0].replica, materialized: record.systemOutcomes![1].replica, preparationStepId: record.systemIntents![1].stepId })
    expect(binding.materialized.inputHash).not.toBe(binding.candidate!.inputHash)
    expect(binding.materialized.inputHash).toBe(input.inputSnapshot!.inputHash)
    expect(output.check!.inputs!.materialization).toEqual(binding)
    expect(JSON.parse(progress.finalReport!)).toEqual(binding)
    expect(output.check).toMatchObject({ state: 'passed', inputs: { changes: { state: 'available', count: 1 } } })
    expect(output.check!.inputs!.changes.after!.inputHash).not.toBe(binding.materialized.inputHash)
    const receipt = await f.host.replicas.resolve(binding.materialized)
    expect(() => f.host.replicas.assertSource(receipt, binding.candidate!)).not.toThrow()
    expect(() => f.host.replicas.assertSource(receipt, binding.materialized)).toThrow('工作副本身份')
    expect(await readFile(join(receipt.directory, 'candidate-output'), 'utf8')).toBe('actual changed input')
    expect(await readFile(join(receipt.directory, 'native-count'), 'utf8')).toBe('1')
    await expect(readFile(join(f.source, 'candidate-output'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.slots.active).toBe(0)
  })

  it('keeps actual pass but marks attribution unavailable after the verification copy changes', async () => {
    const f = await candidate(undefined, true)
    const progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 2 })
    const { input, output } = await state(f)
    expect(input.inputSnapshot!.inputHash).not.toBe(input.inputMaterialization!.materialized.inputHash)
    expect(output.check!.state).toBe('passed')
    expect(JSON.parse(progress.finalReport!)).toMatchObject({ state: 'unavailable', source: 'main_ledger', reason: expect.any(String) })
    expect(input.inputMaterialization!.candidate).toBeDefined()
  })

  it('does not launch when the origin/hash checkpoint fails and retains the attempt budget', async () => {
    const f = await candidate(), save = f.store.save.bind(f.store), native = vi.spyOn(checks, 'executeWorkflowCheck')
    let rejected = false
    vi.spyOn(f.store, 'save').mockImplementation(async record => {
      if (!rejected && record.systemIntents?.some(intent => intent.inputMaterialization)) { rejected = true; throw new Error('binding checkpoint failed') }
      await save(record)
    })
    expect(await f.service.start(f.preview.workflowId, f.approval)).toMatchObject({ state: 'failed', dispatchAttempts: 1 })
    expect(native).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledTimes(1)
    const input = (await f.store.load(f.preview.workflowId))!.systemIntents!.at(-1)!
    expect(input.inputMaterialization).toBeDefined()
    expect(f.slots.active).toBe(0)
  })

  it('reuses the historical version after parent failure and later candidate changes, with no new native/Agent', async () => {
    const f = await candidate()
    f.store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('binding parent checkpoint cut')
    f.store.cut = false
    const { record, input } = await state(f), reference = input.inputMaterialization!.materialized
    const candidateReceipt = await f.host.replicas.resolve(input.inputMaterialization!.candidate!)
    await writeFile(join(candidateReceipt.directory, 'candidate-output'), 'a later candidate version')
    const cold = f.create(), native = vi.spyOn(cold.host, 'execute')
    await cold.service.approve(f.approval)
    expect((await cold.service.resume(f.preview.workflowId, f.approval, 'resume-bound')).progress).toMatchObject({ state: 'completed', dispatchAttempts: 1, finalReport: JSON.stringify(input.inputMaterialization) })
    expect(native).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect((await f.store.load(f.preview.workflowId))!.systemIntents).toEqual(record.systemIntents)
    const verification = await f.host.replicas.resolve(reference)
    expect(await readFile(join(verification.directory, 'candidate-output'), 'utf8')).toBe('actual changed input')
    expect(await readFile(join(verification.directory, 'native-count'), 'utf8')).toBe('1')
  })

  it('rejects missing/foreign/rewritten origin facts and missing origin output without replay', async () => {
    const f = await candidate()
    f.store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('binding parent checkpoint cut')
    f.store.cut = false
    const { record } = await state(f)
    const corruptions = [
      (r: typeof record) => { Object.assign(r.systemIntents![2], { inputMaterialization: null }) },
      (r: typeof record) => { delete r.systemIntents![2].inputMaterialization },
      (r: typeof record) => { delete r.systemOutcomes![2].check!.inputs!.materialization },
      (r: typeof record) => { r.systemIntents![2].inputMaterialization!.preparationStepId = 'different-origin' },
      (r: typeof record) => { r.systemIntents![2].inputMaterialization!.candidate!.workflowId = 'different-root' },
      (r: typeof record) => { r.systemOutcomes!.splice(1, 1) },
      (r: typeof record) => {
        delete r.systemIntents![1].replica
        delete r.systemIntents![2].inputMaterialization!.candidate
        delete r.systemOutcomes![2].check!.inputs!.materialization!.candidate
      }
    ]
    for (const corrupt of corruptions) {
      const changed = structuredClone(record)
      corrupt(changed)
      expect(() => validateWorkflowSystemLedger(changed)).toThrow('系统步骤账本')
    }
    const cold = f.create(), execute = vi.spyOn(cold.host, 'execute'), load = f.store.loadValue.bind(f.store)
    const missing = record.systemOutcomes![1].resultRef!.key
    vi.spyOn(f.store, 'loadValue').mockImplementation((id, ref) => ref.key === missing ? Promise.reject(new Error('missing materialization output')) : load(id, ref))
    await cold.service.approve(f.approval)
    await expect(cold.service.resume(f.preview.workflowId, f.approval, 'missing-origin')).rejects.toThrow('missing materialization output')
    expect(execute).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
})
