import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRatchet, formatRatchet, layers, metricKey, validateObservations } from './performance-ratchet.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const defaultRepeats = 5

const text = value => typeof value === 'string' && value.trim().length > 0
const integer = value => Number.isSafeInteger(value) && value >= 1
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

function fail(message) {
  throw new Error(message)
}

export function parseArgs(argv) {
  const options = { repeats: defaultRepeats, profile: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = () => {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(`${argument} needs a value`)
      return argv[++index]
    }
    if (argument === '--scenario') options.scenario = value()
    else if (argument === '--layer') options.layer = value()
    else if (argument === '--compare') options.compare = value()
    else if (argument === '--repeats') {
      const parsed = Number(value())
      if (!integer(parsed)) fail('--repeats must be a positive safe integer')
      options.repeats = parsed
    } else if (argument === '--profile') options.profile = true
    else if (argument === '--out') options.out = value()
    else if (argument === '--help' || argument === '-h') options.help = true
    else fail(`Unknown option: ${argument}`)
  }
  if (options.scenario && !text(options.scenario)) fail('--scenario must not be empty')
  if (options.layer && !layers.includes(options.layer)) fail(`Unknown layer: ${options.layer}`)
  if (options.compare && !text(options.compare)) fail('--compare must not be empty')
  return options
}

export function filterObservations(report, { scenario, layer } = {}) {
  validateObservations(report)
  const observations = report.observations.filter(observation => (!scenario || observation.scenario === scenario) && (!layer || observation.layer === layer))
  if ((scenario || layer) && observations.length === 0) fail('No observations matched the requested scenario/layer filter')
  return { ...report, observations }
}

function mergeReports(reports, repeats) {
  if (reports.length === 0) fail('No counter collection reports were produced')
  const observations = new Map()
  for (const report of reports) {
    validateObservations(report)
    for (const observation of report.observations) {
      const key = metricKey(observation.scenario, observation.metric)
      const previous = observations.get(key)
      if (!previous) {
        observations.set(key, { ...observation, ...(observation.runs ? { runs: [...observation.runs] } : {}) })
      } else if (previous.availability !== observation.availability) fail(`Counter availability changed between repeats: ${key}`)
      else if (observation.availability === 'measured') previous.runs.push(...observation.runs)
    }
  }
  const merged = [...observations.values()].map(observation => observation.availability === 'measured'
    ? { ...observation, runs: observation.runs.slice(0, repeats) }
    : observation)
  for (const observation of merged) if (observation.availability === 'measured' && observation.runs.length !== repeats) fail(`Counter did not produce ${repeats} repeats: ${metricKey(observation.scenario, observation.metric)}`)
  const platforms = new Set(reports.map(report => report.platform))
  if (platforms.size !== 1) fail('Counter collections came from different platforms')
  return { schema: 1, revision: reports[reports.length - 1].revision, platform: reports[0].platform, observations: merged }
}

function profileEnvironment(profileDir) {
  mkdirSync(profileDir, { recursive: true })
  const existing = process.env.NODE_OPTIONS ?? ''
  return { ...process.env, NODE_OPTIONS: `${existing} --cpu-prof --cpu-prof-dir=${profileDir}`.trim() }
}

