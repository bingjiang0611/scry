import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
const sameKeys = (left, right) => JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort())
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function comparePerformance(base, head, policy) {
  if (base.schema !== 1 || head.schema !== 1 || policy.schema !== 1) throw new Error('Unsupported benchmark schema')
  if (base.harness !== head.harness || !base.harness) throw new Error('Harness differs: run the same frozen fixture/config on both source revisions')
  if (JSON.stringify(base.environment) !== JSON.stringify(head.environment)) throw new Error('Environment differs: timings require the same runner and runtime')
  if (head.measurement?.kind !== 'batch-mean-ms' || head.measurement.iterationsPerSample !== 20 || JSON.stringify(base.measurement) !== JSON.stringify(head.measurement)) throw new Error('Timing methodology differs or is missing')
  if (Object.keys(policy.scenarios).length === 0) throw new Error('No performance budgets')
  if (!sameKeys(base.results, policy.scenarios) || !sameKeys(head.results, policy.scenarios)) throw new Error('Missing or unexpected benchmark scenarios')
  const rows = []
  for (const [scenario, budget] of Object.entries(policy.scenarios)) {
    const before = base.results[scenario]
    const after = head.results[scenario]
    if (!sameKeys(before.counters, budget.counters) || !sameKeys(after.counters, budget.counters)) throw new Error(`Counter coverage differs: ${scenario}`)
    for (const [metric, ceiling] of Object.entries(budget.counters)) {
      const baseline = before.counters[metric]
      const candidate = after.counters[metric]
      if (![baseline, candidate, ceiling].every(finite)) throw new Error(`Invalid counter: ${scenario}.${metric}`)
      // A 5% relative allowance for bytes only; event/message counts cannot silently grow.
      const relativeCeiling = metric === 'bytes' ? baseline * 1.05 : baseline
      rows.push({ scenario, metric, baseline, candidate, ceiling: Math.min(ceiling, relativeCeiling), status: candidate <= ceiling && candidate <= relativeCeiling ? 'pass' : 'regressed' })
    }
    if (![before, after].every(result => Array.isArray(result.durationMs) && result.durationMs.length >= 15 && result.durationMs.every(finite)) || !finite(budget.p95Ms)) throw new Error(`Missing/invalid timing samples: ${scenario}`)
    const baseline = p95(before.durationMs)
    const candidate = p95(after.durationMs)
    const ceiling = Math.min(budget.p95Ms, baseline + Math.max(2, baseline * 0.5))
    rows.push({ scenario, metric: 'batchMeanP95Ms', baseline, candidate, ceiling, status: candidate <= ceiling ? 'pass' : 'regressed' })
  }
  return { schema: 1, baseline: base.revision, candidate: head.revision, harness: head.harness, environment: head.environment, passed: rows.every(row => row.status === 'pass'), rows }
}

export function formatComparison(report) {
  const format = value => Number.isInteger(value) ? String(value) : value.toFixed(3)
  return [
    '<!-- scry-performance -->',
    '## Scry performance impact',
    `Baseline: \`${report.baseline}\` · candidate: \`${report.candidate}\``,
    '',
    '| Scenario | Metric | Baseline | Candidate | Change | Ceiling | Result |',
    '|---|---|---:|---:|---:|---:|---|',
    ...report.rows.map(row => `| ${row.scenario} | ${row.metric} | ${format(row.baseline)} | ${format(row.candidate)} | ${row.baseline === 0 ? 'n/a' : `${((row.candidate / row.baseline - 1) * 100).toFixed(1)}%`} | ${format(row.ceiling)} | ${row.status} |`),
    '',
    'Fixed offline production-path compute/transfer workloads, **not** native UI paint, network wire bytes, real Provider latency or real-device acceptance. Both sources use the same harness; original per-run samples are in the artifact.',
    'Counter ceilings plus base-relative checks prevent gradual drift. Timings use 15 fixed 20-iteration batch means after 3 warm batches, their p95, a 2 ms noise floor and 50% relative allowance (not individual-request p95). Never increase budgets just to make a failing PR green.',
    ''
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [basePath, headPath, policyPath, output] = process.argv.slice(2)
    if (!output) throw new Error('Usage: performance-compare.mjs <baseline.json> <candidate.json> <budgets.json> <report.md>')
    const report = comparePerformance(...[basePath, headPath, policyPath].map(path => JSON.parse(readFileSync(path, 'utf8'))))
    const markdown = formatComparison(report)
    writeFileSync(output, markdown)
    writeFileSync(`${output}.json`, JSON.stringify(report, null, 2))
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
    console.log(markdown)
    if (!report.passed) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
