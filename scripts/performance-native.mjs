import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateObservations } from './performance-ratchet.mjs'
import { composerModes, nativeCounterMetrics } from './native-composer-probe.mjs'
export { composerModes, nativeCounterMetrics }

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const nativeWorkloads = { markdown: [40, 32], short: [20, 1], 'short-heavy': [20, 32], paged: [120, 2] }
export const nativeHarnessFiles = ['scripts/performance-native.mjs', 'scripts/session-open-bench.mjs', 'scripts/session-open-timing.mjs', 'scripts/native-composer-probe.mjs', 'src/main/providers/smoke.ts', 'scripts/owned-app-processes.mjs', 'scripts/hidden-electron-windows.cjs', 'scripts/performance-report.mjs', 'scripts/performance-paths.json']
const composerMetrics = mode => ['sendToTerminalMs', 'sendToSettledVisibleMs',
  ...(mode !== 'stop-immediate' ? ['sendToOutputReceiptMs', 'sendToFirstVisibleMs', 'sendToVisibleReadyMs'] : []),
  ...(mode !== 'complete' ? ['stopToTerminalMs', 'stopToSettledVisibleMs'] : [])]
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const integerCounter = value => Number.isSafeInteger(value) && value >= 0
const assertCounters = (counters, label) => {
  assert.ok(counters && nativeCounterMetrics.every(metric => integerCounter(counters[metric])), `missing ${label} work counters`)
}

export function exportNativeCounters(report) {
  const observations = []
  const add = (scenario, operation, workload, runsByMetric) => {
    for (const [index, metric] of nativeCounterMetrics.entries()) {
      observations.push({ scenario: `${scenario}.${operation}`, metric: `ui.${metric}`, layer: 'ui', unit: 'count', workload,
        source: 'hidden Electron CDP Performance.getMetrics deltas plus MutationObserver record count', availability: 'measured', runs: runsByMetric[index] })
    }
  }
  for (const [scenario, result] of Object.entries(report.results ?? {})) {
    const workload = `native-${scenario};turns=${result.turnCount};sections=${result.sections}`
    add(scenario, 'history-open', workload, nativeCounterMetrics.map(metric => result.samples.map(sample => sample.workCounters[metric])))
    // One metric per button mode: completion, immediate stop and visible stop do different work,
    // so mixing them would turn mode differences into apparent run-to-run instability.
    for (const mode of new Set(composerModes)) {
      const samples = result.composerSamples.filter(sample => sample.mode === mode)
      add(scenario, `send-settled.${mode}`, workload, nativeCounterMetrics.map(metric => samples.map(sample => sample.sendWorkCounters[metric])))
      if (mode !== 'complete') add(scenario, `stop-settled.${mode}`, workload, nativeCounterMetrics.map(metric => samples.map(sample => sample.stopWorkCounters[metric])))
    }
  }
  return validateObservations({ schema: 1, revision: report.revision, observations })
}
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]

