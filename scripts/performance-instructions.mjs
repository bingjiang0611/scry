#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// This is deliberately a standalone Node workload. It avoids Electron, SQLite and Provider
// processes so an instruction sample is at least a pure-Node domain envelope. `--jitless`
// removes optimizing-JIT variance, but includes interpreter overhead and is not production cost.
const operationSource = `
const history = Array.from({ length: 4000 }, (_, index) => ({ runId: 'turn-' + index, text: 'fixed request ' + index }))
const events = Array.from({ length: 1000 }, (_, index) => ({ stage: 'text_delta', text: 'fixed 中文 output\\n', id: 'event-' + index }))
const results = Array.from({ length: 240 }, (_, index) => ({ tsStart: index * 3600000, providerId: 'codex', inputTokens: 100, outputTokens: 40 }))
function historyPage() { return { turns: history.slice(-40), totalTurns: history.length, hasOlder: true } }
function archivePage() { return JSON.parse(JSON.stringify({ version: 3, turns: history.slice(-40) })) }
function analytics() {
  const byProvider = new Map()
  for (const row of results) byProvider.set(row.providerId, (byProvider.get(row.providerId) ?? 0) + row.inputTokens + row.outputTokens)
  return [...byProvider.entries()]
}
function remotePreview() {
  const out = []
  for (const event of events.slice(-256)) {
    if (!event.text) continue
    const previous = out[out.length - 1]
    if (previous) previous.text += event.text
    else out.push({ kind: 'output', text: event.text })
  }
  return out
}
const operations = { historyPage, archivePage, analytics, remotePreview }
operations[process.argv[1]]()
`

const specs = [
  { name: 'history.page', operation: 'historyPage', workload: 'history-turns=4000;page=40' },
  { name: 'persistence.archive', operation: 'archivePage', workload: 'archive-turns=120;page=40' },
  { name: 'analytics.stats', operation: 'analytics', workload: 'analytics-results=240;days=90' },
  { name: 'remote.trace.preview', operation: 'remotePreview', workload: 'trace-events=1000;unicode=true;preview=256' }
]
const repeats = 5
const unavailable = (spec, reason) => ({
  scenario: spec.name,
  metric: 'cpu.instructions',
  layer: 'main',
  unit: 'instructions',
  workload: spec.workload,
  source: 'Linux perf stat instructions:u or valgrind callgrind; standalone Node --jitless domain workload',
  availability: 'unavailable',
  reason
})
const measured = (spec, runs, source) => ({
  scenario: spec.name,
  metric: 'cpu.instructions',
  layer: 'main',
  unit: 'instructions',
  workload: spec.workload,
  source,
  availability: 'measured',
  runs
})

function perfBinary() {
  const result = spawnSync('sh', ['-c', 'command -v perf'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function parsePerf(stderr) {
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('instructions:u')) continue
    const value = Number(line.split(',')[0]?.replaceAll(',', '').trim())
    if (Number.isSafeInteger(value) && value >= 0) return value
  }
  return null
}

function runPerf(perf, operation) {
  const result = spawnSync(perf, [
    'stat', '-x,', '-e', 'instructions:u', '--', process.execPath, '--jitless', '--input-type=module', '-e', operationSource, operation
  ], { encoding: 'utf8' })
  const count = parsePerf(result.stderr ?? '')
  return result.status === 0 && count != null ? count : null
}

function callgrindBinary() {
  const result = spawnSync('sh', ['-c', 'command -v valgrind'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function runCallgrind(valgrind, directory, operation) {
  const output = join(directory, 'callgrind.out')
  const result = spawnSync(valgrind, [
    '--tool=callgrind', '--instr-atstart=yes', `--callgrind-out-file=${output}`,
    process.execPath, '--jitless', '--input-type=module', '-e', operationSource, operation
  ], { encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0 || !existsSync(output)) return null
  const summary = readFileSync(output, 'utf8').match(/^summary:\s*(\d+)/m)?.[1]
  const count = Number(summary)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

const root = mkdtempSync(join(tmpdir(), 'scry-instructions-'))
try {
  const observations = []
  const perf = process.platform === 'linux' ? perfBinary() : null
  const valgrind = process.platform === 'linux' ? callgrindBinary() : null
  for (const spec of specs) {
    if (process.platform !== 'linux') {
      observations.push(unavailable(spec, `instruction counters unavailable on ${process.platform}; Linux perf/valgrind path not exercised`))
      continue
    }
    const firstPerf = perf ? runPerf(perf, spec.operation) : null
    const backend = firstPerf != null ? 'perf' : valgrind ? 'callgrind' : null
    const runs = firstPerf == null ? [] : [firstPerf]
    for (let index = runs.length; index < repeats; index++) {
      const count = backend === 'perf'
        ? runPerf(perf, spec.operation)
        : backend === 'callgrind'
          ? runCallgrind(valgrind, root, spec.operation)
          : null
      if (count == null) break
      runs.push(count)
    }
    if (runs.length === repeats) {
      observations.push(measured(spec, runs, backend === 'perf'
        ? 'perf stat instructions:u; standalone Node --jitless domain workload'
        : 'valgrind callgrind; standalone Node --jitless domain workload'))
    } else observations.push(unavailable(spec, perf || valgrind
      ? 'Linux instruction counter was present but denied or returned no parseable count'
      : 'neither Linux perf nor valgrind is installed'))
  }
  const report = { schema: 1, revision: process.env.SCRY_PERFORMANCE_REVISION ?? 'instructions-unverified', observations }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
