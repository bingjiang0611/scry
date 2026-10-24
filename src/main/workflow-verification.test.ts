import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowControlFrame, WorkflowVerificationBlock } from '../shared/workflow'
import { MemoryWorkflowStore } from './workflow-store'
import { fixture } from './workflow-system.fixture'
import { validateWorkflowBody } from './workflow-program'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import { normalizeWorkflowDiagnostics, compareWorkflowDiagnostics } from './workflow-verification-diagnostics'

class VerificationStore extends MemoryWorkflowStore {
  cut = false
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, expected: number) {
    if (this.cut && frame.nodeId === 'root' && frame.cursor === 12) throw new Error('verification parent checkpoint cut')
    return super.saveFrame(frame, expected)
  }
}
const ref = (name: string) => ({ kind: 'ref' as const, name })
async function suite(options: { missing?: boolean; mismatch?: boolean; noParser?: boolean; changedContract?: boolean } = {}) {
  const store = new VerificationStore(), f = await fixture(0, store)
  await writeFile(join(f.source, 'state.json'), 'before')
  await writeFile(join(f.source, 'check.cjs'), `const fs = require('node:fs'); const after = fs.readFileSync('state.json','utf8') === 'after'; fs.writeFileSync('native-count',String(Number(fs.existsSync('native-count') ? fs.readFileSync('native-count','utf8') : 0)+1)); if(process.argv[2] === 'types') { console.log('src/a.ts('+(after?9:2)+',3): error TS100: retained'); if(after) console.log('src/a.ts(10,3): error TS200: added'); process.exitCode=1 } else if(after) { console.log('tests/a.ts(1,1): error TS300: test failed'); process.exitCode=1 }`)
  f.execute.mockImplementation(request => ({ result: (async () => {
    await writeFile(join(request.workspace, 'state.json'), 'after')
    return { runId: 'verify-' + request.attemptId, status: 'completed', output: 'done', settled: true }
  })(), stop: () => true }))
  const checks = (prefix: string): WorkflowBlock[] => ['types', 'tests'].flatMap(key => [
    { kind: 'replica', blockId: prefix + key + 'copy', source: ref('candidate') },
    { kind: 'check', blockId: prefix + key, replica: ref(prefix + key + 'copy'), check: { argv: [process.execPath, 'check.cjs', key], cwd: '.', parser: options.noParser || (options.changedContract && prefix === 'after') ? 'exit_code' : 'typescript', timeoutMs: 2000 } }
  ])
  const required = (prefix: string): WorkflowVerificationBlock['required'] => Object.fromEntries(['types', 'tests'].map(key => [key, { check: prefix + key, result: ref(prefix + key) }]))
  const current = required('after')
  if (options.missing) current.tests.result = { kind: 'literal', value: { passed: true, state: 'passed', stepId: 'invented' } }
  if (options.mismatch) current.tests.result = ref('beforetests')
  const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'candidate' }, ...checks('before'),
    { kind: 'verification', blockId: 'baseline', required: required('before') },
    { kind: 'call', blockId: 'edit', role: 'orchestrator', prompt: 'edit', replica: ref('candidate') }, ...checks('after'),
    { kind: 'verification', blockId: 'current', required: current, baseline: ref('baseline') },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'current' } }
  ] }
  const instance = f.create(store, body), preview = await instance.service.planCommand({ command: '/scry-workflow run required checks', workspace: f.source, orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await instance.service.approve(approval)
  return { ...f, ...instance, preview, approval, store, body }
}

describe('Canonical required verification and diagnostic comparison', () => {
  it('joins actual frozen checks, preserves shifted errors and reports regression without claiming trusted progress', async () => {
    const f = await suite(), progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 1 })
    const value = JSON.parse(progress.finalReport!)
    expect(value).toMatchObject({ state: 'available', source: 'main_ledger', passed: false,
      comparison: { state: 'available', regressedChecks: ['tests'], recoveredChecks: [], progress: { state: 'unavailable' },
        diagnostics: { state: 'available', removed: [], added: [
          { check: 'tests', file: 'tests/a.ts', code: 'TS300', count: 1 }, { check: 'types', file: 'src/a.ts', code: 'TS200', count: 1 }
        ] } } })
    expect(value.diagnostics.items).toHaveLength(3)
    expect(value.inputHash).not.toBe(value.candidate.inputHash)
    expect(value.diagnostics.source).toBe('derived')
    expect(value.comparison.diagnostics.source).toBe('derived')
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.systemIntents).toHaveLength(11)
    expect(record.systemIntents!.filter(intent => intent.kind === 'verification')).toHaveLength(2)
    for (const outcome of record.systemOutcomes!.filter(outcome => outcome.check)) {
      const directory = (await f.host.replicas.resolve(outcome.replica!)).directory
      expect(await readFile(join(directory, 'native-count'), 'utf8')).toBe('1')
    }
    expect(await readFile(join(f.source, 'state.json'), 'utf8')).toBe('before')
    expect(f.slots.active).toBe(0)
  })

  it.each([{ missing: true }, { mismatch: true }])('does not certify invented or differently-versioned checks: %j', async options => {
    const f = await suite(options), progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress.state).toBe('completed')
    const value = JSON.parse(progress.finalReport!)
    expect(value).toMatchObject({ state: 'unavailable', source: 'main_ledger', reason: expect.any(String) })
    expect(value).not.toHaveProperty('passed')
  })

  it('refuses cross-contract comparison even when the required keys are identical', async () => {
    const f = await suite({ changedContract: true }), progress = await f.service.start(f.preview.workflowId, f.approval)
    const value = JSON.parse(progress.finalReport!)
    expect(value).toMatchObject({ state: 'available', passed: false, comparison: { state: 'unavailable', progress: { state: 'unavailable' } } })
    expect(value.comparison).not.toHaveProperty('regressedChecks')
  })

  it('keeps known check regression separate from unavailable diagnostics', async () => {
    const f = await suite({ noParser: true }), progress = await f.service.start(f.preview.workflowId, f.approval)
    const value = JSON.parse(progress.finalReport!)
    expect(value).toMatchObject({ state: 'available', passed: false, diagnostics: { state: 'unavailable' }, comparison: { state: 'available', regressedChecks: ['tests'], diagnostics: { state: 'unavailable' }, progress: { state: 'unavailable' } } })
    expect(value.diagnostics).not.toHaveProperty('items')
  })

  it('reuses persisted verification after a cut without new native work and rejects an extra required selector', async () => {
    const f = await suite()
    f.store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('verification parent checkpoint cut')
    f.store.cut = false
    const record = (await f.store.load(f.preview.workflowId))!
    const changed = structuredClone(record), current = changed.systemIntents!.find(intent => intent.nodeId === 'current')!
    current.verificationInputs!.checks.extra = 'invented'
    expect(() => validateWorkflowSystemLedger(changed)).toThrow()
    const cold = f.create(), execute = vi.spyOn(cold.host, 'execute')
    await cold.service.approve(f.approval)
    expect((await cold.service.resume(f.preview.workflowId, f.approval, 'resume-verification')).progress).toMatchObject({ state: 'completed', dispatchAttempts: 1 })
    expect(execute).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect((await f.store.load(f.preview.workflowId))!.systemIntents).toEqual(record.systemIntents)
  })

  it.each(['selection', 'source'] as const)('rejects missing source or a valid-shape rewritten selector without replay: %s', async corruption => {
    const f = await suite()
    f.store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('verification parent checkpoint cut')
    f.store.cut = false
    const record = (await f.store.load(f.preview.workflowId))!
    if (corruption === 'selection') {
      record.systemIntents!.find(intent => intent.nodeId === 'current')!.verificationInputs!.checks.tests = record.systemIntents!.find(intent => intent.nodeId === 'beforetests')!.stepId
      await f.store.save(record)
    } else {
      const missing = record.systemOutcomes!.find(outcome => outcome.check)!.check!.stdoutRef.key, load = f.store.loadValue.bind(f.store)
      vi.spyOn(f.store, 'loadValue').mockImplementation((id, reference) => reference.key === missing ? Promise.reject(new Error('missing required check source')) : load(id, reference))
    }
    const cold = f.create(), noReplay = vi.spyOn(cold.host, 'execute')
    await cold.service.approve(f.approval)
    await expect(cold.service.resume(f.preview.workflowId, f.approval, 'reject-required-source')).rejects.toThrow(corruption === 'source' ? 'missing required check source' : /必需检查|系统步骤/)
    expect(noReplay).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('rejects empty requirements and a required node that is not a check at compilation', async () => {
    const f = await suite(), body = structuredClone(f.body) as Extract<WorkflowBlock, { kind: 'sequence' }>
    const current = body.blocks.find(block => block.kind === 'verification')! as Extract<WorkflowBlock, { kind: 'verification' }>
    current.required = {}
    expect(() => validateWorkflowBody(body, new Set(['orchestrator']))).toThrow()
    current.required = { types: { check: 'edit', result: ref('beforetypes') } }
    expect(() => validateWorkflowBody(body, new Set(['orchestrator']))).toThrow()
    current.required = Object.fromEntries(Array.from({ length: 65 }, (_, index) => ['check_' + index, { check: 'beforetypes', result: ref('beforetypes') }]))
    expect(() => validateWorkflowBody(body, new Set(['orchestrator']))).toThrow()
  })

  it('normalizes roots/cwd and location shifts without merging different occurrences or accepting outside paths', () => {
    const diagnostic = { file: '../src/a.ts', line: 2, column: 1, code: 'TS1', message: 'two  spaces\r\nnext' }
    const before = normalizeWorkflowDiagnostics('types', [diagnostic, diagnostic, { ...diagnostic, line: 3 }], '/owned/first', 'pkg')!
    const after = normalizeWorkflowDiagnostics('types', [{ ...diagnostic, file: '/owned/second/src/a.ts', line: 9 }], '/owned/second', '.')!
    expect(before).toEqual([{ check: 'types', file: 'src/a.ts', code: 'TS1', message: 'two  spaces\nnext', count: 2 }])
    expect(compareWorkflowDiagnostics(before, after)).toEqual({ added: [], removed: [{ ...before[0], count: 1 }] })
    expect(normalizeWorkflowDiagnostics('types', [{ ...diagnostic, file: '/outside/a.ts' }], '/owned/first', '.')).toBeUndefined()
    expect(normalizeWorkflowDiagnostics('types', Array.from({ length: 4097 }, () => diagnostic), '/owned/first', 'pkg')).toBeUndefined()
  })
})
