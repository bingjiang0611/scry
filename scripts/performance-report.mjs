import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const catalogue = JSON.parse(readFileSync(join(root, 'scripts/performance-paths.json'), 'utf8'))
export const pathForOperation = name => catalogue.paths.find(path => path.operations.some(operation =>
  operation.endsWith(':') ? name.startsWith(operation) : name === operation))?.id ?? 'unmapped'
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? null
const bucket = value => value === 0 ? '0' : `2^${Math.floor(Math.log2(value))}`

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
  return [
    ...Object.entries(sample.main).map(([metric, value]) => ({ metric, value })),
    ...Object.entries(sample.counters).filter(([metric]) => metric.startsWith('trace')).map(([metric, value]) => ({ metric, value }))
  ].map(metric => ({ operation: 'app.resources', provider: 'none', workload: `window=${bucket(sample.windowMs)};runs=${sample.counters.activeRuns ?? 'unknown'}`, outcome: 'completed', ...metric }))
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
      state.closedSessions.add(record.session)
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

export async function readRecords(directory) {
  const records = []
  const issues = []
  for (const name of readdirSync(directory).filter(name => /^performance-[0-3]\.jsonl$/.test(name)).sort().reverse()) {
    const lines = createInterface({ input: createReadStream(join(directory, name)), crlfDelay: Infinity })
    let pending
    for await (const line of lines) {
      if (pending?.trim()) records.push(JSON.parse(pending))
      pending = line
    }
    if (pending?.trim()) {
      try { records.push(JSON.parse(pending)) }
      catch { issues.push({ file: name, reason: 'invalid-last-record; retained, comparison incomplete' }) }
    }
  }
  if (!records.length) throw new Error('No performance records. Enable local recording, use the app, then close it or wait for a flush.')
  return { records, issues }
}

export function checkCatalogue() {
  const errors = []
  const ids = new Set()
  for (const path of catalogue.paths) {
    if (ids.has(path.id)) errors.push(`Duplicate path: ${path.id}`)
    ids.add(path.id)
    for (const source of path.sources) if (!existsSync(join(root, source))) errors.push(`Missing source: ${source}`)
  }
  // Cover the actual privileged entrypoints, including source-control registration and the
  // enumerated remote namespace. This check deliberately fails on new unclassified channels.
  for (const source of ['src/main/index.ts', 'src/main/source-control/ipc.ts']) {
    const content = readFileSync(join(root, source), 'utf8')
    for (const [, channel] of content.matchAll(/(?:handleTrusted|register)\('([^']+)'/g)) {
      if (!catalogue.excludedChannels.includes(channel) && pathForOperation(`ipc.${channel}`) === 'unmapped') errors.push(`Unmapped channel: ${channel}`)
    }
  }
  for (const source of ['src/main/index.ts', 'src/main/live-trace-ingestion.ts']) {
    for (const [, name] of readFileSync(join(root, source), 'utf8').matchAll(/new PerformanceTrace\('([^']+)'/g)) {
      if (pathForOperation(name) === 'unmapped') errors.push(`Unmapped trace: ${name}`)
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return catalogue
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'inventory') {
      console.log(JSON.stringify(checkCatalogue(), null, 2))
    } else if (command === 'report') {
      const [directory, baseline, candidate] = args
      if (!directory || (baseline && !candidate) || (baseline && baseline === candidate)) throw new Error('Usage: report <performance-directory> [baseline-build candidate-build]; builds must differ')
      const { records, issues } = await readRecords(directory)
      if (baseline && (!records.some(record => record.build === baseline) || !records.some(record => record.build === candidate))) throw new Error('Requested build is absent; no comparison is possible')
      console.log(JSON.stringify(summarize(records, baseline, candidate, issues), null, 2))
    } else throw new Error('Usage: performance-report.mjs inventory | report <performance-directory> [baseline-build candidate-build]')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
