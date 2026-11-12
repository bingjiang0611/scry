#!/usr/bin/env node
// S0-6: how long the App takes to become usable in daemon mode, with the daemon cold
// (not running) and already running, against the switch-off App as the control.
//
//   npm run build && node .agents/skills/scry-performance-climb/scripts/timing-run.mjs b4s-startup -- \
//     node scripts/b4s-startup-timing.mjs --samples 10 [--cases daemon-cold,daemon-running,switch-off] [--out file]
//
// N serial samples per case, cases interleaved round by round so a drifting machine
// affects each case alike; one unmeasured warm-up per case (first enrollment, caches).
// Reported per case: navigation start, run surface ready (window.scry.activeRuns answers),
// ready-after-navigation, each P50/P95, plus the App's own app.startup trace.
//
// The round is void (no percentile is published) when: the 1-minute load per core
// exceeded --max-load (default 0.5) at any reading, the host timing lock is not held by
// this process or an ancestor, any sample was invalid (e.g. the "running" daemon was
// replaced), or the round errored. This script is not part of any gate or ratchet.
import { renameSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeAllApps } from './b4v/app.mjs'
import { createFixture, disposeFixture, fixtureLeftovers, stopFixtureDaemon } from './b4v/fixture.mjs'
import { gitState, preflightChecks } from './b4v/preflight.mjs'
import { CASES, takeSample, timingLockHolder, warmUp } from './b4v/startup.mjs'
import { DEFAULT_MAX_LOAD_PER_CORE, loadVerdict, timingSummary, voidReasons } from './b4v/stats.mjs'

export function parseTimingArgs(argv) {
  const options = { samples: 10, cases: [...CASES], out: null, maxLoad: DEFAULT_MAX_LOAD_PER_CORE, keep: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--samples') options.samples = Number(next())
    else if (arg === '--cases') options.cases = next().split(',').map((item) => item.trim()).filter(Boolean)
    else if (arg === '--out') options.out = next()
    else if (arg === '--max-load') options.maxLoad = Number(next())
    else if (arg === '--keep') options.keep = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 200) throw new Error('--samples must be an integer in 1..200')
  if (!(options.maxLoad > 0)) throw new Error('--max-load must be positive')
  const unknown = options.cases.filter((name) => !CASES.includes(name))
  if (unknown.length > 0 || options.cases.length === 0) throw new Error(`--cases must name some of: ${CASES.join(', ')}`)
  return options
}

const reading = (label) => ({ label, at: new Date().toISOString(), load1: Number(loadavg()[0].toFixed(2)), cores: cpus().length })

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const options = parseTimingArgs(process.argv.slice(2))
  const out = resolve(options.out ?? join('/tmp', `scry-b4s-startup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
  const git = gitState(root)
  const result = { kind: 'b4s-startup-timing', version: 1, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    commit: git, options: { ...options, out }, timingLock: timingLockHolder(), preflight: preflightChecks(root, { git }),
    loads: [], cases: Object.fromEntries(options.cases.map((name) => [name, []])), fixtures: {}, error: null }
  const save = () => {
    const temporary = `${out}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`)
    renameSync(temporary, out)
  }
  const fixtures = {}
  try {
    const blocking = result.preflight.filter((check) => check.ok !== true && check.required !== false)
    if (blocking.length > 0) throw new Error(`preflight failed: ${blocking.map((check) => check.id).join(', ')}`)
    result.loads.push(reading('start'))
    for (const name of options.cases) {
      const fixture = createFixture(`time-${name}`.slice(0, 24))
      fixtures[name] = fixture
      result.fixtures[name] = { tempRoot: fixture.tempRoot, staticIsolation: fixture.staticIsolation }
      if (!fixture.staticIsolation.ok) throw new Error(`static isolation failed for ${name}`)
      // Unmeasured: first enrollment and cold caches; also where isolation is asserted
      // (while the warm-up App is alive), before any measured sample.
      const warmup = await warmUp({ root, fixture, name })
      result.fixtures[name].warmup = warmup
      if (!warmup.ok) throw new Error(`warm-up failed for ${name}: ${warmup.reason}`)
      save()
    }
    for (let index = 0; index < options.samples; index++) {
      for (const name of options.cases) {
        process.stderr.write(`[b4s] ${name} sample ${index + 1}/${options.samples}\n`)
        result.loads.push(reading(`${name}-${index}-before`))
        result.cases[name].push(await takeSample({ root, fixture: fixtures[name], name, index }))
        result.loads.push(reading(`${name}-${index}-after`))
        save()
      }
    }
  } catch (error) {
    result.error = String(error?.stack ?? error).slice(0, 4_000)
  } finally {
    for (const [name, fixture] of Object.entries(fixtures)) {
      const cleanup = {}
      try {
        cleanup.apps = await closeAllApps(fixture)
        cleanup.daemon = await stopFixtureDaemon(fixture)
        cleanup.leftovers = fixtureLeftovers(fixture)
      } catch (cleanupError) { cleanup.error = String(cleanupError?.message ?? cleanupError) }
      result.fixtures[name].cleanup = cleanup
      result.fixtures[name].disposed = disposeFixture(fixture, { keep: options.keep || Boolean(result.error) || Boolean(cleanup.error) })
    }
  }
  const load = loadVerdict(result.loads, options.maxLoad)
  const invalidSamples = Object.values(result.cases).flat().filter((sample) => sample.valid !== true).length
  const reasons = voidReasons({ load, underTimingLock: result.timingLock.held, invalidSamples, error: result.error })
  result.load = load
  result.summary = timingSummary(result.cases, { reasons })
  result.finishedAt = new Date().toISOString()
  save()
  process.stdout.write(`${JSON.stringify({ void: result.summary.void, reasons, summary: result.summary.cases, out })}\n`)
  process.exit(result.error ? 2 : result.summary.void ? 3 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[b4s] runner error: ${error?.stack ?? error}\n`)
    process.exit(1)
  })
}
