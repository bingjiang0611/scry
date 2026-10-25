import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
// Typecheck the executable child without running its top-level entry in Vitest.
import type {} from '../../scripts/fixtures/workflow-recovery-process'
import { afterAll, afterEach, expect } from 'vitest'
import type { WorkflowBlock, WorkflowExpression } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'

type ParentPhase = { event: string; ms: number; pid?: number; code?: number | null; signal?: string | null; exitCode?: number | null; signalCode?: string | null; streams?: string[] }
type ProcessRun = { root: string; mode: string; started: number; child: ChildProcess; closed: Promise<{ code: number | null; signal: string | null }>; phases: ParentPhase[]; stderr: () => string }
export const roots: string[] = []
const children: ProcessRun[] = []
const diagnosticTextLimit = 16 * 1024
const diagnosticPhaseLimit = 128
function bounded(text: string) { return text.length > diagnosticTextLimit ? text.slice(0, diagnosticTextLimit) + '\n[truncated]' : text }
function fixturePhases(stderr: string) {
  return stderr.split('\n').flatMap(line => {
    if (!line) return []
    try {
      const phase = JSON.parse(line) as { event?: unknown; ms?: unknown }
      return typeof phase.event === 'string' && typeof phase.ms === 'number' ? [phase] : []
    } catch { return [] }
  }).slice(0, diagnosticPhaseLimit + 1)
}
let bundle: Promise<{ root: string; path: string }> | undefined
function engine() {
  return bundle ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-recovery-engine-')), path = join(root, 'engine.mjs')
    await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), '../../scripts/fixtures/workflow-recovery-process.ts')], outfile: path, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    return { root, path }
  })()
}
afterEach(async context => {
  const runs = children.splice(0), finishedRoots = roots.splice(0)
  const failed = context.task.result?.state === 'fail'
  for (const run of runs) run.phases.push({ event: failed ? 'failure_cleanup_start' : 'cleanup_start', ms: Math.round(performance.now() - run.started), exitCode: run.child.exitCode, signalCode: run.child.signalCode })
  const saveDiagnostics = async (stage: 'before_cleanup' | 'closed') => {
    await Promise.all(finishedRoots.map(async root => {
      const diagnostic = {
        version: 1,
        snapshot: 'failure_cleanup_start',
        stage,
        clocks: { parent: 'elapsed_ms_since_spawn_request', fixture: 'elapsed_ms_since_controller_boot_after_imports' },
        processes: runs.filter(run => run.root === root).map(run => ({ mode: run.mode, parentPhases: run.phases.slice(0, diagnosticPhaseLimit), fixturePhases: fixturePhases(run.stderr()), stderr: bounded(run.stderr()) }))
      }
      await writeFile(join(root, 'recovery-diagnostic.json'), JSON.stringify(diagnostic, null, 2))
    }))
  }
  // Persist the pre-signal snapshot even if cleanup itself subsequently stalls.
  if (failed) await saveDiagnostics('before_cleanup')
  for (const run of runs) {
    if (run.child.connected) {
      run.phases.push({ event: 'parent_terminate_request', ms: Math.round(performance.now() - run.started) })
      run.child.send('terminate')
    }
    await run.closed
    run.phases.push({ event: 'parent_cleanup_close', ms: Math.round(performance.now() - run.started), exitCode: run.child.exitCode, signalCode: run.child.signalCode })
  }
  if (failed) {
    await saveDiagnostics('closed')
    console.warn('Retained failed process fixture:', finishedRoots)
    for (const run of runs) console.warn(`[${run.mode}] recovery phases:`, run.phases.map(phase => `${phase.event}@${phase.ms}ms`).join(' -> '))
  } else await Promise.all(finishedRoots.map(root => rm(root, { recursive: true, force: true })))
})
afterAll(async () => { if (bundle) await rm((await bundle).root, { recursive: true, force: true }) })
export const literal = (value: string): WorkflowExpression => ({ kind: 'literal', value })
export const ref = (name: string): WorkflowExpression => ({ kind: 'ref', name })
export const field = (name: string, key: string): WorkflowExpression => ({ kind: 'field', source: ref(name), path: [key] })
const sequence: WorkflowBlock[] = [
  { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first' },
  { kind: 'call', blockId: 'second', role: 'worker', prompt: 'second', inputRefs: [{ nodeId: 'first' }] },
  { kind: 'return', blockId: 'report', ref: { nodeId: 'second' } }
]
export async function setup(blocks = sequence) {
  const root = await mkdtemp(join(tmpdir(), 'scry recovery process ')); roots.push(root)
  const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: 'workflow-' + randomUUID(), programRevision: 'pending', userGoal: 'process recovery', workspace: root, roles: [role], body: { kind: 'sequence', blockId: 'root', blocks } })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  const preview = makePlanPreview(program, [], role)
  await writeFile(join(root, 'preview.json'), JSON.stringify(preview))
  return { root, preview, store: new FileWorkflowStore(root) }
}
export async function launch(root: string, mode: string) {
  const { path } = await engine()
  const sandbox = process.platform === 'darwin'
  if (sandbox) await access('/usr/bin/sandbox-exec')
  // User-approved test-only exception: macOS cannot exec its setuid ps in a
  // sandbox. Only the fixed system tool escapes; controllers/CLI/checks still
  // inherit deny network*, verified by the native recovery scenarios.
  const native = mode === 'native-revision-crash' || mode === 'native-revision-resume'
  const profile = '(version 1)(allow default)(deny network*)' + (native ? '(allow process-exec (literal "/bin/ps") (with no-sandbox))' : '')
  // afterEach retires the root before awaiting its registered controllers. A
  // timed-out body must not admit another controller after that snapshot.
  if (!roots.includes(root)) throw new Error('process fixture root admission is closed')
  const started = performance.now(), phases: ParentPhase[] = [], phase = (event: string, detail: Omit<ParentPhase, 'event' | 'ms'> = {}) => phases.push({ event, ms: Math.round(performance.now() - started), ...detail })
  const child = spawn(sandbox ? '/usr/bin/sandbox-exec' : process.execPath, sandbox ? ['-p', profile, process.execPath, path, root, mode] : [path, root, mode], { env: { HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin', SCRY_WORKFLOW_RECOVERY_TRACE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  phase('parent_spawn_returned', { pid: child.pid })
  child.once('spawn', () => phase('parent_spawned', { pid: child.pid }))
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', text => { stderr += text })
  phase('parent_stdio_registered', { streams: ['stdout', 'stderr', 'ipc'] })
  child.stdout!.once('end', () => phase('parent_stdout_end'))
  child.stderr!.once('end', () => phase('parent_stderr_end'))
  child.once('disconnect', () => phase('parent_ipc_disconnect'))
  child.once('exit', (code, signal) => phase('parent_exit', { code, signal, exitCode: child.exitCode, signalCode: child.signalCode }))
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { phase('parent_close', { code, signal, exitCode: child.exitCode, signalCode: child.signalCode }); resolve({ code, signal }) }) })
  children.push({ root, mode, started, child, closed, phases, stderr: () => stderr })
  const checkpoint = mode === 'live' ? new Promise<void>((resolve, reject) => {
    child.once('message', message => (message as { type?: string }).type === 'checkpoint' ? resolve() : reject(new Error('unexpected checkpoint')))
    child.once('exit', code => reject(new Error('early exit: ' + code + ': ' + stderr)))
  }) : undefined
  return { child, closed, checkpoint, stderr: () => stderr }
}
export async function run(root: string, mode: string, code: number) {
  const process = await launch(root, mode), result = await process.closed
  expect(result, process.stderr()).toEqual({ code, signal: null })
}
export async function effects(root: string): Promise<Array<{ node: string; taskId: string; attemptId: string; prompt: string; pid: number; cwd: string; network: string }>> {
  return (await readFile(join(root, 'effects.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}
