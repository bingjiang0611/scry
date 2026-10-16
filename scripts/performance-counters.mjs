import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateObservations, counterPlatform } from './performance-ratchet.mjs'

// Shared collection contract for work-counter lanes. A collector is a Vitest file named
// `scripts/performance-counters/*.counters.test.ts`. It drives a production implementation
// on a fixed workload, asserts the functional result, repeats the same operation, and
// calls `writeCollector`. Outside collection runs the file is an ordinary correctness test.

export const defaultRepeats = 5
const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Run one fixed operation `times` times; each call returns integer counters by metric. */
export async function repeatCounters(times, operation) {
  const runs = {}
  for (let index = 0; index < times; index++) {
    const counters = await operation(index)
    for (const [metric, value] of Object.entries(counters)) (runs[metric] ??= []).push(value)
  }
  for (const values of Object.values(runs)) if (values.length !== times) throw new Error('Every repeat must report the same counters')
  return runs
}

export const measured = (meta, runs) => ({ ...meta, availability: 'measured', runs })
// Collectors that cannot observe a metric on this platform say so; never emit zero.
export const unavailable = (meta, reason) => ({ ...meta, availability: 'unavailable', reason })

export function writeCollector(name, observations) {
  validateObservations({ schema: 1, revision: 'collector', observations })
  const directory = process.env.SCRY_PERFORMANCE_COUNTERS_DIR
  if (directory) writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(observations, null, 2)}\n`)
}

export function mergeObservations(revision, groups) {
  const report = { schema: 1, revision, platform: counterPlatform(), observations: groups.flat() }
  return validateObservations(report)
}

const electronSuffix = '.electron.counters.test.ts'

// Electron's own Node runtime is the ABI that native modules such as better-sqlite3 are
// built for. Without an installed Electron binary those collectors run under plain Node
// and report their metrics unavailable themselves.
function electronBinary() {
  try {
    const binary = createRequire(import.meta.url)('electron')
    return typeof binary === 'string' && existsSync(binary) ? binary : null
  } catch { return null }
}

function runCollectors(executable, files, extraArgs, env) {
  if (files.length === 0) return
  const result = spawnSync(executable, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files, '--maxWorkers=1', ...extraArgs], { cwd: root, stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Counter collectors failed with status ${result.status}`)
}

function collect(output, filter) {
  const directory = mkdtempSync(join(tmpdir(), 'scry-counters-'))
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim().length > 0
    const files = readdirSync(join(root, 'scripts/performance-counters')).filter(file => file.endsWith('.counters.test.ts')).sort()
      .map(file => `scripts/performance-counters/${file}`).filter(file => !filter || file.includes(filter) || filter.includes(file))
    if (files.length === 0) throw new Error(`No counter collector matches ${filter}`)
    const env = { ...process.env, SCRY_PERFORMANCE_COUNTERS_DIR: directory }
    const electron = electronBinary()
    runCollectors(process.execPath, files.filter(file => !file.endsWith(electronSuffix) || !electron), [], env)
    if (electron) runCollectors(electron, files.filter(file => file.endsWith(electronSuffix)), [], { ...env, ELECTRON_RUN_AS_NODE: '1' })
    const groups = readdirSync(directory).filter(file => file.endsWith('.json')).sort().map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')))
    if (groups.length === 0) throw new Error('No counter collector produced observations')
    const report = mergeObservations(`${revision}${dirty ? '-dirty' : ''}`, groups)
    mkdirSync(dirname(resolve(output)), { recursive: true })
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`${report.observations.length} observations -> ${output}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'collect' && args[0]) collect(args[0], args[1])
    else if (command === 'merge' && args.length >= 3) {
      const [output, revision, ...inputs] = args
      const report = mergeObservations(revision, inputs.map(path => JSON.parse(readFileSync(path, 'utf8')).observations))
      writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    } else throw new Error('Usage: performance-counters.mjs collect <output.json> [vitest-filter] | merge <output.json> <revision> <observations.json...>')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
