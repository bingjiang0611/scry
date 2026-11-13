#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { comparePerformance, formatComparison, FORMAL_SAMPLE_COUNT } from './performance-compare.mjs'
import { sideBatchId, validateBatchSamples, validateStageTotals } from './performance-abab-protocol.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const policy = JSON.parse(readFileSync(join(root, 'scripts/performance-budgets.json'), 'utf8'))
const scenarios = Object.keys(policy.scenarios)
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export function summarizeAbab(output) {
  const directory = resolve(output)
  try {
    const summary = readJson(join(directory, 'summary.json'))
    if (summary.status !== 'completed') throw new Error(`ABAB measurement did not complete: ${summary.errors.join('; ')}`)
    const baseline = readJson(join(directory, 'baseline.json'))
    const candidate = readJson(join(directory, 'candidate.json'))
    for (const [side, artifact] of [['baseline', baseline], ['candidate', candidate]]) {
      validateBatchSamples(artifact.results, scenarios)
      if (artifact.diagnostics.batches.length !== scenarios.length * FORMAL_SAMPLE_COUNT) throw new Error('Incomplete ABAB batch diagnostics')
      for (const scenario of scenarios) {
        const batches = artifact.diagnostics.batches.filter(batch => batch.scenario === scenario)
        if (batches.length !== FORMAL_SAMPLE_COUNT) throw new Error(`Missing ABAB stage diagnostics: ${scenario}`)
        for (const [index, batch] of batches.entries()) {
          if (batch.side !== side || batch.batchId !== sideBatchId(side, index + 1)) throw new Error('ABAB batch diagnostic identity differs')
          validateStageTotals(batch)
          if ((policy.scenarios[scenario].lane === 'disk' || scenario === 'source-control.diff') && !batch.stageTotals['file-operation']?.count) throw new Error(`Missing file stage evidence: ${scenario}`)
          if (scenario === 'source-control.diff' && !batch.stageTotals['git-command']?.count) throw new Error('Missing Git stage evidence')
        }
      }
    }
    const report = comparePerformance(baseline, candidate, policy)
    writeFileSync(join(directory, 'report.md'), formatComparison(report))
    writeFileSync(join(directory, 'report.md.json'), JSON.stringify(report, null, 2))
    return report.passed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeFileSync(join(directory, 'report.md'), `# Node ABAB measurement unavailable\n\n${message}\n`)
    writeFileSync(join(directory, 'measurement-failure.json'), JSON.stringify({ status: 'measurement-failure', error: message }, null, 2))
    return false
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2]
  if (!output) throw new Error('Usage: performance-abab-report.mjs <performance-results>')
  if (!summarizeAbab(output)) process.exitCode = 1
}
