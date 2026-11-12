#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { comparePerformance, formatComparison } from './performance-compare.mjs'
import { validateBatchSamples } from './performance-abab-protocol.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const policy = JSON.parse(readFileSync(join(root, 'scripts/performance-budgets.json'), 'utf8'))
const scenarios = Object.keys(policy.scenarios)

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }

export function summarizeAbab(output, rounds = 3) {
  let failed = false
  for (let round = 1; round <= rounds; round++) {
    const directory = join(resolve(output), `round-${round}`)
    mkdirSync(directory, { recursive: true })
    const summaryPath = join(directory, 'summary.json')
    const summary = existsSync(summaryPath) ? readJson(summaryPath) : { schema: 1, round, status: 'failed', errors: ['round summary is missing'] }
    if (summary.status !== 'completed') failed = true
    const baselinePath = join(directory, 'baseline.json')
    const candidatePath = join(directory, 'candidate.json')
    if (!existsSync(baselinePath) || !existsSync(candidatePath)) {
      summary.comparisonStatus = 'measurement-failure'
      summary.comparisonError = 'complete baseline/candidate artifacts are required before comparison'
      failed = true
      writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
      continue
    }
    try {
      const baseline = readJson(baselinePath)
      const candidate = readJson(candidatePath)
      const samples = baseline.measurement?.samples
      if (!Number.isInteger(samples) || samples < 20) throw new Error('ABAB comparison requires at least twenty original samples')
      validateBatchSamples(baseline.results, scenarios, samples)
      validateBatchSamples(candidate.results, scenarios, samples)
      if (baseline.harness !== candidate.harness) throw new Error('ABAB frozen harness identity differs between artifacts')
      // Only the sampling contract changes. Every original sample participates
      // in P95; absolute and counter ceilings and the threshold formula do not.
      const samplingPolicy = { ...policy, scenarios: Object.fromEntries(Object.entries(policy.scenarios).map(([name, budget]) => [name, { ...budget, samples }])) }
      const report = comparePerformance(baseline, candidate, samplingPolicy, samples)
      report.measurement = baseline.measurement
      writeFileSync(join(directory, 'comparison.md'), formatComparison(report))
      writeFileSync(join(directory, 'comparison.json'), JSON.stringify(report, null, 2))
      summary.comparisonStatus = report.passed ? 'passed' : 'regressed'
      summary.comparisonReport = 'comparison.json'
      if (!report.passed) failed = true
    } catch (error) {
      summary.comparisonStatus = 'measurement-failure'
      summary.comparisonError = error instanceof Error ? error.message : String(error)
      failed = true
    }
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  }
  const overall = { schema: 1, status: failed ? 'failed' : 'completed', rounds }
  writeFileSync(join(resolve(output), 'comparison-summary.json'), JSON.stringify(overall, null, 2))
  return !failed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2]
  if (!output) throw new Error('Usage: performance-abab-report.mjs <performance-results> [rounds]')
  const ok = summarizeAbab(output, Number(process.argv[3] ?? 3))
  if (!ok) process.exitCode = 1
}