function collectOnce(repo, output, environment, scenario) {
  // macOS exposes temporary directories as /var while import.meta.url canonicalizes
  // them to /private/var. Pass the canonical script path so the collector's CLI guard runs.
  const script = realpathSync(join(repo, 'scripts/performance-counters.mjs'))
  const result = spawnSync(process.execPath, [script, 'collect', output, ...(scenario ? [scenario] : [])], {
    cwd: repo,
    env: environment,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`Counter collection failed in ${repo} with status ${result.status}`)
}

export function collectReport(repo, repeats, { profileDir, scenario } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'scry-performance-collection-'))
  const reports = []
  try {
    const batches = Math.ceil(repeats / defaultRepeats)
    const environment = profileDir ? profileEnvironment(profileDir) : process.env
    for (let index = 0; index < batches; index++) {
      const output = join(temporary, `collection-${index}.json`)
      collectOnce(repo, output, environment, scenario)
      reports.push(readJson(output))
    }
    return mergeReports(reports, repeats)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function assertComparable(left, right, key) {
  if (left.layer !== right.layer || left.unit !== right.unit || left.workload !== right.workload) fail(`Observation methodology differs: ${key}`)
}

export function compareObservations(baseline, candidate) {
  validateObservations(baseline)
  validateObservations(candidate)
  const before = new Map(baseline.observations.map(observation => [metricKey(observation.scenario, observation.metric), observation]))
  const after = new Map(candidate.observations.map(observation => [metricKey(observation.scenario, observation.metric), observation]))
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
  return keys.map(key => {
    const baselineObservation = before.get(key)
    const candidateObservation = after.get(key)
    if (!baselineObservation || !candidateObservation) return { key, status: 'missing', baseline: baselineObservation?.availability ?? null, candidate: candidateObservation?.availability ?? null }
    assertComparable(baselineObservation, candidateObservation, key)
    if (baselineObservation.availability !== 'measured' || candidateObservation.availability !== 'measured') {
      return { key, layer: candidateObservation.layer, unit: candidateObservation.unit, workload: candidateObservation.workload, status: 'unavailable', baseline: baselineObservation.availability, candidate: candidateObservation.availability }
    }
    const baselineValue = Math.max(...baselineObservation.runs)
    const candidateValue = Math.max(...candidateObservation.runs)
    const delta = candidateValue - baselineValue
    return {
      key,
      layer: candidateObservation.layer,
      unit: candidateObservation.unit,
      workload: candidateObservation.workload,
      baseline: baselineValue,
      candidate: candidateValue,
      baselineRuns: baselineObservation.runs,
      candidateRuns: candidateObservation.runs,
      delta,
      percent: baselineValue === 0 ? null : (delta / baselineValue) * 100,
      status: 'measured'
    }
  })
}

function freezeCounterHarness(candidate, baseline) {
  const files = [
    'scripts/performance-counters.mjs',
    'scripts/performance-ratchet.mjs',
    'scripts/performance-ratchet.json',
    'vitest.config.ts'
  ]
  for (const relative of files) cpSync(join(candidate, relative), join(baseline, relative), { force: true })
  // Replace, not overlay: a collector the candidate removed or renamed must not keep running on the baseline side.
  rmSync(join(baseline, 'scripts/performance-counters'), { recursive: true, force: true })
  cpSync(join(candidate, 'scripts/performance-counters'), join(baseline, 'scripts/performance-counters'), { recursive: true, force: true })
}

function createBaselineWorktree(candidate, reference) {
  const parent = mkdtempSync(join(tmpdir(), 'scry-performance-worktree-'))
  const worktree = join(parent, 'baseline')
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, reference], { cwd: candidate, stdio: 'inherit' })
    freezeCounterHarness(candidate, worktree)
    const modules = join(candidate, 'node_modules')
    if (!existsSync(modules)) fail('Candidate node_modules is required for comparison')
    symlinkSync(modules, join(worktree, 'node_modules'), 'dir')
    return { parent, worktree }
  } catch (error) {
    if (existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: candidate, stdio: 'inherit' })
    rmSync(parent, { recursive: true, force: true })
    throw error
  }
}

function removeBaselineWorktree(candidate, state) {
  const linkedModules = join(state.worktree, 'node_modules')
  if (existsSync(linkedModules)) unlinkSync(linkedModules)
  execFileSync('git', ['worktree', 'remove', '--force', state.worktree], { cwd: candidate, stdio: 'inherit' })
  rmSync(state.parent, { recursive: true, force: true })
  const remaining = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: candidate, encoding: 'utf8' })
  if (remaining.includes(state.worktree)) fail(`Temporary baseline worktree was not cleaned up: ${state.worktree}`)
  return remaining
}

function profileSummary(profileDirs) {
  const files = profileDirs.flatMap(directory => existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.cpuprofile')).map(file => join(directory, file)) : [])
  const counts = new Map()
  for (const file of files) {
    try {
      const profile = readJson(file)
      const nodes = new Map((profile.nodes ?? []).map(node => [node.id, node]))
      for (const sample of profile.samples ?? []) {
        const node = nodes.get(sample)
        if (!node) continue
        const location = `${node.callFrame?.functionName || '(anonymous)'} @ ${node.callFrame?.url || 'unknown'}`
        counts.set(location, (counts.get(location) ?? 0) + 1)
      }
    } catch {
      // A profile is diagnostic evidence. A malformed profile must not hide counters.
    }
  }
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5).map(([location, samples]) => ({ location, samples }))
  return { files, dominant: top[0]?.location ?? null, top }
}

