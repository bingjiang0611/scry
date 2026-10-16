#!/usr/bin/env node
// Rank real-use hotspots from one or more single-build baselines produced by
// `node scripts/performance-report.mjs baseline <snapshot> <build> <out.json>`.
// Read-only: it never touches userData. Output is a ranking aid, not a verdict:
// journal timings come from one machine under whatever load it had at the time.
import { readFileSync } from 'node:fs'

const [, , ...inputs] = process.argv
if (inputs.length === 0) {
  console.error('Usage: journal-hotspots.mjs <baseline.json...>')
  process.exit(2)
}

// The end-to-end wait for the first provider output includes model latency, which is not
// Scry code; rank it separately so "the LLM is slow" never hides a Scry-side cost. Its
// stage.* deltas (git baseline, run registration, process launch) ARE Scry work and stay
// in the Scry ranking.
const providerBound = (operation, metric) => /^agent\.first_(text|provider_trace)$/.test(operation) && metric === 'durationMs'
const minimumSamples = 5

for (const input of inputs) {
  const report = JSON.parse(readFileSync(input, 'utf8'))
  if (report.kind !== 'single-build-baseline') throw new Error(`${input} is not a single-build baseline`)
  const rows = []
  for (const path of report.paths) for (const group of path.workloads) {
    if (group.unit !== 'ms' || group.completed < minimumSamples || group.p50 === null) continue
    rows.push({
      path: path.id, operation: group.operation, provider: group.provider, metric: group.metric,
      n: group.completed, sessions: group.sessions, p50: group.p50, p95: group.p95,
      // Median time users spent in this operation over the recording window.
      totalSeconds: (group.p50 * group.completed) / 1000,
      tailRatio: group.p50 > 0 ? group.p95 / group.p50 : null,
      workload: group.workload, owner: providerBound(group.operation, group.metric) ? 'provider' : 'scry'
    })
  }
  const format = value => value === null ? 'n/a' : value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  const table = (title, selected) => {
    console.log(`\n### ${title}\n`)
    console.log('| Path | Operation | Metric | Workload | n | p50 ms | p95 ms | p95/p50 | Σp50 s |')
    console.log('|---|---|---|---|---:|---:|---:|---:|---:|')
    for (const row of selected) console.log(`| ${row.path} | ${row.operation} (${row.provider}) | ${row.metric} | ${row.workload.length > 48 ? `${row.workload.slice(0, 47)}…` : row.workload} | ${row.n} | ${format(row.p50)} | ${format(row.p95)} | ${format(row.tailRatio)} | ${format(row.totalSeconds)} |`)
  }
  const scry = rows.filter(row => row.owner === 'scry')
  console.log(`## Build ${report.build.slice(0, 12)} · ${report.selection.records} records · maturity ${report.maturity.reasons.join(', ')}`)
  console.log(`Coverage ${report.coverage.observedPaths}/${report.coverage.totalPaths}; unobserved paths: ${report.coverage.unavailablePaths.join(', ') || 'none'}`)
  table('Scry-side: most total user time (p50 × n)', [...scry].sort((a, b) => b.totalSeconds - a.totalSeconds).slice(0, 12))
  table('Scry-side: worst tail (p95)', [...scry].sort((a, b) => b.p95 - a.p95).slice(0, 8))
  table('Scry-side: most erratic (p95/p50, p50 ≥ 50 ms)', scry.filter(row => row.p50 >= 50).sort((a, b) => b.tailRatio - a.tailRatio).slice(0, 6))
  table('Provider-bound (not directly Scry code)', rows.filter(row => row.owner === 'provider').sort((a, b) => b.p50 - a.p50))
}
