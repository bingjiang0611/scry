import { mkdtemp, writeFile, readFile, rm, chmod, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeWorkflowCheck, freezeWorkflowCheck, validateWorkflowCheck, validateWorkflowFrozenCheck, workflowCheckDiagnostics, type WorkflowCheckExecution } from './workflow-check'

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
  it('runs explicit native Node test files and keeps runner counts as incomplete scope evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-node-test-'))
    roots.push(root)
    const files = ['pass.test.cjs', 'skip.test.cjs', 'todo.test.cjs', 'fail.test.cjs']
    await Promise.all(files.map((name, index) => writeFile(join(root, name), index === 0 ? "const { test } = require('node:test'); test('pass', () => {})\n" : index === 1 ? "const { test } = require('node:test'); test('skip', { skip: true }, () => {})\n" : index === 2 ? "const { test } = require('node:test'); test('todo', { todo: true }, () => {})\n" : "const { test } = require('node:test'); test('fail', () => { throw new Error('fail') })\n")))
    // Approved for this new four-file fixture only; the outer 5 s deadline stays unchanged.
    const env = { PATH: '/usr/bin:/bin', HOME: root }, frozen = await freezeWorkflowCheck({ parser: 'node_test', argv: [process.execPath, '--test', '--test-reporter=tap', ...files], cwd: '.', timeoutMs: 4000 }, root, env)
    expect(frozen.testFiles).toHaveLength(4)
    const execution = executeWorkflowCheck(frozen, env)
    executions.push(execution)
    expect(await execution.result).toMatchObject({ state: 'failed', settled: true, tests: { state: 'available', source: 'node_test_tap', counts: { total: 4, suites: 0, passed: 1, failed: 1, skipped: 1, todo: 1, cancelled: 0 } } })
  })
  it('rejects Node test flags and changed frozen test files before execution', async () => {
    const f = await fixture('')
    await expect(freezeWorkflowCheck({ parser: 'node_test', argv: [process.execPath, '--test', '--test-reporter=tap', '--test-name-pattern=x'], cwd: '.', timeoutMs: 2000 }, f.root, f.env)).rejects.toThrow()
    const testFile = join(f.root, 'one.test.cjs')
    await writeFile(testFile, "require('node:test').test('one', () => {})\n")
    const frozen = await freezeWorkflowCheck({ parser: 'node_test', argv: [process.execPath, '--test', '--test-reporter=tap', 'one.test.cjs'], cwd: '.', timeoutMs: 2000 }, f.root, f.env)
    await writeFile(testFile, "require('node:test').test('changed', () => {})\n")
    expect(await executeWorkflowCheck(frozen, f.env).result).toMatchObject({ state: 'rejected', settled: true })
  })
  it.each(['skip', 'todo'])('does not certify a zero-exit Node report containing %s', async kind => {
    const f = await fixture('')
    await writeFile(join(f.root, 'partial.test.cjs'), `require('node:test').test('partial', { ${kind}: true }, () => {})\n`)
    const frozen = await freezeWorkflowCheck({ parser: 'node_test', argv: [process.execPath, '--test', '--test-reporter=tap', 'partial.test.cjs'], cwd: '.', timeoutMs: 2000 }, f.root, f.env)
    const execution = executeWorkflowCheck(frozen, f.env)
    executions.push(execution)
    expect(await execution.result).toMatchObject({ state: 'incomplete', exitCode: 0, settled: true, tests: { state: 'available', counts: { total: 1, [kind === 'skip' ? 'skipped' : 'todo']: 1 } } })
  })
  it.each(['', 'process.exit(0)'])('does not mistake a passed file unit for discovered or executed test bodies %#', async source => {
    const f = await fixture('')
    await writeFile(join(f.root, 'empty.test.cjs'), source)
    const frozen = await freezeWorkflowCheck({ parser: 'node_test', argv: [process.execPath, '--test', '--test-reporter=tap', 'empty.test.cjs'], cwd: '.', timeoutMs: 2000 }, f.root, f.env)
    const execution = executeWorkflowCheck(frozen, f.env)
    executions.push(execution)
    expect(await execution.result).toMatchObject({ state: 'passed', exitCode: 0, tests: { state: 'available', counts: { total: 1, passed: 1 }, discovery: { state: 'unavailable' }, execution: { state: 'unavailable' }, coverage: { state: 'unavailable' } } })
  })
  it('does not pass a truncated zero-exit Node report', async () => {
    const f = await fixture('')
    await writeFile(join(f.root, 'large.test.cjs'), "require('node:test').test('output', () => process.stdout.write('x'.repeat(2 * 1024 * 1024)))\n")
    const frozen = await freezeWorkflowCheck({ parser: 'node_test', argv: [process.execPath, '--test', '--test-reporter=tap', 'large.test.cjs'], cwd: '.', timeoutMs: 2000 }, f.root, f.env)
    const execution = executeWorkflowCheck(frozen, f.env)
    executions.push(execution)
    expect(await execution.result).toMatchObject({ state: 'failed', exitCode: 0, truncated: true, settled: true, tests: { state: 'unavailable' } })
  })
  it('freezes only explicit unique canonical test files, never flags, directories, globs or escaping aliases', async () => {
    const f = await fixture(''), outside = await mkdtemp(join(tmpdir(), 'scry-node-test-outside-'))
    roots.push(outside)
    await writeFile(join(f.root, 'one.test.cjs'), "require('node:test').test('one', () => {})\n")
    await writeFile(join(outside, 'escape.test.cjs'), '')
    await symlink(join(outside, 'escape.test.cjs'), join(f.root, 'escape.test.cjs'))
    await writeFile(join(f.root, '{a,b}.test.cjs'), '')
    await symlink(join(f.root, '{a,b}.test.cjs'), join(f.root, 'literal-alias.test.cjs'))
    const request = { parser: 'node_test', argv: [process.execPath, '--test', '--test-reporter=tap', 'one.test.cjs'], cwd: '.', timeoutMs: 2000 }
    for (const files of [['--require=x'], ['*.test.cjs'], ['{a,b}.test.cjs'], ['.'], ['escape.test.cjs'], ['literal-alias.test.cjs'], ['one.test.cjs', './one.test.cjs']]) {
      await expect(freezeWorkflowCheck({ ...request, argv: [...request.argv.slice(0, 3), ...files] }, f.root, f.env)).rejects.toThrow()
    }
    const frozen = await freezeWorkflowCheck(request, f.root, f.env)
    expect(validateWorkflowFrozenCheck(frozen)).toEqual(frozen)
    expect(() => validateWorkflowFrozenCheck({ ...frozen, testFiles: [] })).toThrow()
    expect(() => validateWorkflowFrozenCheck({ ...frozen, entrypoint: frozen.testFiles![0] })).toThrow()
    expect(() => validateWorkflowFrozenCheck({ ...f.frozen, testFiles: frozen.testFiles })).toThrow()
  })
})
