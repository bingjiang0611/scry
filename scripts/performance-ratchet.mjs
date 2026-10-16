import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Work-counter ratchet. Counters measure how much work one fixed operation performs
// (IPC messages, bytes, file reads, subprocesses, React commits, layouts, instructions).
// They are gate candidates because they do not move with runner load the way
// milliseconds do. A counter may gate CI only after evidence proves it is stable,
// sensitive to injected extra work, and correlated with user-visible duration.
// Ceilings only move down automatically; raising one is a separate, approved change.

export const layers = ['main', 'ipc', 'io', 'ui', 'memory']
export const units = ['count', 'bytes', 'instructions']
const statuses = ['gating', 'candidate']
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0
const text = value => typeof value === 'string' && value.trim().length > 0
export const metricKey = (scenario, metric) => `${scenario}/${metric}`
// Counts can legitimately differ between OSes (e.g. stat calls, git internals), so a
// candidate baseline is only compared with observations from the same platform.
export const counterPlatform = () => `${process.platform}-${process.arch}`

function fail(message) { throw new Error(message) }

export function validateLedger(ledger) {
  if (ledger?.schema !== 1 || !ledger.metrics || typeof ledger.metrics !== 'object') fail('Unsupported ratchet ledger schema')
  for (const [key, entry] of Object.entries(ledger.metrics)) {
    if (key !== metricKey(entry.scenario, entry.metric) || !text(entry.scenario) || !text(entry.metric)) fail(`Ledger key must be scenario/metric: ${key}`)
    if (!layers.includes(entry.layer)) fail(`Unknown layer for ${key}: ${entry.layer}`)
    if (!units.includes(entry.unit)) fail(`Unknown unit for ${key}: ${entry.unit}`)
    if (!statuses.includes(entry.status)) fail(`Unknown status for ${key}: ${entry.status}`)
    if (!text(entry.workload) || !text(entry.source)) fail(`Ledger entry needs workload and source: ${key}`)
    if (!nonNegativeInteger(entry.tolerance)) fail(`Tolerance must be a non-negative integer: ${key}`)
    if (entry.status === 'gating') {
      if (!nonNegativeInteger(entry.ceiling)) fail(`Gating metric needs an integer ceiling: ${key}`)
      // Promotion evidence is a human-reviewed record; empty fields mean the three checks never ran.
      for (const check of ['stability', 'sensitivity', 'correlation']) if (!text(entry.evidence?.[check])) fail(`Gating metric lacks ${check} evidence: ${key}`)
    } else if (entry.ceiling !== null) fail(`Candidate metric must not carry a ceiling: ${key}`)
    // Candidate baselines: last accepted value per platform, reported but never gating.
    if (entry.baselines !== undefined && (typeof entry.baselines !== 'object' || entry.baselines === null || Array.isArray(entry.baselines)
      || !Object.entries(entry.baselines).every(([platform, value]) => text(platform) && nonNegativeInteger(value)))) fail(`Baselines must map platform to a non-negative integer: ${key}`)
    if (entry.raise !== undefined && !(nonNegativeInteger(entry.raise.from) && nonNegativeInteger(entry.raise.to) && entry.raise.to > entry.raise.from && text(entry.raise.reason))) fail(`Invalid raise record: ${key}`)
  }
  return ledger
}

export function validateObservations(report) {
  if (report?.schema !== 1 || !Array.isArray(report.observations) || !text(report.revision)) fail('Unsupported work-counter observation schema')
  if (report.platform !== undefined && !text(report.platform)) fail('Observation platform must be text when present')
  const seen = new Set()
  for (const observation of report.observations) {
    const key = metricKey(observation.scenario, observation.metric)
    if (seen.has(key)) fail(`Duplicate observation: ${key}`)
    seen.add(key)
    if (!layers.includes(observation.layer) || !units.includes(observation.unit) || !text(observation.workload) || !text(observation.source)) fail(`Incomplete observation metadata: ${key}`)
    if (observation.availability === 'unavailable') {
      // Missing evidence stays explicit; it is never recorded as zero work.
      if (!text(observation.reason) || observation.runs !== undefined) fail(`Unavailable observation needs a reason and no values: ${key}`)
    } else if (observation.availability === 'measured') {
      if (!Array.isArray(observation.runs) || observation.runs.length < 1 || !observation.runs.every(nonNegativeInteger)) fail(`Measured observation needs integer runs: ${key}`)
    } else fail(`Unknown availability for ${key}: ${observation.availability}`)
  }
  return report
}