function runRatchet(candidate, report, outputDirectory, options) {
  const ledger = readJson(join(candidate, 'scripts/performance-ratchet.json'))
  const metrics = Object.fromEntries(Object.entries(ledger.metrics).filter(([, entry]) => (!options.scenario || entry.scenario === options.scenario) && (!options.layer || entry.layer === options.layer)))
  const result = checkRatchet({ ...ledger, metrics }, report)
  writeFileSync(join(outputDirectory, 'ratchet.md'), `${formatRatchet(result)}\n`)
  return result
}

function formatValue(value) {
  if (value === null || value === undefined) return 'n/a'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function printTable(report, comparisons, ratchet, profile) {
  console.log(`Candidate: ${report.revision}`)
  if (comparisons) {
    console.log('Metric | Baseline | Candidate | Delta | Percent | Result')
    console.log('---|---:|---:|---:|---:|---')
    for (const row of comparisons) console.log(`${row.key} | ${formatValue(row.baseline)} | ${formatValue(row.candidate)} | ${formatValue(row.delta)} | ${row.percent === null || row.percent === undefined ? 'n/a' : `${row.percent.toFixed(1)}%`} | ${row.status}`)
  } else {
    console.log('Metric | Runs | Observed')
    console.log('---|---:|---:')
    for (const observation of report.observations) console.log(`${metricKey(observation.scenario, observation.metric)} | ${observation.runs?.length ?? 0} | ${observation.runs ? Math.max(...observation.runs) : `unavailable (${observation.reason})`}`)
  }
  console.log(`Ratchet: ${ratchet.passed ? 'passed' : 'failed'}`)
  if (profile?.dominant) console.log(`Profile dominant function: ${profile.dominant}`)
  else if (profile) console.log('Profile dominant function: unavailable')
}

export function measure(options, candidate = root) {
  const outputDirectory = resolve(candidate, options.out ?? mkdtempSync(join(tmpdir(), 'scry-performance-measure-')))
  mkdirSync(outputDirectory, { recursive: true })
  const profileDirs = options.profile ? [join(outputDirectory, 'profile-candidate')] : []
  const candidateReport = filterObservations(collectReport(candidate, options.repeats, { scenario: options.scenario, profileDir: profileDirs[0] }), options)
  writeFileSync(join(outputDirectory, 'candidate.json'), `${JSON.stringify(candidateReport, null, 2)}\n`)
  let baselineReport
  let comparisons
  let cleanup
  let baselineProfile
  if (options.compare) {
    const state = createBaselineWorktree(candidate, options.compare)
    try {
      baselineProfile = options.profile ? join(outputDirectory, 'profile-baseline') : undefined
      baselineReport = filterObservations(collectReport(state.worktree, options.repeats, { scenario: options.scenario, profileDir: baselineProfile }), options)
      comparisons = compareObservations(baselineReport, candidateReport)
      writeFileSync(join(outputDirectory, 'baseline.json'), `${JSON.stringify(baselineReport, null, 2)}\n`)
      writeFileSync(join(outputDirectory, 'comparison.json'), `${JSON.stringify({ schema: 1, baseline: baselineReport.revision, candidate: candidateReport.revision, rows: comparisons }, null, 2)}\n`)
    } finally {
      cleanup = { worktree: state.worktree, listedAfterCleanup: removeBaselineWorktree(candidate, state) }
    }
  }
  const ratchet = runRatchet(candidate, candidateReport, outputDirectory, options)
  const profile = options.profile ? profileSummary(profileDirs.concat(baselineProfile ? [baselineProfile] : [])) : undefined
  const result = { schema: 1, candidate: candidateReport, baseline: baselineReport ?? null, comparisons: comparisons ?? null, ratchet, profile: profile ?? null, worktreeCleanup: cleanup ?? null }
  writeFileSync(join(outputDirectory, 'measure.json'), `${JSON.stringify(result, null, 2)}\n`)
  printTable(candidateReport, comparisons, ratchet, profile)
  console.log(`Machine output: ${join(outputDirectory, 'measure.json')}`)
  return { ...result, outputDirectory }
}

function printHelp() {
  console.log('Usage: npm run performance:measure -- [--scenario <id>|--layer <layer>] [--compare <git-ref>] [--repeats N] [--profile] [--out <dir>]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) printHelp()
    else {
      const result = measure(options)
      if (!result.ratchet.passed) process.exitCode = 1
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
