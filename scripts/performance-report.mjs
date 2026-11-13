import { existsSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogue, pathForOperation, checkCatalogue } from './performance-path-catalogue.mjs'
import { readRecords, snapshotPerformanceDirectory } from './performance-journal.mjs'

export { catalogue, pathForOperation, checkCatalogue, checkBenchmarkCoverage } from './performance-path-catalogue.mjs'
export { readRecords, snapshotPerformanceDirectory } from './performance-journal.mjs'

const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? null
const bucket = value => value === 0 ? '0' : `2^${Math.floor(Math.log2(value))}`
const PATH_IDS = new Set(catalogue.paths.map(path => path.id))

export function observations(record) {
  const { kind, sample } = record.observation
  if (kind === 'health') return []
  if (kind === 'trace') {
    // Retain coarse workload strata; never mix 40-turn history with 4,000-turn history.
    const counts = { ...Object.assign({}, ...sample.checkpoints.map(point => point.counters ?? {})), ...sample.counters }
    const workload = Object.entries(counts).filter(([, value]) => Number.isFinite(value) && value >= 0)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${bucket(value)}`).join(';') || 'unmeasured'
    const common = { operation: sample.name, provider: sample.dimensions.provider ?? 'unmeasured', workload, outcome: sample.outcome }
    return [
      { ...common, metric: 'durationMs', value: sample.durationMs },
      ...sample.checkpoints.map(point => ({ ...common, metric: `stage.${point.stage}.deltaMs`, value: point.deltaMs }))
    ]
  }
  if (kind === 'benchmark') {
    const benchmarkP95 = values => quantile(values, 0.95)
    return Object.entries(sample.results ?? {}).flatMap(([name, result]) => {
      const common = {
        operation: name, provider: 'none',
        workload: `${result.lane ?? 'unknown'};${result.workload ?? 'unmeasured'}`,
        outcome: result.outcome ?? 'unknown'
      }
      const timing = Array.isArray(result.durationMs) && result.durationMs.length > 0
        ? [{ ...common, metric: 'batchMeanP95Ms', value: benchmarkP95(result.durationMs) }]
        : []
      const counters = Object.entries(result.counters ?? {}).map(([metric, value]) => ({ ...common, metric: `counter.${metric}`, value }))
      return [...timing, ...counters]
    })
  }
  if (kind === 'renderer') {
    const metrics = { maxFrameGapMs: sample.maxFrameGapMs }
    if (sample.frameCount > 0) metrics.slowFrameRatio = sample.slowFrameCount / sample.frameCount
    if (sample.longTaskSupported === true) {
      metrics.longTaskRatio = sample.longTaskTotalMs / sample.windowMs
      metrics.longestLongTaskMs = sample.longestLongTaskMs
    }
    return Object.entries(metrics).filter(([, value]) => value !== undefined)
      .map(([metric, value]) => ({ operation: 'renderer.resources', provider: 'none', workload: `window=${bucket(sample.windowMs)}`, outcome: 'completed', metric, value }))
  }
  const processMetrics = new Map()
  for (const process of sample.processes) {
    for (const field of ['cpuPercentOfOneCore', 'workingSetBytes', 'peakWorkingSetBytes', 'privateBytes']) {
      const metric = `process.${process.type}.${field}`
      processMetrics.set(metric, (processMetrics.get(metric) ?? 0) + process[field])
    }
  }
  return [
    ...[...processMetrics].map(([metric, value]) => ({ metric, value })),
    ...Object.entries(sample.main).map(([metric, value]) => ({ metric, value })),
    ...Object.entries(sample.counters).filter(([metric]) => metric.startsWith('trace')).map(([metric, value]) => ({ metric, value }))
  ].map(metric => ({ operation: 'app.resources', provider: 'none', workload: `window=${bucket(sample.windowMs)};runs=${sample.counters.activeRuns ?? 'unknown'}`, outcome: 'completed', ...metric }))
}

const environmentOf = record => [record.mode, record.platform, record.osRelease ?? 'unknown', record.arch, record.cpu, record.runtime].join('|')
const emptyPercentiles = values => ({ p50: quantile(values, 0.5), p75: quantile(values, 0.75), p95: quantile(values, 0.95) })

export function summarizeBaseline(records, build, issues = [], source = {}) {
  const selected = records.filter(record => record.build === build)
  if (!selected.length) throw new Error(`Requested build is absent: ${build}`)
  const selection = { requestedBuild: build, matched: true, records: selected.length }
  const paths = new Map(catalogue.paths.map(path => [path.id, {
    id: path.id, title: path.title, status: 'unavailable', samples: 0, completed: 0,
    outcomes: {}, workloads: new Map(), environments: new Set(), sessions: new Set()
  }]))
  const health = new Map()
  const observedBuilds = new Map()
  const observedVersions = new Set()
  const observedEnvironments = new Set()
  const addOutcome = (target, outcome) => { target.outcomes[outcome] = (target.outcomes[outcome] ?? 0) + 1 }
  const addRecord = record => {
    const countedPaths = new Set()
    for (const item of observations(record)) {
      const pathId = pathForOperation(item.operation)
      if (!PATH_IDS.has(pathId)) continue
      const path = paths.get(pathId)
      const { operation, provider, workload, metric, outcome, value } = item
      const key = JSON.stringify([operation, provider, environmentOf(record), workload, metric])
      const group = path.workloads.get(key) ?? {
        operation, provider, environment: environmentOf(record), workload, metric,
        unit: metric.endsWith('Ms') ? 'ms' : metric.endsWith('Bytes') ? 'bytes' : metric.endsWith('Ratio') ? 'ratio' : metric.endsWith('PercentOfOneCore') ? 'percent-of-one-core' : 'count',
        samples: 0, completed: 0, outcomes: {}, sessions: new Set(), durations: []
      }
      group.samples++
      group.sessions.add(record.session)
      addOutcome(group, outcome)
      if (outcome === 'completed' && Number.isFinite(value) && value >= 0) {
        group.completed++
        group.durations.push(value)
      }
      // One observation may expose several metrics; it is still one recorded window/call.
      if (!countedPaths.has(pathId)) {
        countedPaths.add(pathId)
        path.samples++
        path.sessions.add(record.session)
        path.environments.add(environmentOf(record))
        addOutcome(path, outcome)
        if (outcome === 'completed') path.completed++
      }
      path.workloads.set(key, group)
    }
  }
  for (const record of selected) {
    observedBuilds.set(record.build, (observedBuilds.get(record.build) ?? 0) + 1)
    if (record.version) observedVersions.add(record.version)
    observedEnvironments.add(environmentOf(record))
    const state = health.get(record.session) ?? { sessions: new Set(), closedSessions: new Set(), dropped: null }
    state.sessions.add(record.session)
    if (record.observation?.kind === 'health') {
      if (record.observation.sample?.closed === true) state.closedSessions.add(record.session)
      const dropped = record.observation.sample?.droppedRecords
      if (Number.isFinite(dropped)) state.dropped = Math.max(state.dropped ?? 0, dropped)
    }
    if (record.observation?.kind === 'resource') {
      const dropped = record.observation.sample.counters.performanceDroppedRecords
      if (Number.isFinite(dropped)) state.dropped = Math.max(state.dropped ?? 0, dropped)
    }
    health.set(record.session, state)
    addRecord(record)
  }
  const buildHealth = [...health.values()].reduce((acc, state) => ({
    dropped: acc.dropped === null || state.dropped === null ? null : acc.dropped + state.dropped,
    openSessions: acc.openSessions + [...state.sessions].filter(session => !state.closedSessions.has(session)).length,
    sessions: acc.sessions + state.sessions.size
  }), { dropped: 0, openSessions: 0, sessions: 0 })
  const provisionalReasons = []
  if (buildHealth.openSessions > 0) provisionalReasons.push('live-session-not-closed')
  if (buildHealth.dropped > 0) provisionalReasons.push('dropped-records')
  if (buildHealth.dropped === null) provisionalReasons.push('loss-counters-unavailable')
  if (issues.length > 0) provisionalReasons.push('journal-parse-issues')
  if (selected.length < 30) provisionalReasons.push('short-recording')
  if (!selection.matched) provisionalReasons.push('build-id-not-observed')
  if (buildHealth.sessions < 2) provisionalReasons.push('single-session')
  if (!provisionalReasons.length) provisionalReasons.push('single-build-observation-is-not-release-comparison')
  const pathReports = [...paths.values()].map(path => {
    const workloads = [...path.workloads.values()].map(group => {
      const { durations, sessions, ...report } = group
      return { ...report, sessions: sessions.size, ...emptyPercentiles(durations) }
    })
    const status = path.samples === 0 ? 'unavailable' : 'observed-provisional'
    return { ...path, status, sessions: path.sessions.size, environments: [...path.environments], workloads }
  })
  return {
    schema: 1, kind: 'single-build-baseline', build, selection,
    source: { ...source, immutable: false },
    unavailableMetrics: { rendererLongTasks: selected.filter(record => record.observation.kind === 'renderer' && record.observation.sample.longTaskSupported !== true).length },
    observedBuilds: [...observedBuilds].map(([id, samples]) => ({ build: id, samples })),
    observedVersions: [...observedVersions],
    observedEnvironments: [...observedEnvironments],
    dataHealth: { ...buildHealth, issues },
    maturity: { status: 'provisional', reasons: provisionalReasons },
    coverage: {
      totalPaths: catalogue.paths.length,
      observedPaths: pathReports.filter(path => path.status !== 'unavailable').length,
      unavailablePaths: pathReports.filter(path => path.status === 'unavailable').map(path => path.id),
      status: pathReports.every(path => path.status !== 'unavailable') ? 'all-paths-observed-provisional' : 'partial-unavailable'
    },
    paths: pathReports.map(({ workloads, ...path }) => ({ ...path, workloads })),
    interpretation: 'Single-build observational baseline, not a mature SLO or release comparison. Path coverage means any recorded operation, including background polling; it does not prove completed user journeys. IPC settlement is not visible readiness or business success. Metric percentiles use their stated units. Missing/unsupported metrics are unavailable, not zero.'
  }
}

export function summarize(records, baseline, candidate, issues = []) {
  const groups = new Map()
  const builds = new Map()
  const health = new Map()
  const outcomes = new Map()
  for (const record of records) {
    if (record.schema !== 1) throw new Error('Unsupported performance schema')
    if (!builds.has(record.build)) builds.set(record.build, { build: record.build, version: record.version, mode: record.mode, samples: 0 })
    builds.get(record.build).samples++
    const state = health.get(record.build) ?? { dropped: 0, unsupportedLongTasks: 0, sessions: new Set(), closedSessions: new Set() }
    state.sessions.add(record.session)
    if (record.observation.kind === 'health') {
      state.dropped = Math.max(state.dropped, record.observation.sample.droppedRecords)
      if (record.observation.sample.closed === true) state.closedSessions.add(record.session)
    }
    if (record.observation.kind === 'resource') state.dropped = Math.max(state.dropped, record.observation.sample.counters.performanceDroppedRecords ?? 0)
    if (record.observation.kind === 'renderer' && record.observation.sample.longTaskSupported !== true) state.unsupportedLongTasks++
    health.set(record.build, state)
    if (record.build !== baseline && record.build !== candidate) continue
    const environment = [record.mode, record.platform, record.osRelease ?? 'unknown', record.arch, record.cpu, record.runtime].join('|')
    if (record.observation.kind === 'trace') {
      const sample = record.observation.sample
      const key = JSON.stringify([sample.name, sample.dimensions.provider ?? 'unmeasured', environment])
      const group = outcomes.get(key) ?? { operation: sample.name, provider: sample.dimensions.provider ?? 'unmeasured', environment, builds: {} }
      const counts = group.builds[record.build] ?? {}
      counts[sample.outcome] = (counts[sample.outcome] ?? 0) + 1
      group.builds[record.build] = counts
      outcomes.set(key, group)
    }
    for (const item of observations(record)) {
      if (!Number.isFinite(item.value) || item.value < 0) throw new Error('Invalid performance metric')
      const key = JSON.stringify([item.operation, item.provider, environment, item.workload, item.metric])
      const group = groups.get(key) ?? { path: pathForOperation(item.operation), operation: item.operation, provider: item.provider, environment, workload: item.workload, metric: item.metric, sides: {} }
      const side = group.sides[record.build] ?? { values: [], outcomes: {}, sessions: new Set() }
      side.outcomes[item.outcome] = (side.outcomes[item.outcome] ?? 0) + 1
      side.sessions.add(record.session)
      // Cancelled/error/unavailable waits are not successful latency observations.
      if (item.outcome === 'completed') side.values.push(item.value)
      group.sides[record.build] = side
      groups.set(key, group)
    }
  }
  const sideSummary = side => side ? {
    count: side.values.length, sessions: side.sessions.size, outcomes: side.outcomes,
    p50: quantile(side.values, 0.5), p75: quantile(side.values, 0.75), p95: quantile(side.values, 0.95)
  } : null
  const recordingHealth = Object.fromEntries([...health].map(([build, state]) => [build, {
    dropped: state.dropped,
    unsupportedLongTasks: state.unsupportedLongTasks,
    unclosedSessions: [...state.sessions].filter(session => !state.closedSessions.has(session)).length
  }]))
  const completionRegressed = group => {
    const counts = outcomes.get(JSON.stringify([group.operation, group.provider, group.environment]))?.builds
    const total = side => Object.values(side ?? {}).reduce((sum, count) => sum + count, 0)
    const before = total(counts?.[baseline])
    const after = total(counts?.[candidate])
    return before >= 30 && after >= 30 &&
      (after - (counts[candidate].completed ?? 0)) / after > (before - (counts[baseline].completed ?? 0)) / before + 0.02
  }
  const rows = [...groups.values()].map(({ sides, ...group }) => {
    const before = sideSummary(sides[baseline])
    const after = sideSummary(sides[candidate])
    let status = 'insufficient-data'
    let deltaPercent = null
    if (baseline === 'unfrozen-development' || candidate === 'unfrozen-development') status = 'unversioned-development'
    else if (issues.length || [baseline, candidate].some(build => recordingHealth[build]?.dropped || recordingHealth[build]?.unclosedSessions)) status = 'incomplete-recording'
    else if (completionRegressed(group)) status = 'completion-rate-regressed'
    else if (!before || !after) status = 'unmatched-workload-or-environment'
    else if (before.count >= 30 && after.count >= 30 && before.sessions >= 2 && after.sessions >= 2) {
      deltaPercent = before.p75 === 0 ? null : (after.p75 - before.p75) / before.p75 * 100
      const tolerance = Math.max(group.metric.endsWith('Ms') ? 2 : 0, before.p75 * 0.1)
      status = after.p75 > before.p75 + tolerance ? 'regressed' : after.p75 < before.p75 - tolerance ? 'improved' : 'no-material-change'
    }
    return { ...group, comparability: group.workload === 'unmeasured' ? 'workload-unmeasured' : 'coarse-workload-buckets', baseline: before, candidate: after, deltaPercent, status }
  })
  return {
    schema: 1, baseline, candidate, builds: [...builds.values()], recordingHealth, issues,
    interpretation: 'Observational local comparison, not causal proof. IPC completed means handler resolved, not business success or paint. Unmeasured workload/cache/network can confound results. Missing samples are never zero.',
    // Independent of workload: errors often occur before size counters are available.
    operationOutcomes: [...outcomes.values()],
    rows
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let [command, ...args] = process.argv.slice(2)
    // npm run performance:report forwards its arguments after the fixed `report` script name.
    if (command === 'report' && (args[0] === 'baseline' || args[0] === 'snapshot')) command = args.shift()
    if (command === 'inventory') {
      console.log(JSON.stringify(checkCatalogue(), null, 2))
    } else if (command === 'baseline') {
      const [directory, build, output] = args
      if (!directory || !build) throw new Error('Usage: baseline <performance-directory> <build-id> [output.json]')
      const { records, issues } = await readRecords(directory)
      const report = summarizeBaseline(records, build, issues, { directory, readOnlyInput: true, snapshot: existsSync(join(directory, 'snapshot-manifest.json')) })
      const text = JSON.stringify(report, null, 2)
      if (output) writeFileSync(output, text)
      console.log(text)
    } else if (command === 'snapshot') {
      const [source, target] = args
      console.log(JSON.stringify(snapshotPerformanceDirectory(source, target), null, 2))
    } else if (command === 'report') {
      const [directory, baseline, candidate] = args
      if (!directory || (baseline && !candidate) || (baseline && baseline === candidate)) throw new Error('Usage: report <performance-directory> [baseline-build candidate-build]; builds must differ')
      const { records, issues } = await readRecords(directory)
      if (!baseline) {
        console.log(JSON.stringify(summarize(records, undefined, undefined, issues), null, 2))
      } else {
        if (!records.some(record => record.build === baseline) || !records.some(record => record.build === candidate)) throw new Error('Requested build is absent; no comparison is possible')
        console.log(JSON.stringify(summarize(records, baseline, candidate, issues), null, 2))
      }
    } else throw new Error('Usage: performance-report.mjs inventory | baseline <performance-directory> <build-id> [output.json] | snapshot <performance-directory> <new-output-directory> | report <performance-directory> [baseline-build candidate-build]')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
