import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowControlFrame } from '../shared/workflow'
import { MemoryWorkflowStore } from './workflow-store'
import { fixture } from './workflow-system.fixture'
import { validateWorkflowBody } from './workflow-program'
import { WorkflowProtectedSurface, validateWorkflowProtectedPaths } from './workflow-verification-surface'
import { captureWorkflowInputs } from './workflow-input-snapshot'
import { workflowVerificationCopy as copy } from '../shared/constants/copy'

class SurfaceStore extends MemoryWorkflowStore {
  cut = false
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, expected: number) {
    if (this.cut && frame.nodeId === 'root' && frame.cursor === 8) throw new Error('surface parent checkpoint cut')
    return super.saveFrame(frame, expected)
  }
}
const ref = (name: string) => ({ kind: 'ref' as const, name })
type Mutation = 'content' | 'mode' | 'remove' | 'add' | 'prefix' | 'none'
async function suite(options: { mutation?: Mutation; nativeTamper?: boolean; changedPolicy?: boolean; absent?: boolean; link?: boolean } = {}) {
  const store = new SurfaceStore(), f = await fixture(0, store)
  await mkdir(join(f.source, 'tests'))
  await writeFile(join(f.source, 'tests/a.ts'), 'protected test')
  await writeFile(join(f.source, 'state.json'), 'before')
  if (options.link) await symlink('../state.json', join(f.source, 'tests/link'))
  await writeFile(join(f.source, 'check.cjs'), `const fs=require('node:fs'); if(${Boolean(options.nativeTamper)} && fs.readFileSync('state.json','utf8')==='after')fs.writeFileSync('tests/a.ts','native rewrite');`)
  f.execute.mockImplementation(request => ({ result: (async () => {
    await writeFile(join(request.workspace, 'state.json'), 'after')
    const target = join(request.workspace, 'tests/a.ts')
    if (options.mutation === 'content') await writeFile(target, 'weakened test')
    if (options.mutation === 'mode') await chmod(target, 0o755)
    if (options.mutation === 'remove') await rm(target)
    if (options.mutation === 'add') await writeFile(join(request.workspace, 'tests/new.ts'), 'new test')
    if (options.mutation === 'prefix') await writeFile(join(request.workspace, 'tests2'), 'unprotected neighbor')
    return { runId: 'surface-' + request.attemptId, status: 'completed', output: 'done', settled: true }
  })(), stop: () => true }))
  const check = (prefix: string): WorkflowBlock[] => [
    { kind: 'replica', blockId: prefix + 'copy', source: ref('candidate') },
    { kind: 'check', blockId: prefix, replica: ref(prefix + 'copy'), check: { argv: [process.execPath, 'check.cjs'], cwd: '.', parser: 'exit_code', timeoutMs: 2000 } }
  ]
  const paths = options.absent ? ['absent'] : ['check.cjs', 'tests']
  const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'candidate' }, ...check('before'),
    { kind: 'verification', blockId: 'baseline', required: { test: { check: 'before', result: ref('before') } }, protectedPaths: paths },
    { kind: 'call', blockId: 'edit', role: 'orchestrator', prompt: 'edit', replica: ref('candidate') }, ...check('after'),
    { kind: 'verification', blockId: 'current', required: { test: { check: 'after', result: ref('after') } }, baseline: ref('baseline'), protectedPaths: options.changedPolicy ? ['check.cjs'] : paths },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'current' } }
  ] }
  const instance = f.create(store, body), preview = await instance.service.planCommand({ command: '/scry-workflow run protected checks', workspace: f.source, orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await instance.service.approve(approval)
  return { ...f, ...instance, store, preview, approval, body }
}

describe('Declared protected verification surface, not executed test coverage', () => {
  it('preserves only declared inputs across changed candidate versions and both native intervals', async () => {
    const f = await suite(), progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress).toMatchObject({ state: 'completed', dispatchAttempts: 1 })
    const value = JSON.parse(progress.finalReport!)
    expect(value).toMatchObject({ state: 'available', passed: true,
      protectedSurface: { state: 'available', source: 'main_manifest', protectedPaths: ['check.cjs', 'tests'], entryCount: 3, observations: 4 },
      comparison: { state: 'available', progress: { state: 'unavailable' } } })
    const record = (await f.store.load(f.preview.workflowId))!
    const before = record.systemIntents!.find(intent => intent.nodeId === 'before')!
    expect(value.protectedSurface.referenceStepId).toBe(before.stepId)
    expect(value.protectedSurface.referenceInputHash).toBe(before.inputSnapshot!.inputHash)
    expect(value.inputHash).not.toBe(value.protectedSurface.referenceInputHash)
    expect(await readFile(join(f.source, 'state.json'), 'utf8')).toBe('before')
    expect(f.slots.active).toBe(0)
  })

  it.each<Mutation>(['content', 'mode', 'remove', 'add'])('does not certify changed protected %s even when both commands pass', async mutation => {
    const f = await suite({ mutation }), progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress.state).toBe('completed')
    expect(JSON.parse(progress.finalReport!)).toMatchObject({ passed: true,
      protectedSurface: { state: 'unavailable', reason: expect.any(String) }, comparison: { progress: { state: 'unavailable' } } })
  })

  it('includes after evidence, not only equal before snapshots', async () => {
    const f = await suite({ nativeTamper: true }), progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(JSON.parse(progress.finalReport!)).toMatchObject({ passed: true, protectedSurface: { state: 'unavailable', reason: copy.surfaceChanged } })
  })

  it('matches path segments rather than ambiguous string prefixes', async () => {
    const f = await suite({ mutation: 'prefix' }), progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(JSON.parse(progress.finalReport!).protectedSurface.state).toBe('available')
  })

  it.each([{ absent: true }, { link: true }, { changedPolicy: true }])('keeps missing paths, unresolved link closure and changed frozen policy unavailable: %j', async options => {
    const f = await suite(options), progress = await f.service.start(f.preview.workflowId, f.approval)
    expect(progress.state).toBe('completed')
    expect(JSON.parse(progress.finalReport!)).toMatchObject({ passed: true, protectedSurface: { state: 'unavailable', reason: expect.any(String) } })
    if (options.changedPolicy) expect(JSON.parse(progress.finalReport!).comparison.state).toBe('unavailable')
  })

  it('cold continuation reuses committed facts without replay, and missing old parts block it', async () => {
    const f = await suite(); f.store.cut = true
    await expect(f.service.start(f.preview.workflowId, f.approval)).rejects.toThrow('surface parent checkpoint cut')
    f.store.cut = false
    const record = (await f.store.load(f.preview.workflowId))!, candidate = record.systemOutcomes!.find(outcome => outcome.replica)!.replica!
    await writeFile(join((await f.host.replicas.resolve(candidate)).directory, 'tests/a.ts'), 'later candidate mutation')
    const cold = f.create(), execute = vi.spyOn(cold.host, 'execute')
    await cold.service.approve(f.approval)
    const resumed = await cold.service.resume(f.preview.workflowId, f.approval, 'surface-cold-resume')
    expect(resumed.progress?.state).toBe('completed')
    expect(JSON.parse(resumed.progress!.finalReport!).protectedSurface.state).toBe('available')
    expect(execute).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledTimes(1)
    const broken = await suite(); broken.store.cut = true
    await expect(broken.service.start(broken.preview.workflowId, broken.approval)).rejects.toThrow('surface parent checkpoint cut')
    broken.store.cut = false
    const old = (await broken.store.load(broken.preview.workflowId))!, before = old.systemIntents!.find(intent => intent.nodeId === 'before')!
    const header = await broken.store.loadValue(broken.preview.workflowId, before.inputSnapshot!.reference)
    if (header.state !== 'known' || !header.value || typeof header.value !== 'object' || Array.isArray(header.value) || !Array.isArray(header.value.parts)) throw new Error('missing fixture header')
    const part = header.value.parts[0] as { key: string }
    const load = broken.store.loadValue.bind(broken.store)
    vi.spyOn(broken.store, 'loadValue').mockImplementation((id, reference) => reference.key === part.key ? Promise.reject(new Error('missing protected source part')) : load(id, reference))
    const missing = broken.create(), replay = vi.spyOn(missing.host, 'execute')
    await missing.service.approve(broken.approval)
    await expect(missing.service.resume(broken.preview.workflowId, broken.approval, 'surface-missing-part')).rejects.toThrow('missing protected source part')
    expect(replay).not.toHaveBeenCalled()
  })

  it('rejects invalid, overlapping, ignored or unbounded selectors at compilation', () => {
    const block = (paths: unknown) => ({ kind: 'verification', blockId: 'verify', required: { test: { check: 'check', result: ref('check') } }, protectedPaths: paths })
    for (const paths of [[], ['.'], ['/tmp'], ['a/../b'], ['tests/'], ['tests/*'], ['.scry'], ['tests', 'tests2', 'tests/a'], ['x', 'x'], Array.from({ length: 257 }, (_, i) => 'p' + i), ['x'.repeat(1025)]]) {
      expect(() => validateWorkflowBody(block(paths), new Set(['orchestrator']))).toThrow(copy.protectedPaths)
    }
    expect(validateWorkflowProtectedPaths(['tests', 'a file'])).toEqual(['a file', 'tests'])
  })

  it('bounds unique manifest work, reuses equal projections but still counts each verified observation', async () => {
    const f = await fixture(), captured = await captureWorkflowInputs(f.source, () => false)
    const observer = new WorkflowProtectedSurface(['check.cjs'])
    const snapshot = { ...captured.info, reference: {} } as Parameters<typeof observer.observe>[2]
    observer.observe('first', 'before', snapshot, [captured.text])
    observer.observe('same', 'after', snapshot, [captured.text])
    expect(observer.result('first')).toMatchObject({ state: 'available', observations: 2 })
    // Synthetic but individually valid <8 MiB / <32768-entry manifests.
    // Distinct unprotected versions still consume the aggregate proof budget.
    const entries = [...captured.entries, ...Array.from({ length: 6000 }, (_, i) => ({ path: 'f'.repeat(200) + i,
      hash: createHash('sha256').update('').digest('hex'), mode: 0o644, bytes: 0, kind: 'file' as const }))]
    let bytes = captured.info.manifestBytes
    for (let index = 0; bytes <= 16 * 1024 * 1024; index++) {
      entries[entries.length - 1].mode = 0o600 + index
      const text = JSON.stringify(entries), manifestBytes = Buffer.byteLength(text)
      expect(manifestBytes).toBeLessThan(8 * 1024 * 1024)
      observer.observe('version-' + index, 'after', { ...snapshot, entryCount: entries.length,
        inputHash: createHash('sha256').update(text).digest('hex'), manifestBytes }, [text])
      bytes += manifestBytes
    }
    expect(observer.result('first')).toEqual({ state: 'unavailable', source: 'main_manifest', reason: copy.surfaceLimit })
  })
})
