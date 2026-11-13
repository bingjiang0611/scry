import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { isTimingMetric, nativeVerdict } from './performance-native-verdict.mjs'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
const root = resolve(import.meta.dirname, '..')
const workflow = load(readFileSync(join(root, '.github/workflows/performance.yml'), 'utf8')) as {
  jobs: Record<string, { outputs?: Record<string, string>; steps: { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> }[] }>
}
const row = (metric: string, status = 'pass') => ({ scenario: 'paged', metric, baseline: 1, candidate: 1, ceiling: 1, status })
const timing = row('nativeOpenMs.fixtureP95', 'regressed')
const done = { measurements: 'success', comparison: 'failure', retained: 'success' }
const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('native verdict classification', () => {
  it('classifies only timing metrics as advisory', () => {
    for (const metric of ['nativeOpenMs.fixtureP95', 'handlerDelayMs.fixtureP95', 'scriptMs.fixtureP95', 'startup.driverReady.singleMs',
      'input.twoFrames.singleMs', 'sqlite.stats.singleMs', 'sendToTerminalMs.6RunMax', 'stopToSettledVisibleMs.3RunMax', 'startToTerminalMs.threeRunMax']) {
      expect(isTimingMetric(metric), metric).toBe(true)
    }
    for (const metric of ['domNodes.fixtureP95', 'turns', 'nativeOpenMs', '', undefined]) expect(isTimingMetric(metric), String(metric)).toBe(false)
  })

  it('accepts a complete comparison whose failing rows are all timing rows', () => {
    expect(nativeVerdict({ ...done, report: { passed: false, rows: [row('domNodes.fixtureP95'), timing, row('sendToTerminalMs.6RunMax', 'regressed')] } })).toBe('timing-only')
    expect(nativeVerdict({ ...done, comparison: 'success', report: { passed: true, rows: [row('domNodes.fixtureP95')] } })).toBe('pass')
  })

  it('blocks work regressions, missing or inconsistent evidence and failed lanes or retention', () => {
    expect(nativeVerdict({ ...done, report: { passed: false, rows: [timing, row('domNodes.fixtureP95', 'regressed')] } })).toBe('blocking')
    expect(nativeVerdict({ ...done, report: { passed: false, rows: [row('scriptMs.fixtureP95', 'unknown')] } })).toBe('blocking')
    expect(nativeVerdict({ ...done, report: null })).toBe('invalid')
    expect(nativeVerdict({ ...done, report: { passed: false, rows: [] } })).toBe('invalid')
    expect(nativeVerdict({ ...done, report: { passed: false, rows: [row('scriptMs.fixtureP95')] } })).toBe('invalid')
    expect(nativeVerdict({ ...done, report: { passed: true, rows: [timing] } })).toBe('invalid')
    expect(nativeVerdict({ ...done, comparison: 'success', report: { passed: false, rows: [timing] } })).toBe('invalid')
    for (const change of [{ measurements: 'failure' }, { retained: 'failure' }, { comparison: 'skipped' }, { comparison: 'cancelled' }]) {
      expect(nativeVerdict({ ...done, ...change, report: { passed: false, rows: [timing] } }), JSON.stringify(change)).toBe('invalid')
    }
  })

  it('writes the verdict output from the workflow CLI and fails closed without a report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scry-native-verdict-'))
    temporary.push(directory)
    const output = join(directory, 'output')
    const run = (report: string) => {
      writeFileSync(output, '')
      spawnSync(process.execPath, [join(root, 'scripts/performance-native-verdict.mjs'), report], {
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, NATIVE_MEASUREMENTS: 'success', NATIVE_COMPARISON: 'failure', NATIVE_RETAINED: 'success' }, encoding: 'utf8'
      })
      return readFileSync(output, 'utf8')
    }
    const report = join(directory, 'report.md.json')
    writeFileSync(report, JSON.stringify({ passed: false, rows: [timing] }))
    expect(run(report)).toBe('verdict=timing-only\n')
    expect(run(join(directory, 'missing.json'))).toBe('verdict=invalid\n')
    writeFileSync(report, '{not json')
    expect(run(report)).toBe('verdict=invalid\n')
  })

  it('classifies after retention from the step outcomes and exposes it to the Performance Check', () => {
    const native = workflow.jobs.native
    const steps = native.steps
    const verdict = steps.find(step => step.id === 'native_verdict')!
    expect(native.outputs).toEqual({ verdict: '${{ steps.native_verdict.outputs.verdict }}' })
    expect(verdict.if).toBe('always()')
    expect(verdict.run).toBe('node candidate/scripts/performance-native-verdict.mjs native-results/report.md.json')
    expect(verdict.env).toEqual({
      NATIVE_MEASUREMENTS: '${{ steps.native_measurements.outcome }}',
      NATIVE_COMPARISON: '${{ steps.native_comparison.outcome }}',
      NATIVE_RETAINED: '${{ steps.native_retained.outcome }}'
    })
    expect(steps.indexOf(verdict)).toBe(steps.length - 1)
    expect(steps.indexOf(steps.find(step => step.id === 'native_retained')!)).toBe(steps.length - 2)
  })
})

describe('Performance Check with advisory native timing', () => {
  const script = workflow.jobs.check.steps[0].run!
  const changes = (required: string, desktop: string) => ({ result: 'success', outputs: { required, desktop } })
  const gate = (native: Record<string, unknown>, compare: Record<string, unknown> = { result: 'success' }, state = changes('true', 'true')) =>
    spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH, RESULTS: JSON.stringify({ changes: state, compare, native }) }, encoding: 'utf8'
    }).status

  it('passes a native failure only with a timing-only verdict', () => {
    expect(gate({ result: 'failure', outputs: { verdict: 'timing-only' } })).toBe(0)
    expect(gate({ result: 'success', outputs: { verdict: 'pass' } })).toBe(0)
    for (const verdict of ['blocking', 'invalid', 'pass', '', undefined]) {
      expect(gate({ result: 'failure', outputs: { verdict } }), String(verdict)).not.toBe(0)
    }
    expect(gate({ result: 'failure' })).not.toBe(0)
  })

  it('never extends the advisory to cancellation, skips, Node or unaffected diffs', () => {
    const timingOnly = { outputs: { verdict: 'timing-only' } }
    for (const result of ['cancelled', 'skipped']) expect(gate({ ...timingOnly, result }), result).not.toBe(0)
    expect(gate({ result: 'success' }, { result: 'failure', outputs: { verdict: 'timing-only' } })).not.toBe(0)
    expect(gate({ ...timingOnly, result: 'failure' }, { result: 'success' }, changes('true', 'false'))).not.toBe(0)
    expect(gate({ ...timingOnly, result: 'failure' }, { result: 'skipped' }, changes('false', 'false'))).not.toBe(0)
  })
})
