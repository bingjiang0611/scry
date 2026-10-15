import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const nativeWorkloads = { markdown: [40, 32], short: [20, 1], 'short-heavy': [20, 32], paged: [120, 2] }
export const nativeHarnessFiles = ['scripts/performance-native.mjs', 'scripts/session-open-bench.mjs', 'scripts/session-open-timing.mjs', 'scripts/owned-app-processes.mjs', 'scripts/performance-report.mjs', 'scripts/performance-paths.json']
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]

export function validateNative(report) {
  assert.equal(report.schema, 1)
  assert.equal(report.errors.length, 0, 'failed native lanes cannot pass')
  assert.deepEqual(Object.keys(report.results).sort(), Object.keys(nativeWorkloads).sort(), 'native lane coverage differs')
  for (const [name, result] of Object.entries(report.results)) {
    assert.equal(result.measurementVersion, 3)
    assert.deepEqual([result.turnCount, result.sections], nativeWorkloads[name], 'native workload differs')
    assert.equal(result.scenario, name)
    assert.equal(result.warmups, 2)
    assert.equal(result.iterations, 12)
    assert.equal(result.samples.length, 12)
    assert.equal(result.firstOpens.length, 2)
    assert.match(result.artifactSha256, /^[a-f0-9]{64}$/)
    assert.match(result.benchmarkSha256, /^[a-f0-9]{64}$/)
    assert.ok(result.cleanup.tracked > 0, 'owned App cleanup is required')
    assert.equal(result.nativeInput.trusted, true)
    assert.ok(finite(result.nativeInput.frameReadyMs))
    assert.ok(finite(result.startupDriverReadyMs))
    assert.equal(result.sqliteStats.status, 'ready')
    assert.ok(result.sqliteStats.turns >= 3)
    assert.ok(finite(result.sqliteStats.readMs))
    for (const sample of result.samples) {
      assert.equal(sample.totalTurns, Math.min(40, result.turnCount))
      assert.equal(sample.completeParagraphs, result.sections, 'renderer lost fixed paragraph content')
      for (const metric of ['nativeOpenMs', 'handlerDelayMs', 'scriptMs', 'domNodes']) assert.ok(finite(sample[metric]), `missing ${name}.${metric}`)
      assert.ok(sample.domNodes > 0)
    }
    assert.equal(result.lifecycleSamples.length, 6)
    for (const stopped of [false, true]) {
      const cycles = result.lifecycleSamples.filter(cycle => cycle.stopped === stopped)
      assert.equal(cycles.length, 3)
      for (const cycle of cycles) {
        assert.equal(cycle.terminalConfirmed, true)
        assert.equal(cycle.durableTurns, 1)
        assert.equal(cycle.diskVerified, true, 'archive must be independently readable after process exit')
        const metrics = ['startReceiptMs', 'firstOutputReceiptMs', 'startToTerminalMs', 'terminalToReadableArchiveMs', ...(stopped ? ['stopReceiptMs', 'stopToTerminalMs'] : [])]
        for (const metric of metrics) assert.ok(finite(cycle[metric]), `missing lifecycle ${metric}`)
      }
    }
  }
}