/** Compare one candidate observation report against the ledger. */
export function checkRatchet(ledger, report) {
  validateLedger(ledger)
  validateObservations(report)
  const observations = new Map(report.observations.map(observation => [metricKey(observation.scenario, observation.metric), observation]))
  const rows = []
  for (const [key, entry] of Object.entries(ledger.metrics)) {
    const observation = observations.get(key)
    observations.delete(key)
    const row = { key, layer: entry.layer, unit: entry.unit, status: entry.status, ceiling: entry.ceiling, tolerance: entry.tolerance }
    if (!observation) { rows.push({ ...row, result: 'missing', gateFailed: entry.status === 'gating' }); continue }
    if (observation.workload !== entry.workload || observation.unit !== entry.unit || observation.layer !== entry.layer) fail(`Observation methodology differs from ledger: ${key}`)
    if (observation.availability === 'unavailable') { rows.push({ ...row, result: 'unavailable', reason: observation.reason, gateFailed: entry.status === 'gating' }); continue }
    const min = Math.min(...observation.runs)
    const value = Math.max(...observation.runs)
    const spread = value - min
    const measured = { ...row, value, min, runs: observation.runs.length, spread }
    if (entry.status === 'candidate') { rows.push({ ...measured, ...compareBaseline(entry, report.platform, value), gateFailed: false }); continue }
    // Same-revision repeats must agree within the reviewed tolerance; otherwise the
    // counter is not deterministic enough to block a PR, so the gate fails closed.
    if (spread > entry.tolerance) rows.push({ ...measured, result: 'unstable', gateFailed: true })
    else if (value > entry.ceiling + entry.tolerance) rows.push({ ...measured, result: 'regressed', gateFailed: true })
    else if (value < entry.ceiling) rows.push({ ...measured, result: 'tightenable', proposedCeiling: value, gateFailed: false })
    else rows.push({ ...measured, result: 'pass', gateFailed: false })
  }
  for (const [key, observation] of observations) rows.push({ key, layer: observation.layer, unit: observation.unit, status: 'unregistered', result: observation.availability === 'measured' ? 'unregistered' : 'unavailable', value: observation.runs ? Math.max(...observation.runs) : undefined, reason: observation.reason, gateFailed: false })
  return { schema: 1, revision: report.revision, platform: report.platform ?? null, passed: rows.every(row => !row.gateFailed), rows }
}

// Candidates never fail CI. A baseline turns "a number" into "worse/better than last
// accepted", so silent regressions in not-yet-gating counters become visible in reports.
function compareBaseline(entry, platform, value) {
  const baseline = platform === undefined ? undefined : entry.baselines?.[platform]
  if (baseline === undefined) return { result: 'candidate' }
  if (value > baseline + entry.tolerance) return { result: 'worse', baseline }
  if (value < baseline) return { result: 'better', baseline }
  return { result: 'unchanged', baseline }
}

/**
 * Lower gating ceilings to newly observed values and record or lower candidate baselines
 * for the report's platform. Never raises, promotes or removes.
 */
export function proposeTightening(ledger, report) {
  const result = checkRatchet(ledger, report)
  if (!result.passed) fail('Refusing to tighten from a failing ratchet report')
  const next = structuredClone(ledger)
  const changes = []
  for (const row of result.rows) if (row.result === 'tightenable') {
    changes.push({ key: row.key, from: next.metrics[row.key].ceiling, to: row.proposedCeiling })
    next.metrics[row.key].ceiling = row.proposedCeiling
    delete next.metrics[row.key].raise
  }
  for (const row of result.rows) if (row.status === 'candidate' && row.value !== undefined && report.platform !== undefined && (row.result === 'candidate' || row.result === 'better')) {
    const entry = next.metrics[row.key]
    changes.push({ key: row.key, platform: report.platform, baseline: { from: entry.baselines?.[report.platform] ?? null, to: row.value } })
    entry.baselines = { ...entry.baselines, [report.platform]: row.value }
  }
  return { ledger: next, changes, revision: report.revision }
}

/**
 * Guard a ledger edit between base and head. Tightening, new gates and new candidates are
 * free. Loosening (raise, wider tolerance, demotion, removal) needs an explicit approval
 * signal plus a raise record; changing what a key measures needs a new key.
 */
