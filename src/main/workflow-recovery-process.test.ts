import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowExpression } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { workflowFrameId } from './workflow-frames'
import { WorkflowRunner } from './workflow-runner'

const roots: string[] = [], children: Array<{ child: ChildProcess; closed: Promise<{ code: number | null; signal: string | null }> }> = []
let bundle: Promise<{ root: string; path: string }> | undefined
function engine() {
  return bundle ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-recovery-engine-')), path = join(root, 'engine.mjs')
    await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), '../../scripts/fixtures/workflow-recovery-process.ts')], outfile: path, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    return { root, path }
  })()
}
afterEach(async context => {
  for (const { child, closed } of children.splice(0)) {
    if (child.connected) child.send('terminate')
    await closed
  }
  const finishedRoots = roots.splice(0)
  if (context.task.result?.state === 'fail') console.warn('Retained failed process fixture:', finishedRoots)
  else await Promise.all(finishedRoots.map(root => rm(root, { recursive: true, force: true })))
})
afterAll(async () => { if (bundle) await rm((await bundle).root, { recursive: true, force: true }) })
const literal = (value: string): WorkflowExpression => ({ kind: 'literal', value })
const ref = (name: string): WorkflowExpression => ({ kind: 'ref', name })
const field = (name: string, key: string): WorkflowExpression => ({ kind: 'field', source: ref(name), path: [key] })
const sequence: WorkflowBlock[] = [
  { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first' },
  { kind: 'call', blockId: 'second', role: 'worker', prompt: 'second', inputRefs: [{ nodeId: 'first' }] },
  { kind: 'return', blockId: 'report', ref: { nodeId: 'second' } }
]
async function setup(blocks = sequence) {
  const root = await mkdtemp(join(tmpdir(), 'scry recovery process ')); roots.push(root)
  const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: 'workflow-' + randomUUID(), programRevision: 'pending', userGoal: 'process recovery', workspace: root, roles: [role], body: { kind: 'sequence', blockId: 'root', blocks } })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  const preview = makePlanPreview(program, [], role)
  await writeFile(join(root, 'preview.json'), JSON.stringify(preview))
  return { root, preview, store: new FileWorkflowStore(root) }
}
async function launch(root: string, mode: string) {
  const { path } = await engine()
  const sandbox = process.platform === 'darwin'
  if (sandbox) await access('/usr/bin/sandbox-exec')
  const child = spawn(sandbox ? '/usr/bin/sandbox-exec' : process.execPath, sandbox ? ['-p', '(version 1)(allow default)(deny network*)', process.execPath, path, root, mode] : [path, root, mode], { env: { HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', text => { stderr += text })
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  children.push({ child, closed })
  const checkpoint = mode === 'live' ? new Promise<void>((resolve, reject) => {
    child.once('message', message => (message as { type?: string }).type === 'checkpoint' ? resolve() : reject(new Error('unexpected checkpoint')))
    child.once('exit', code => reject(new Error('early exit: ' + code + ': ' + stderr)))
  }) : undefined
  return { child, closed, checkpoint, stderr: () => stderr }
}
async function run(root: string, mode: string, code: number) {
  const process = await launch(root, mode), result = await process.closed
  expect(result, process.stderr()).toEqual({ code, signal: null })
}
async function effects(root: string): Promise<Array<{ node: string; taskId: string; attemptId: string; prompt: string; pid: number }>> {
  return (await readFile(join(root, 'effects.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

describe('production Runner across distinct controller processes (local CLI, no account)', () => {
  it('continues after a hard controller exit without repeating a completed native child', async () => {
    const f = await setup()
    await run(f.root, 'crash', 73)
    const before = (await f.store.load(f.preview.workflowId))!
    expect(before.execution?.owner.state).toBe('active')
    expect(before.progress.dispatchAttempts).toBe(1)
    expect((await effects(f.root)).map(row => row.node)).toEqual(['first'])
    const frameId = workflowFrameId('root', ['revision:' + f.preview.programRevision]), frame = await f.store.loadFrame(f.preview.workflowId, frameId)
    await run(f.root, 'resume', 0)
    const after = (await f.store.load(f.preview.workflowId))!
    expect(after.execution?.owner.pid).not.toBe(before.execution?.owner.pid)
    expect(after.progress).toMatchObject({ state: 'completed', dispatchAttempts: 2, finalReport: 'second-result' })
    expect((await effects(f.root)).map(row => row.node)).toEqual(['first', 'second'])
    expect(await f.store.loadFrame(f.preview.workflowId, frameId)).toEqual(frame)
    await run(f.root, 'resume', 0)
    expect(await effects(f.root)).toHaveLength(2)
  })

  it('retains the earlier committed result when a second controller exits after only entering its frame', async () => {
    // Both dependent Native calls are already committed. Recovery must reuse
    // their chain with zero new effects; the first scene tests new admission.
    const f = await setup()
    await run(f.root, 'crash-two', 73)
    const firstId = workflowFrameId('first', ['revision:' + f.preview.programRevision]), before = (await f.store.loadFrame(f.preview.workflowId, firstId))!
    await run(f.root, 'reenter', 77)
    await run(f.root, 'resume', 0)
    const record = (await f.store.load(f.preview.workflowId))!, segment = record.execution!.segments.at(-1)!
    expect(record.execution?.segments).toHaveLength(3)
    expect(record.progress).toMatchObject({ state: 'completed', dispatchAttempts: 2, finalReport: 'second-result' })
    expect((await effects(f.root)).map(row => row.node)).toEqual(['first', 'second'])
    const recovered = await f.store.loadFrame(f.preview.workflowId, workflowFrameId('first', ['revision:' + f.preview.programRevision], segment.generationId))
    expect(recovered?.resultRef).toEqual(before.resultRef)
  })

  it('refuses a live owner and allows continuation only after its owned IPC shutdown closes', async () => {
    const f = await setup(), owner = await launch(f.root, 'live')
    await owner.checkpoint
    // The Vitest caller is already a different OS process from the live owner.
    // A third cold bootstrap adds no owner-admission evidence here.
    const execute = vi.fn(), contender = new WorkflowRunner({ store: new FileWorkflowStore(f.root), execute })
    const approval = { workflowId: f.preview.workflowId, programRevision: f.preview.programRevision, approvedAt: 1 }
    contender.approve(f.preview, approval)
    await expect(contender.resume(f.preview, approval, 'live-owner-resume')).rejects.toThrow('控制器')
    expect(execute).not.toHaveBeenCalled()
    expect(await effects(f.root)).toHaveLength(1)
    owner.child.send('terminate')
    expect(await owner.closed).toEqual({ code: 75, signal: null })
    await run(f.root, 'resume', 0)
    expect((await effects(f.root)).map(row => row.node)).toEqual(['first', 'second'])
  })

  it('does not infer not-attempted from a dead controller with an outcome-less durable intent', async () => {
    const f = await setup()
    await run(f.root, 'intent', 74)
    await run(f.root, 'resume', 2)
    expect(JSON.parse(await readFile(join(f.root, 'result.json'), 'utf8')).error).toContain('仍未知')
    await expect(readFile(join(f.root, 'effects.jsonl'))).rejects.toHaveProperty('code', 'ENOENT')
    const record = (await f.store.load(f.preview.workflowId))!
    expect(record.intents).toHaveLength(1)
    expect(record.outcomes).toHaveLength(0)
    expect(record.progress.dispatchAttempts).toBe(1)
    expect(record.execution?.segments).toHaveLength(1)
  })

  it('restores carry, initial/best, committed history and the no-progress counter before round two', async () => {
    const f = await setup([
      { kind: 'loop', blockId: 'improve', initial: { candidate: literal('seed') }, stateSchema: { candidate: { type: 'string' } }, invariants: { rubric: literal('frozen') }, best: 'candidate', outcome: 'qualityOutcome', maxIterations: 10,
        body: { kind: 'call', blockId: 'revise', role: 'worker', prompt: 'revise', inputRefs: [{ nodeId: 'candidate' }], outputSchema: { type: 'object', properties: { candidate: { type: 'string' }, done: { type: 'boolean' }, feedback: { type: 'string' }, improved: { type: 'boolean' } }, required: ['candidate', 'done', 'feedback', 'improved'] } },
        until: field('revise', 'done'), carry: { candidate: field('revise', 'candidate') }, result: ref('candidate'), progress: { baseline: literal('repeat'), key: field('revise', 'feedback'), improved: field('revise', 'improved') }, policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'report_partial' } },
      { kind: 'call', blockId: 'summary', role: 'worker', prompt: 'summary', inputRefs: [{ nodeId: 'improve' }, { nodeId: 'qualityOutcome' }] },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'summary' } }
    ])
    await run(f.root, 'loop', 76)
    const frameId = workflowFrameId('improve', ['revision:' + f.preview.programRevision]), before = await f.store.loadFrame(f.preview.workflowId, frameId)
    expect(before?.loop).toMatchObject({ iteration: 2, stage: 'ready', noProgress: 1 })
    await run(f.root, 'resume', 0)
    const rows = await effects(f.root)
    expect(rows.map(row => row.node)).toEqual(['revise', 'revise', 'summary'])
    expect(rows[1].prompt).toContain('candidate-1')
    const record = (await f.store.load(f.preview.workflowId))!, segment = record.execution!.segments.at(-1)!
    const frame = (await f.store.loadFrame(f.preview.workflowId, workflowFrameId('improve', ['revision:' + f.preview.programRevision], segment.generationId)))!
    expect(frame.loop).toMatchObject({ iteration: 2, noProgress: 2, reasons: ['no_progress'] })
    expect(frame.loop?.iterations).toHaveLength(2)
    expect(await f.store.loadValue(f.preview.workflowId, frame.loop!.initialStateRefs.candidate)).toMatchObject({ value: 'seed' })
    expect(await f.store.loadValue(f.preview.workflowId, frame.loop!.bestRef!)).toMatchObject({ value: 'candidate-2' })
    expect(record.progress).toMatchObject({ state: 'blocked', dispatchAttempts: 3, finalReport: 'summary-result' })
    expect(await f.store.loadFrame(f.preview.workflowId, frameId)).toEqual(before)
  })
})
