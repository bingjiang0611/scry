#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(skill, '../../..')
const sha256 = data => createHash('sha256').update(data).digest('hex')
const coverage = JSON.parse(await readFile(join(skill, 'coverage.json'), 'utf8'))
for (const [path, expected] of Object.entries(coverage.files)) {
  assert.equal(sha256(await readFile(join(root, path))), expected,
    `REVIEW_REQUIRED: ${path} changed since ${coverage.syncCommit}; reread coverage before moving the sync commit`)
}
const evidence = await mkdtemp(join(tmpdir(), 'scry-formal-evidence-'))
const scratch = await mkdtemp(join(tmpdir(), 'scry-formal-source-'))
console.log(`EVIDENCE=${evidence}`)
const results = []
const run = async (label, command, args, cwd) => {
  const started = Date.now()
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  await writeFile(join(evidence, `${label}.log`), output)
  results.push({ label, command, args, cwd, status: result.status, signal: result.signal,
    elapsedMs: Date.now() - started, error: result.error?.message })
  if (result.error) throw result.error
  assert.equal(result.signal, null, `${label} terminated by a signal; inspect the log`)
  return { status: result.status, output }
}
const mutations = [
  { name: 'BrokenAdmission', file: 'src/main/source-control/service.ts',
    before: "    if (this.active.has(identity.commonDir))\n      throw new Error('此仓库正在执行源代码管理操作，请等待操作完成后启动 Agent')\n",
    after: '' },
  { name: 'BrokenFinalization', file: 'src/main/run-registry.ts',
    before: 'state.providerSettled !== true || state.localFinalizing === true',
    after: 'state.providerSettled !== true' }
]
const summary = { status: 'failed', coverage, evidence, scratch, results }
try {
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'scry-formal')
  const jar = join(cache, 'tla2tools-1.7.4.jar')
  const checksum = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
  let bytes
  try { bytes = await readFile(jar) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const response = await fetch('https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar',
      { signal: AbortSignal.timeout(60000) })
    assert.ok(response.ok, `TLC download HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(sha256(bytes), checksum, 'untrusted TLC artifact; refusing execution')
    await mkdir(cache, { recursive: true })
    await writeFile(jar, bytes)
  }
  assert.equal(sha256(bytes), checksum, 'TLC checksum changed; refusing execution')
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java'
  assert.equal((await run('java-version', java, ['-version'], root)).status, 0, 'install Java 11+ first')
  summary.revision = (await run('revision', 'git', ['rev-parse', 'HEAD'], root)).output.trim()
  await run('dirty', 'git', ['status', '--short'], root)
  await run('diff', 'git', ['diff', 'HEAD', '--', ...Object.keys(coverage.files), 'scripts/source-control-exclusion.formal.test.ts'], root)
  await cp(join(skill, 'model'), join(evidence, 'model'), { recursive: true })
  await cp(join(root, 'src'), join(scratch, 'src'), { recursive: true })
  await mkdir(join(scratch, 'scripts'))
  const test = 'scripts/source-control-exclusion.formal.test.ts'
  await cp(join(root, test), join(scratch, test))
  await cp(join(root, test), join(evidence, 'real-code.test.ts'))
  summary.checkerSha256 = sha256(await readFile(fileURLToPath(import.meta.url)))
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  await writeFile(join(scratch, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(scratch, 'vitest.config.ts'),
    `export default { test: { include: [${JSON.stringify(test)}], maxWorkers: 1, fileParallelism: false } }\n`)
  const vitestVersion = JSON.parse(await readFile(join(root, 'node_modules/vitest/package.json'), 'utf8')).version
  assert.equal(vitestVersion, '3.2.7', 'use the locked Vitest version; review tool changes explicitly')
  summary.tools = { node: process.version, vitest: vitestVersion, tlcRelease: '1.7.4', checksum }
  const checkModel = async name => {
    const result = await run(`tlc-${name}`, java, ['-XX:+UseParallelGC', '-Xmx512m', '-cp', jar, 'tlc2.TLC',
      '-workers', '1', '-seed', '1', '-fp', '0', '-metadir', join(scratch, `states-${name}`),
      '-config', `${name}.cfg`, 'RepositoryExclusion.tla'], join(evidence, 'model'))
    const pass = name === 'RepositoryExclusion'
    assert.equal(result.status === 0, pass, `unexpected TLC outcome for ${name}`)
    assert.match(result.output, pass ? /Model checking completed. No error has been found/ : /Invariant NoWriteDuringUnsettled is violated/)
  }
  const checkCode = async (name, broken) => {
    const report = join(evidence, `code-${name}.json`)
    const result = await run(`code-${name}`, process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'),
      'run', '--root', scratch, '--config', join(scratch, 'vitest.config.ts'), '--reporter=json', `--outputFile=${report}`], scratch)
    const data = JSON.parse(await readFile(report, 'utf8'))
    assert.equal(data.numTotalTests, 11, 'witness suite was not fully collected')
    assert.equal(result.status, broken ? 1 : 0, `unexpected code outcome for ${name}`)
    if (broken) {
      const failures = data.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
      assert.ok(failures.some(test => test.fullName.includes(`replays shortest ${name} path`) &&
        test.failureMessages.some(message => message.includes('NoWriteDuringUnsettled:'))),
        'negative control did not replay its shortest counterexample against the real code')
    } else assert.equal(data.numPassedTests, 11)
  }
  await checkModel('RepositoryExclusion')
  await checkCode('baseline', false)
  for (const mutation of mutations) {
    const path = join(scratch, mutation.file)
    const source = await readFile(path, 'utf8')
    assert.equal(source.split(mutation.before).length, 2, `mutation drift: ${mutation.name}`)
    try {
      await writeFile(path, source.replace(mutation.before, mutation.after))
      await checkModel(mutation.name)
      await checkCode(mutation.name, true)
    } finally {
      await writeFile(path, source)
    }
  }
  // Both real source mutations are gone; this is not a model-only negative control.
  await checkCode('restored', false)
  for (const [path, hash] of Object.entries(coverage.files)) {
    assert.equal(sha256(await readFile(join(root, path))), hash, `source changed during verification: ${path}`)
  }
  summary.status = 'passed'
} catch (error) {
  summary.error = error.stack ?? String(error)
  process.exitCode = 1
  console.error(summary.error)
} finally {
  await rm(scratch, { recursive: true, force: true })
  summary.scratchRemoved = true
  await writeFile(join(evidence, 'result.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`RESULT=${summary.status}; scratch removed; logs retained at ${evidence}`)
}