export function checkLedgerChange(base, head, { raiseApproved = false } = {}) {
  validateLedger(base)
  validateLedger(head)
  const violations = []
  const loosened = (key, reason) => { if (!raiseApproved) violations.push({ key, kind: 'needs-approval', reason }) }
  for (const [key, before] of Object.entries(base.metrics)) {
    const after = head.metrics[key]
    if (!after) { if (before.status === 'gating') loosened(key, 'gating metric removed'); continue }
    if (after.workload !== before.workload || after.unit !== before.unit || after.layer !== before.layer || after.scenario !== before.scenario || after.metric !== before.metric) {
      violations.push({ key, kind: 'redefined', reason: 'workload, unit or layer changed; register a new key instead' })
      continue
    }
    if (before.status === 'gating' && after.status === 'candidate') { loosened(key, 'gating metric demoted'); continue }
    if (before.status === 'gating') {
      if (after.tolerance > before.tolerance) loosened(key, `tolerance ${before.tolerance} -> ${after.tolerance}`)
      if (after.ceiling > before.ceiling) {
        if (after.raise?.from !== before.ceiling || after.raise?.to !== after.ceiling) violations.push({ key, kind: 'raise-record', reason: `raise ${before.ceiling} -> ${after.ceiling} needs a matching raise record` })
        loosened(key, `ceiling ${before.ceiling} -> ${after.ceiling}`)
      } else if (after.raise !== undefined && JSON.stringify(after.raise) !== JSON.stringify(before.raise)) {
        violations.push({ key, kind: 'raise-record', reason: 'raise record without a ceiling increase' })
      }
    }
    // Raising or dropping a candidate baseline would hide a `worse` report, so it is loosening too.
    for (const [platform, value] of Object.entries(before.baselines ?? {})) {
      const next = after.baselines?.[platform]
      if (next === undefined) loosened(key, `${platform} baseline removed`)
      else if (next > value) loosened(key, `${platform} baseline ${value} -> ${next}`)
    }
  }
  for (const [key, after] of Object.entries(head.metrics)) if (!base.metrics[key] && after.raise !== undefined) violations.push({ key, kind: 'raise-record', reason: 'new metric cannot carry a raise record' })
  return { passed: violations.length === 0, violations }
}

export function formatRatchet(report) {
  const value = row => row.value === undefined ? 'n/a' : String(row.value)
  const ceiling = row => row.ceiling === null || row.ceiling === undefined ? 'n/a' : `${row.ceiling}${row.tolerance ? ` (+${row.tolerance})` : ''}`
  const baseline = row => row.baseline === undefined ? 'n/a' : String(row.baseline)
  const worse = report.rows.filter(row => row.result === 'worse')
  return [
    '<!-- scry-performance-ratchet -->',
    '## Scry work-counter ratchet',
    `Candidate: \`${report.revision}\` · ${report.platform ?? 'platform unknown'} · ${report.passed ? 'passed' : 'failed'}`,
    ...(worse.length ? ['', `**${worse.length} candidate counter(s) worse than baseline (not gating):** ${worse.map(row => `${row.key} ${row.baseline} → ${row.value}`).join(', ')}`] : []),
    '',
    '| Metric | Layer | Status | Value | Baseline | Ceiling | Result |',
    '|---|---|---|---:|---:|---:|---|',
    ...report.rows.map(row => `| ${row.key} | ${row.layer} | ${row.status} | ${value(row)} | ${baseline(row)} | ${ceiling(row)} | ${row.result}${row.proposedCeiling !== undefined ? ` → ${row.proposedCeiling}` : ''}${row.reason ? ` (${row.reason})` : ''} |`),
    '',
    'Gating counters fail on regression, instability, or missing/unavailable evidence. Candidate counters are reported only until stability, sensitivity and correlation evidence is reviewed; `worse`/`better` compare them with the same-platform baseline. `tightenable` rows can lower the ceiling; ceilings never rise without an approved raise record.',
    ''
  ].join('\n')
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'check') {
      const [ledgerPath, observationsPath, output] = args
      if (!output) fail('Usage: performance-ratchet.mjs check <ledger.json> <observations.json> <report.md>')
      const report = checkRatchet(readJson(ledgerPath), readJson(observationsPath))
      const markdown = formatRatchet(report)
      writeFileSync(output, markdown)
      writeFileSync(`${output}.json`, JSON.stringify(report, null, 2))
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
      console.log(markdown)
      if (!report.passed) process.exitCode = 1
    } else if (command === 'propose') {
      const [ledgerPath, observationsPath, output] = args
      if (!output) fail('Usage: performance-ratchet.mjs propose <ledger.json> <observations.json> <next-ledger.json>')
      const proposal = proposeTightening(readJson(ledgerPath), readJson(observationsPath))
      writeFileSync(output, `${JSON.stringify(proposal.ledger, null, 2)}\n`)
      console.log(JSON.stringify({ revision: proposal.revision, changes: proposal.changes }, null, 2))
    } else if (command === 'guard') {
      const [basePath, headPath] = args
      if (!headPath) fail('Usage: performance-ratchet.mjs guard <base-ledger.json> <head-ledger.json>')
      const result = checkLedgerChange(readJson(basePath), readJson(headPath), { raiseApproved: process.env.SCRY_PERF_RAISE_APPROVED === '1' })
      console.log(JSON.stringify(result, null, 2))
      if (!result.passed) process.exitCode = 1
    } else fail('Usage: performance-ratchet.mjs <check|propose|guard> ...')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
