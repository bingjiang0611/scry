#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { validateObservations } from './performance-ratchet.mjs'

// CPU instruction counts for pure-Node production domain functions. The entry is bundled
// from the real src/ modules, so an instruction change reflects production code. Each
// sample is `instructions(setup + operation) - instructions(setup only)` in fresh
// processes; Node startup and fixture construction cancel out. V8 runs with --jitless and
// fixed seeds to remove optimizing-JIT and hash variance, so the number is interpreter
// work, not production wall time. Requires Linux `perf stat` (instructions:u) or valgrind;
// every other platform reports the metrics unavailable instead of zero.

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repeats = 5
const nodeFlags = ['--jitless', '--predictable', '--random-seed=1', '--hash-seed=1', '--single-threaded']
// A fixed minimal environment: host variables (NODE_OPTIONS, NODE_USE_ENV_PROXY, locale)
// change startup work and can enable modules that --jitless cannot run.
const measuredEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', TZ: 'UTC' }

const entrySource = `
import { sessionHistoryPage } from './src/main/session-history'
import { previewTraceItems } from './src/main/remote/trace-output'
import { buildAnalyticsStats } from './src/main/span-ledger'
const ts = '2026-01-01T00:00:00.000Z'
const events = Array.from({ length: 1000 }, (_, index) => ({ id: 'event-' + index, runId: 'run-fixed', ts, kind: 'model', stage: 'text_delta', messageId: 'message-fixed', text: 'fixed 中文 output\\n' }))
const history = Array.from({ length: 4000 }, (_, index) => ({ runId: 'turn-' + index, userText: 'fixed request ' + index, done: true, ts: index, items: [{ ...events[0], id: 'answer-' + index, runId: 'turn-' + index, stage: 'text' }] }))
const now = Date.parse(ts)
const results = Array.from({ length: 240 }, (_, index) => ({ tsStart: now - index * 3600000, providerId: 'codex', inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 2 }))
const operations = {
  none: () => 0,
  'history.page': () => sessionHistoryPage(history, { limit: 40 }).turns.length,
  'remote.trace.preview': () => previewTraceItems(events).items.length,
  'analytics.stats': () => buildAnalyticsStats({ nowMs: now, results, tools: results.map(row => ({ tsStart: row.tsStart })), dangers: [], mcp: [] }).tokenDaily.length
}
const operation = operations[process.argv[2]]
if (!operation) throw new Error('unknown operation ' + process.argv[2])
// A functional result is required, so a broken bundle cannot report cheap work.
if (process.argv[2] !== 'none' && !(operation() > 0)) throw new Error('operation produced no result')
`

export const specs = [
  { scenario: 'history.page', workload: 'history-turns=4000;page=40' },
  { scenario: 'remote.trace.preview', workload: 'trace-events=1000;unicode=true' },
  { scenario: 'analytics.stats', workload: 'analytics-results=240;days=90' }
]
const source = 'esbuild bundle of production src/ modules; Node --jitless fixed seeds; instructions(setup+op) - instructions(setup)'
const meta = spec => ({ ...spec, metric: 'cpu.instructions', layer: 'main', unit: 'instructions', source })

const which = command => {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function perfCount(perf, bundle, operation) {
  const result = spawnSync(perf, ['stat', '-x,', '-e', 'instructions:u', '--', process.execPath, ...nodeFlags, bundle, operation], { encoding: 'utf8', env: measuredEnv })
  if (result.status !== 0) return null
  const line = (result.stderr ?? '').split(/\r?\n/).find(row => row.includes('instructions:u'))
  const value = Number(line?.split(',')[0])
  return Number.isSafeInteger(value) ? value : null
}

function callgrindCount(valgrind, bundle, operation, directory) {
  const output = join(directory, `callgrind-${operation}.out`)
  const result = spawnSync(valgrind, ['--tool=callgrind', `--callgrind-out-file=${output}`, process.execPath, ...nodeFlags, bundle, operation], { encoding: 'utf8', env: measuredEnv })
  if (result.status !== 0) return null
  const match = spawnSync('sh', ['-c', `grep -m1 '^summary:' "${output}"`], { encoding: 'utf8' }).stdout.match(/^summary:\s*(\d+)/)
  const value = Number(match?.[1])
  return Number.isSafeInteger(value) ? value : null
}

/** Bundle the fixed entry against production src/ without writing into the repository. */
export async function bundleEntry(directory) {
  const outfile = join(directory, 'entry.mjs')
  await build({ stdin: { contents: entrySource, resolveDir: root, loader: 'ts', sourcefile: 'instructions-entry.ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' })
  return outfile
}

/** Run one bundled operation without a counter; proves the measured code path works. */
export function runOperation(bundle, operation) {
  return spawnSync(process.execPath, [...nodeFlags, bundle, operation], { encoding: 'utf8', env: measuredEnv })
}

export async function measureInstructions() {
  if (process.platform !== 'linux') return specs.map(spec => ({ ...meta(spec), availability: 'unavailable', reason: `instruction counters need Linux perf or valgrind; this host is ${process.platform}` }))
  const perf = which('perf')
  const valgrind = which('valgrind')
  const directory = mkdtempSync(join(tmpdir(), 'scry-instructions-'))
  try {
    const bundle = await bundleEntry(directory)
    const backend = perf && perfCount(perf, bundle, 'none') !== null ? 'perf' : valgrind ? 'callgrind' : null
    if (!backend) return specs.map(spec => ({ ...meta(spec), availability: 'unavailable', reason: perf ? 'perf is installed but instructions:u is not permitted, and valgrind is absent' : 'neither perf nor valgrind is installed' }))
    const sample = operation => backend === 'perf' ? perfCount(perf, bundle, operation) : callgrindCount(valgrind, bundle, operation, directory)
    return specs.map(spec => {
      const runs = []
      for (let index = 0; index < repeats; index++) {
        const withOperation = sample(spec.scenario)
        const setupOnly = sample('none')
        if (withOperation === null || setupOnly === null) return { ...meta(spec), availability: 'unavailable', reason: `${backend} returned no parseable count` }
        // Startup noise can exceed a tiny operation; a negative difference is not a measurement.
        if (withOperation < setupOnly) return { ...meta(spec), availability: 'unavailable', reason: `${backend} startup noise exceeded the operation (${withOperation} < ${setupOnly})` }
        runs.push(withOperation - setupOnly)
      }
      return { ...meta(spec), source: `${source}; backend=${backend}`, availability: 'measured', runs }
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = validateObservations({ schema: 1, revision: process.env.SCRY_PERFORMANCE_REVISION ?? 'unknown', observations: await measureInstructions() })
    const output = process.argv[2]
    if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
