#!/usr/bin/env node
/**
 * Informational benchmark: what the record summary index saves on the hook path.
 *
 * Nothing here asserts a threshold; absolute numbers move with machine, disk and load, so compare
 * runs on one machine. Five modes, each in its own child process so peak RSS is not carried over
 * from an earlier mode:
 *
 *   full   `listRecords()` — parse every record, which is what the identity paths did before
 *   cold   `listRecordSummaries()` with no cache — a full parse plus writing the cache
 *   warm   `listRecordSummaries()` with a valid cache — what every later call costs
 *   hook-warm  `nextSessionState()` for a session with no `session.json`, cache present
 *   hook-cold  the same call with the cache deleted — the one-time cost a hook can still meet
 *
 * Usage:
 *   npm run build:cli && node scripts/recorder-record-summary-bench.mjs [--records=3000] [--record-bytes=88000] [--rounds=3]
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, cpus, loadavg, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { cleanupTemp, loadDist, makeTempRoot, median, startRssSampler } from './recorder-engine-bench-fixtures.mjs'

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
  return [key, value]
}))

const MODES = ['full', 'cold', 'warm', 'hook-warm', 'hook-cold']

function round(value) { return Math.round(value * 100) / 100 }

const empty = () => ({ status: 'available', quality: 'exact', source: ['bench'], value: [] })

/** Builds a synthetic record with varying identity fields and configurable text padding. */
function draft(sequence, textBytes) {
  return {
    schemaVersion: 1, recordKind: 'agent_turn', sequence,
    recordId: String(sequence).padStart(32, '0'),
    recorderVersion: '0.2.85',
    workspace: { id: 'bench', root: '/repo' },
    provider: { id: ['claude', 'codex', 'qoder'][sequence % 3] },
    sessionId: `session-${sequence % 400}`, generation: sequence, turnIndex: sequence,
    ...(sequence % 2 === 0 ? { providerTurnId: `provider-turn-${sequence}` } : {}),
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', durationMs: 1_000,
    status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['bench'], value: { text: 'bench prompt' } },
    // Text padding sets the approximate serialized record size for the benchmark workload.
    assistant: { status: 'available', quality: 'exact', source: ['bench'], value: { text: 'y'.repeat(textBytes) } },
    tools: empty(), skills: empty(), mcps: empty(), hooks: empty(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    files: empty(), diff: empty(), dangerousOperations: empty(), errors: empty()
  }
}

async function buildStore(dataRoot, records, recordBytes) {
  await mkdir(join(dataRoot, 'records'), { recursive: true })
  const padding = Math.max(0, recordBytes - 1_500)
  for (let sequence = 1; sequence <= records; sequence++) {
    const record = draft(sequence, padding)
    const name = `${String(sequence).padStart(20, '0')}-${record.recordId}.json`
    await writeFile(join(dataRoot, 'records', name), JSON.stringify(record))
  }
}

async function child(mode, dataRoot) {
  const store = await loadDist('store')
  const sessionState = await loadDist('recorder-turn-state')
  const rss = startRssSampler()
  rss.reset()
  const started = performance.now()
  let result
  if (mode === 'full') result = (await store.listRecords(dataRoot)).length
  else if (mode === 'hook-warm' || mode === 'hook-cold') {
    // A session the store has never seen: exactly the miss `beginOpenTurn` meets on a first event.
    const sessionId = `bench-session-${process.pid}-${Math.random().toString(16).slice(2)}`
    const state = await sessionState.nextSessionState(dataRoot, join(dataRoot, 'runtime', 'codex', sessionId), 'codex', sessionId)
    result = state.lastGeneration
  } else result = (await store.listRecordSummaries(dataRoot)).length
  const ms = performance.now() - started
  const peakBytes = rss.read().peakBytes
  rss.stop()
  process.stdout.write(JSON.stringify({ mode, records: result, ms, peakBytes }))
}

async function measure(mode, dataRoot) {
  const output = spawnSync(process.execPath, [import.meta.filename, `--child=${mode}`, `--root=${dataRoot}`], { encoding: 'utf8' })
  if (output.status !== 0) throw new Error(`child ${mode} exited ${output.status}: ${output.stderr?.slice(0, 400)}`)
  return JSON.parse(output.stdout)
}

function environment() {
  return {
    platform: `${platform()} ${release()}`, arch,
    cpus: cpus().length, totalmemGiB: round(totalmem() / 1024 ** 3), loadavg: loadavg().map(round)
  }
}

async function main() {
  if (args.has('child')) {
    await child(args.get('child'), args.get('root'))
    return
  }
  const records = Number(args.get('records') ?? 3_000)
  const recordBytes = Number(args.get('record-bytes') ?? 88_000)
  const rounds = Number(args.get('rounds') ?? 3)
  const tempRoot = makeTempRoot()
  const dataRoot = join(tempRoot, '.scry')
  const buildStarted = performance.now()
  await buildStore(dataRoot, records, recordBytes)
  const buildSeconds = round((performance.now() - buildStarted) / 1000)

  const results = new Map(MODES.map((mode) => [mode, { ms: [], peakBytes: [] }]))
  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    for (const mode of MODES) {
      // 'cold' and 'hook-cold' must never see a cache; the warm modes use the one the cold run wrote.
      if (mode === 'cold' || mode === 'hook-cold') await rm(join(dataRoot, 'records-summary.json'), { force: true })
      const entry = await measure(mode, dataRoot)
      results.get(mode).ms.push(entry.ms)
      results.get(mode).peakBytes.push(entry.peakBytes)
    }
  }

  const cacheBytes = (await readFile(join(dataRoot, 'records-summary.json'), 'utf8').catch(() => '')).length
  process.stdout.write(`record summary bench, ${records} records, ${rounds} rounds/mode, ${platform()} ${arch}\n`)
  process.stdout.write(`environment ${JSON.stringify(environment())}\n`)
  process.stdout.write(`fixture: ${records} records x ~${recordBytes} bytes, built in ${buildSeconds}s, cache ${cacheBytes} bytes\n\n`)
  process.stdout.write('mode   median ms   peak RSS MiB   note\n')
  const note = {
    full: 'listRecords(): today\'s identity paths, parse every record',
    cold: 'listRecordSummaries() without a cache: parse once, then write the cache',
    warm: 'listRecordSummaries() with a valid cache: every later call',
    'hook-warm': 'nextSessionState() for a new session, cache present',
    'hook-cold': 'nextSessionState() for a new session, cache deleted'
  }
  for (const mode of MODES) {
    const entry = results.get(mode)
    const ms = median(entry.ms)
    const peak = median(entry.peakBytes) / 1024 ** 2
    process.stdout.write(`${mode.padEnd(6)} ${String(round(ms)).padStart(10)} ${round(peak).toFixed(1).padStart(14)}   ${note[mode]}\n`)
  }
  const full = median(results.get('full').ms)
  const warm = median(results.get('warm').ms)
  process.stdout.write(`\nwarm read is ${round(full / Math.max(warm, 0.001))}x cheaper than a full parse\n`)
  cleanupTemp(tempRoot)
}

await main()
