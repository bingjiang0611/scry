import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBenchmarkCoverage } from './performance-report.mjs'

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
// 2 ms of headroom cannot survive one scheduler or page-fault spike: startup.recovery was measured
// with six 1.2–1.35 ms batches and one 5.4 ms batch whose work counter stayed at 4 files, and the
// same artifact repeated without the spike. The floor only affects sub-10 ms scenarios; each
// scenario's absolute ceiling is unchanged and work counters remain the primary gate.
export const FORMAL_SAMPLE_COUNT = 20
const NODE_TIMING_NOISE_MS = 10
export const timingCeiling = (baseline, absoluteBudget) => Math.min(absoluteBudget, baseline + Math.max(NODE_TIMING_NOISE_MS, baseline * 0.5))
const sameKeys = (left, right) => JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort())
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function comparePerformance(base, head, policy) {
  if (base.schema !== 1 || head.schema !== 1 || policy.schema !== 2) throw new Error('Unsupported benchmark schema')
  if (base.harness !== head.harness || !base.harness) throw new Error('Harness differs: run the same frozen fixture/config on both source revisions')
  if (JSON.stringify(base.environment) !== JSON.stringify(head.environment)) throw new Error('Environment differs: timings require the same runner and runtime')
  if (JSON.stringify(base.measurement) !== JSON.stringify(head.measurement) || base.measurement?.kind !== 'batch-mean-ms' || base.measurement.warmups !== 3 || base.measurement.samples !== FORMAL_SAMPLE_COUNT || base.measurement.iterationsPerSample !== 20 || base.measurement.interleaved !== true) throw new Error('Timing methodology differs or is missing')
  checkBenchmarkCoverage(policy)
  if (!sameKeys(base.results, policy.scenarios) || !sameKeys(head.results, policy.scenarios)) throw new Error('Missing or unexpected benchmark scenarios')
  const rows = []
  for (const [scenario, budget] of Object.entries(policy.scenarios)) {
    const before = base.results[scenario]
    const after = head.results[scenario]
    for (const result of [before, after]) {
      if (result.lane !== budget.lane || result.workload !== budget.workload || result.iterations !== budget.iterations || result.warmups !== budget.warmups || result.samples !== budget.samples) {
        throw new Error(`Scenario methodology differs: ${scenario}`)
      }
      if (result.outcome !== 'completed') throw new Error(`Missing successful outcome: ${scenario}`)
      if (!sameKeys(result.counters, budget.counters)) throw new Error(`Counter coverage differs: ${scenario}`)
    }
    for (const [metric, ceiling] of Object.entries(budget.counters)) {
      const baseline = before.counters[metric]
      const candidate = after.counters[metric]
      if (![baseline, candidate, ceiling].every(finite)) throw new Error(`Invalid counter: ${scenario}.${metric}`)
      // Bytes may vary slightly with serialization metadata; cardinality counters cannot grow.
      const relativeCeiling = metric === 'bytes' ? baseline * 1.05 : baseline
      const preservesWork = ['bytes', 'messages'].includes(metric) || candidate === baseline
      rows.push({ scenario, metric, baseline, candidate, ceiling: Math.min(ceiling, relativeCeiling), status: preservesWork && candidate <= ceiling && candidate <= relativeCeiling ? 'pass' : 'regressed' })
    }
    const minSamples = budget.samples
    if (!Number.isInteger(minSamples) || minSamples < 1 || ![before, after].every(result => Array.isArray(result.durationMs) && result.durationMs.length === minSamples && result.durationMs.every(finite)) || !finite(budget.p95Ms)) throw new Error(`Missing/invalid timing samples: ${scenario}`)
    const baseline = p95(before.durationMs)
    const candidate = p95(after.durationMs)
    const ceiling = timingCeiling(baseline, budget.p95Ms)
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
    'Fixed local production-path workloads across all 16 path groups. Domain lanes measure computation/projection; disk/process lanes use temporary files, archives and Git. This is not native UI paint, network wire bytes, real Provider latency or real-device acceptance.',
    `Formal ABAB retains all ${FORMAL_SAMPLE_COUNT} samples per scenario in A1,B1…A20,B20 order with the original workload, warmups and iterations. Git/file stage timings are nonexclusive diagnostics; counter ceilings, absolute budgets and the P95 threshold formula are unchanged.`,
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
