import { mkdtemp, writeFile, readFile, rm, chmod, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeWorkflowCheck, freezeWorkflowCheck, validateWorkflowCheck, workflowCheckDiagnostics, type WorkflowCheckExecution } from './workflow-check'

const roots: string[] = [], executions: WorkflowCheckExecution[] = []
afterEach(async () => {
  for (const execution of executions.splice(0)) { execution.stop(); await execution.result; await execution.settled }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(source: string, timeoutMs = 2000, args: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'scry-owned-check-'))
  roots.push(root)
  const script = join(root, 'check script.cjs')
  await writeFile(script, source)
  const env = { PATH: '/usr/bin:/bin', HOME: root }
  const frozen = await freezeWorkflowCheck({ argv: [process.execPath, script, ...args], cwd: '.', timeoutMs }, root, env)
  const run = () => { const execution = executeWorkflowCheck(frozen, env); executions.push(execution); return execution }
  return { root, env, frozen, run }
}

describe('main-owned frozen argv check execution (local processes only)', () => {
  it('runs exact argv and observes exit and output without a shell', async () => {
    const f = await fixture("require('node:fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2))); console.log('observed'); process.exitCode = 0", 2000, ['a b', '$(touch injected)', 'x; touch injected', '|', '>'])
    const result = await f.run().result
    expect(result).toMatchObject({ state: 'passed', exitCode: 0, settled: true, stdout: 'observed\n', truncated: false, evidence: 'exact', diagnostics: { state: 'unavailable' } })
    expect(JSON.parse(await readFile(join(f.root, 'argv.json'), 'utf8'))).toEqual(['a b', '$(touch injected)', 'x; touch injected', '|', '>'])
    await expect(readFile(join(f.root, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('retains nonzero exit and exact stderr instead of interpreting a success claim', async () => {
    const f = await fixture("console.log('all checks passed'); console.error('native failure'); process.exitCode = 17")
    expect(await f.run().result).toMatchObject({ state: 'failed', exitCode: 17, stderr: 'native failure\n', settled: true })
  })
  it('does not pass a zero-exit process that emits structured TypeScript errors', async () => {
    const f = await fixture("console.log('src/a.ts(2,3): error TS2322: wrong type')")
    const execution = executeWorkflowCheck({ ...f.frozen, parser: 'typescript' }, f.env)
    executions.push(execution)
    expect(await execution.result).toMatchObject({ state: 'failed', exitCode: 0, settled: true, diagnostics: { state: 'available', source: 'derived', items: [{ file: 'src/a.ts', code: 'TS2322' }] } })
  })
  it('never treats truncated output and exit zero as passed', async () => {
    const f = await fixture("process.stdout.write('x'.repeat(2 * 1024 * 1024))")
    const result = await f.run().result
    expect(result).toMatchObject({ state: 'failed', exitCode: 0, truncated: true, diagnostics: { state: 'unavailable' } })
    expect(Buffer.byteLength(result.stdout)).toBe(1024 * 1024)
  })
  it('revalidates executable bytes and environment before any script is entered', async () => {
    const f = await fixture("require('node:fs').writeFileSync('entered', 'true')")
    expect(await executeWorkflowCheck({ ...f.frozen, executableHash: '0'.repeat(64) }, f.env).result).toMatchObject({ state: 'rejected', settled: true })
    expect(await executeWorkflowCheck(f.frozen, { ...f.env, NEW_VALUE: 'changed' }).result).toMatchObject({ state: 'rejected', settled: true })
    await expect(readFile(join(f.root, 'entered'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects changed runtime entry bytes before running the approved check', async () => {
    const f = await fixture("require('node:fs').writeFileSync('entered', 'true')")
    await writeFile(f.frozen.entrypoint!.path, "require('node:fs').writeFileSync('entered', 'changed')")
    expect(await f.run().result).toMatchObject({ state: 'rejected', settled: true })
    await expect(readFile(join(f.root, 'entered'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses explicit shell and inline-runtime entrypoints, not argv data or repository scripts', async () => {
    const f = await fixture('')
    for (const argv of [['/bin/sh', '-c', 'exit 0'], [process.execPath, '-e', 'process.exit(0)'], [process.execPath, '--eval=process.exit(0)']]) {
      await expect(freezeWorkflowCheck({ argv, cwd: '.' }, f.root, f.env)).rejects.toThrow('内联代码')
    }
  })
  it('rejects a directory symlink redirected outside the registered root', async () => {
    const f = await fixture(''), outside = await mkdtemp(join(tmpdir(), 'scry-check-outside-'))
    roots.push(outside)
    await mkdir(join(f.root, 'work'))
    const frozen = await freezeWorkflowCheck({ argv: f.frozen.argv, cwd: 'work' }, f.root, f.env)
    await rm(join(f.root, 'work'), { recursive: true })
    await symlink(outside, join(f.root, 'work'))
    expect(await executeWorkflowCheck(frozen, f.env).result).toMatchObject({ state: 'rejected', settled: true })
  })
  it('honors the frozen deadline and closes only its registered live process group', async () => {
    const f = await fixture('setInterval(() => {}, 1000)', 150)
    const execution = f.run()
    expect(await execution.result).toMatchObject({ state: 'timed_out', settled: true, signal: 'SIGKILL' })
    await execution.settled
  })
  it('latches stop before preflight completes and does not enter the process', async () => {
    const f = await fixture("require('node:fs').writeFileSync('entered', 'true')")
    const execution = f.run()
    expect(execution.stop()).toBe(true)
    expect(await execution.result).toMatchObject({ state: 'cancelled', settled: true })
    await expect(readFile(join(f.root, 'entered'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('fingerprints the interpreter of executable repository scripts', async () => {
    const f = await fixture(''), script = join(f.root, 'native-check')
    await writeFile(script, '#!/bin/sh\nexit 0\n')
    await chmod(script, 0o700)
    const frozen = await freezeWorkflowCheck({ argv: [script], cwd: '.' }, f.root, f.env)
    expect(frozen.interpreters.length).toBeGreaterThan(0)
    const result = await executeWorkflowCheck({ ...frozen, interpreters: frozen.interpreters.map(item => ({ ...item, hash: '0'.repeat(64) })) }, f.env).result
    expect(result).toMatchObject({ state: 'rejected', settled: true })
  })
  it.each([
    { argv: ['/bin/true'], cwd: '../outside' },
    { argv: ['/bin/true'], cwd: '/', env: { FOO: 'bar' } },
    { argv: 'echo x', cwd: '.' },
    { argv: ['/bin/true'], cwd: '.', timeoutMs: 0 }
  ])('refuses non-contract input %#', value => { expect(() => validateWorkflowCheck(value)).toThrow() })
  it('does not fabricate comparable diagnostics from unmatched or truncated text', () => {
    expect(workflowCheckDiagnostics('typescript', 'src/a.ts(2,3): error TS2322: bad value\n', '', false)).toEqual({ state: 'available', source: 'derived', items: [{ file: 'src/a.ts', line: 2, column: 3, code: 'TS2322', message: 'bad value' }] })
    expect(workflowCheckDiagnostics('typescript', 'npm says passed', '', false).state).toBe('unavailable')
    expect(workflowCheckDiagnostics('typescript', '', '', true).state).toBe('unavailable')
  })
})