export function compareNative(base, head) {
  validateNative(base)
  validateNative(head)
  assert.equal(base.harness, head.harness, 'native harness differs')
  assert.match(base.harness, /^[a-f0-9]{64}$/)
  assert.deepEqual(base.environment, head.environment, 'native environment differs')
  const rows = []
  const add = (scenario, metric, baseline, candidate, absolute, noise = 50, ratio = 0.5) => {
    const ceiling = Math.min(absolute, baseline + Math.max(noise, baseline * ratio))
    rows.push({ scenario, metric, baseline, candidate, ceiling, status: candidate <= ceiling ? 'pass' : 'regressed' })
  }
  for (const name of Object.keys(nativeWorkloads)) {
    const before = base.results[name], after = head.results[name]
    assert.equal(before.benchmarkSha256, after.benchmarkSha256)
    assert.deepEqual([before.platform, before.node, before.electron], [after.platform, after.node, after.electron])
    for (const [metric, ceiling] of Object.entries({ nativeOpenMs: 500, handlerDelayMs: 100, scriptMs: 300 })) {
      add(name, `${metric}.fixtureP95`, p95(before.samples.map(sample => sample[metric])), p95(after.samples.map(sample => sample[metric])), ceiling)
    }
    add(name, 'domNodes.fixtureP95', p95(before.samples.map(sample => sample.domNodes)), p95(after.samples.map(sample => sample.domNodes)), 30000, 0, 0.05)
    add(name, 'startup.driverReady.singleMs', before.startupDriverReadyMs, after.startupDriverReadyMs, 10000, 500)
    add(name, 'input.twoFrames.singleMs', before.nativeInput.frameReadyMs, after.nativeInput.frameReadyMs, 250)
    assert.equal(before.sqliteStats.turns, after.sqliteStats.turns, 'fixed SQLite turn count changed')
    add(name, 'sqlite.stats.singleMs', before.sqliteStats.readMs, after.sqliteStats.readMs, 500)
    for (const stopped of [false, true]) {
      const metrics = ['startReceiptMs', 'firstOutputReceiptMs', 'startToTerminalMs', 'terminalToReadableArchiveMs', ...(stopped ? ['stopReceiptMs', 'stopToTerminalMs'] : [])]
      for (const metric of metrics) {
        const values = report => report.lifecycleSamples.filter(sample => sample.stopped === stopped).map(sample => sample[metric])
        add(`${name}.${stopped ? 'interrupt' : 'complete'}`, `${metric}.threeRunMax`, Math.max(...values(before)), Math.max(...values(after)), 2000, 100)
      }
    }
  }
  return { schema: 1, passed: rows.every(row => row.status === 'pass'), baseline: base.revision, candidate: head.revision, rows }
}

export function formatNative(report) {
  return ['## Native App performance', `Baseline: \`${report.baseline}\` · candidate: \`${report.candidate}\``, '',
    '| Scenario | Boundary | Base | Candidate | Ceiling | Result |', '|---|---|---:|---:|---:|---|',
    ...report.rows.map(row => `| ${row.scenario} | ${row.metric} | ${row.baseline.toFixed(2)} | ${row.candidate.toFixed(2)} | ${row.ceiling.toFixed(2)} | ${row.status} |`), '',
    'Hidden real Electron main/preload/renderer; GPU disabled. History uses trusted native clicks and two stable frames. Input uses a trusted input event and two frames. Startup includes driver readiness polling. Lifecycle uses real IPC, offline Provider fixture, terminal notification and readable archive, independently checked on disk after App exit; NOT visible output or native Send/Stop buttons.',
    'Twelve warm history samples, one restart/input observation per workload, three complete and three interrupted lifecycle runs. Fixture p95/max is NOT daily-use p95. These initial absolute guardrails are conservative, not user SLOs; relative checks catch changes. No paid Provider, real phone or external network is exercised.', ''].join('\n')
}

async function bench(output) {
  mkdirSync(dirname(resolve(output)), { recursive: true })
  const hash = createHash('sha256')
  for (const file of nativeHarnessFiles) hash.update(file).update(readFileSync(join(root, file)))
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  assert.equal(revision.status, 0)
  const report = { schema: 1, revision: revision.stdout.trim(), harness: hash.digest('hex'), environment: { platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, node: process.version }, results: {}, errors: [] }
  for (const scenario of Object.keys(nativeWorkloads)) {
    const run = spawnSync(process.execPath, ['scripts/session-open-bench.mjs', scenario], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    writeFileSync(`${output}.${scenario}.log`, `${run.stdout ?? ''}\n${run.stderr ?? ''}`)
    try {
      assert.equal(run.status, 0, `native ${scenario} failed (${run.error?.message ?? run.signal ?? run.status}); see retained log`)
      report.results[scenario] = JSON.parse(run.stdout)
    } catch (error) { report.errors.push({ scenario, message: error.message }) }
    writeFileSync(output, JSON.stringify(report, null, 2))
  }
  validateNative(report)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'bench' && args.length === 1) await bench(args[0])
    else if (command === 'compare' && args.length === 3) {
      const [base, head, output] = args
      const report = compareNative(JSON.parse(readFileSync(base, 'utf8')), JSON.parse(readFileSync(head, 'utf8')))
      const markdown = formatNative(report)
      writeFileSync(output, markdown)
      writeFileSync(`${output}.json`, JSON.stringify(report, null, 2))
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
      if (!report.passed) process.exitCode = 1
    } else throw new Error('Usage: performance-native.mjs bench <output.json> | compare <baseline.json> <candidate.json> <report.md>')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
