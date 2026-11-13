#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Native millisecond rows are advisory while the shared hosted macOS runner cannot tell an
// identical build from itself (docs/performance-experiments/20261113-native-gate-noise.md).
// Only a complete, retained comparison whose every failing row is a timing row may pass
// the Performance Check. Missing or broken evidence, failed lanes and work rows
// (domNodes) still block: this classifies the result, it never re-measures or edits it.
const TIMING_METRIC = /(Ms\.(fixtureP95|\d+RunMax|threeRunMax)|\.singleMs)$/

export function isTimingMetric(metric) {
  return typeof metric === 'string' && TIMING_METRIC.test(metric)
}

export function nativeVerdict({ measurements, comparison, retained, report }) {
  if (measurements !== 'success' || retained !== 'success') return 'invalid'
  if (!report || !Array.isArray(report.rows) || report.rows.length === 0) return 'invalid'
  if (comparison === 'success') return report.passed === true && report.rows.every(row => row.status === 'pass') ? 'pass' : 'invalid'
  if (comparison !== 'failure' || report.passed !== false) return 'invalid'
  const failing = report.rows.filter(row => row.status !== 'pass')
  if (failing.length === 0) return 'invalid'
  return failing.every(row => row.status === 'regressed' && isTimingMetric(row.metric)) ? 'timing-only' : 'blocking'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let verdict = 'invalid'
  try {
    const [reportPath] = process.argv.slice(2)
    if (!reportPath) throw new Error('Usage: performance-native-verdict.mjs <report.md.json>')
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
    verdict = nativeVerdict({
      measurements: process.env.NATIVE_MEASUREMENTS,
      comparison: process.env.NATIVE_COMPARISON,
      retained: process.env.NATIVE_RETAINED,
      report
    })
  } catch (error) {
    console.error(error.message)
  }
  console.log(`native verdict: ${verdict}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\n`)
  if (process.env.GITHUB_STEP_SUMMARY && verdict === 'timing-only') {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n> Native timing regressions only: advisory while the native gate is unreliable on shared runners. Work rows, evidence and lane failures still block.\n')
  }
}