export function validateNative(report) {
  assert.equal(report.schema, 1)
  assert.equal(report.errors.length, 0, 'failed native lanes cannot pass')
  assert.deepEqual(Object.keys(report.results).sort(), Object.keys(nativeWorkloads).sort(), 'native lane coverage differs')
  for (const [name, result] of Object.entries(report.results)) {
    assert.equal(result.measurementVersion, 5)
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
    assert.equal(result.sqliteStats.turns, 18, 'all six IPC and twelve button runs must reach SQLite')
    assert.ok(finite(result.sqliteStats.readMs))
    assert.equal(result.counterSensitivity?.passed, true, 'native work counter sensitivity control must pass')
    assertCounters(result.counterSensitivity?.baseline, `${name} sensitivity baseline`)
    assertCounters(result.counterSensitivity?.extra, `${name} sensitivity extra`)
    assert.ok(nativeCounterMetrics.some(metric => result.counterSensitivity.extra[metric] > result.counterSensitivity.baseline[metric]), 'sensitivity control must raise a work counter')
    for (const sample of result.samples) {
      assert.equal(sample.totalTurns, Math.min(40, result.turnCount))
      assert.equal(sample.completeParagraphs, result.sections, 'renderer lost fixed paragraph content')
      for (const metric of ['nativeOpenMs', 'handlerDelayMs', 'scriptMs', 'domNodes']) assert.ok(finite(sample[metric]), `missing ${name}.${metric}`)
      assert.ok(sample.domNodes > 0)
      assertCounters(sample.workCounters, `${name} history open`)
    }
    assert.deepEqual(result.composerSamples.map(sample => sample.mode), composerModes, 'native button scenario coverage differs')
    assert.equal(new Set(result.composerSamples.map(sample => sample.runId)).size, 12, 'native button runs must have distinct identities')
    for (const [index, sample] of result.composerSamples.entries()) {
      assert.equal(typeof sample.runId, 'string')
      assert.ok(sample.runId.length > 0)
      assert.equal(sample.prompt, `native composer ${sample.mode} ${index}`)
      assert.equal(sample.inputTrusted, true)
      assert.equal(sample.sendTrusted, true, 'Send must originate from a trusted button click')
      assert.equal(sample.stopTrusted, sample.mode !== 'complete', 'Stop must originate from a trusted button click')
      assert.equal(sample.terminalConfirmed, true)
      assert.equal(sample.stopped, sample.mode !== 'complete')
      assert.equal(sample.nativeTurnKnown, sample.mode !== 'stop-immediate')
      assert.equal(sample.diskVerified, true, 'button output must be independently readable after process exit')
      assertCounters(sample.sendWorkCounters, `${name} send settled`)
      if (sample.stopped) assertCounters(sample.stopWorkCounters, `${name} stop settled`)
      for (const metric of composerMetrics(sample.mode)) assert.ok(finite(sample[metric]), `missing button ${metric}`)
      assert.ok(sample.sendToSettledVisibleMs >= sample.sendToTerminalMs)
      if (sample.mode !== 'stop-immediate') {
        assert.ok(sample.sendToFirstVisibleMs >= sample.sendToOutputReceiptMs)
        assert.ok(sample.sendToVisibleReadyMs >= sample.sendToFirstVisibleMs)
      }
      if (sample.stopped) {
        assert.ok(finite(sample.driverStopDispatchMs))
        assert.ok(sample.stopToSettledVisibleMs >= sample.stopToTerminalMs)
      }
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
    for (const mode of new Set(composerModes)) {
      for (const metric of composerMetrics(mode)) {
        const values = report => report.composerSamples.filter(sample => sample.mode === mode).map(sample => sample[metric])
        add(`${name}.button.${mode}`, `${metric}.${values(before).length}RunMax`, Math.max(...values(before)), Math.max(...values(after)), 1000, 100)
      }
    }
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
    'Hidden real Electron main/preload/renderer; GPU disabled. History uses trusted native clicks and two stable frames. Input uses a trusted input event and two frames. Startup includes driver readiness polling. The separately labelled IPC lifecycle remains distinct. Button acceptance uses trusted Send/Stop clicks, real assistant text hit-tested in the viewport across two frames, terminal notification, idle composer across two frames, and independently readable output after App exit. The offline Provider waits for actual cancellation, without timed completion.',
    'Twelve warm history samples, one restart/input observation, three complete and three interrupted IPC runs per workload. Three fixed button cohorts each contain: stop before native turn identity, complete, stop after visible output, then early stop again; SQLite must retain all eighteen runs. Every observation is retained; no failure-dependent retries or discarded warmups. Button maxima are acceptance guardrails, not statistical latency estimates. Send-to-terminal totals on interrupted runs include driver dispatch time, recorded separately as driverStopDispatchMs. Fixture p95/max is NOT daily-use p95. These initial absolute guardrails are conservative, not user SLOs; relative checks catch changes. No paid Provider, real phone or external network is exercised.', ''].join('\n')
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
    report.counters = exportNativeCounters(report)
    writeFileSync(output, JSON.stringify(report, null, 2))
  }
  validateNative(report)
  report.counters = exportNativeCounters(report)
  writeFileSync(output, JSON.stringify(report, null, 2))
  const counterOutput = output.endsWith('.json') ? `${output.slice(0, -'.json'.length)}.counters.json` : `${output}.counters.json`
  writeFileSync(counterOutput, `${JSON.stringify(report.counters, null, 2)}\n`)
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
