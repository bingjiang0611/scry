#!/usr/bin/env node
// L2 timing: what the daemon hop costs the App's run view.
//
// The App's pump issues two frames per cycle: one `subscribe` window and one trace read.
// This measures the added cost of that hop over the real unix socket against a real
// daemon, next to the same frames answered in memory, on this machine, serially:
//
//   node .agents/skills/scry-performance-climb/scripts/timing-run.mjs daemon-trace-latency -- \
//     node scripts/daemon-trace-latency.mjs
//
// Honest limits, stated instead of implied:
//   * the frames are answered for a run the daemon does not have, so the measured
//     payload is small; a populated trace adds transfer time on the same socket;
//   * this is the hop cost, not end-to-end first-token latency;
//   * no Provider runs, so nothing here is a claim about Provider time.
// Exit 2 when the daemon cannot be reached at all: a missing measurement is not a
// fast one.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { enrollLocalDevice, frame, waitForSocket } from './daemon-fixture.mjs'

const SAMPLES = Number(process.env.SCRY_LATENCY_SAMPLES ?? 40)
const root = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'scry-lat-')))
const userDataDir = join(root, 'userData')
const stateDirectory = join(root, 'state')
const home = join(root, 'home')
mkdirSync(home)
mkdirSync(userDataDir)
writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([root]))

function cleanup() { rmSync(root, { recursive: true, force: true }) }
process.on('exit', cleanup)

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const child = spawn(process.execPath, [resolve('out/main/daemon.js')], {
  // Only the daemon's own variables: this fixture needs no forwarded user config, and
  // the harness must not inherit the caller's Provider or relay settings.
  env: {
    PATH: process.env.PATH,
    HOME: home,
    ELECTRON_RUN_AS_NODE: '1',
    SCRY_DAEMON_STATE_DIR: stateDirectory,
    SCRY_DAEMON_USER_DATA_DIR: userDataDir,
    SCRY_DAEMON_APP_PATH: resolve('.'),
    SCRY_DAEMON_RESOURCES_PATH: resolve('.'),
    SCRY_DAEMON_APP_VERSION: '0.0.0-latency',
    SCRY_DAEMON_PACKAGED: '0',
    SCRY_DAEMON_STARTED_BY: 'latency-script'
  },
  stdio: ['ignore', 'ignore', 'pipe']
})
let stderr = ''
child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096) })

try {
  if (!await waitForSocket(join(stateDirectory, 'local.sock'), 20_000, () => child.exitCode === null)) {
    process.stderr.write(`daemon did not listen: ${stderr}\n`)
    process.exit(2)
  }
  const credentials = await enrollLocalDevice(stateDirectory, 'latency fixture')

  const request = { op: 'subscribe', views: ['activeRuns'], waitMs: 0 }
  const trace = { op: 'desktop', query: { kind: 'trace', context: { cwd: root, providerId: 'codex' }, runId: 'run-latency-1', images: true, byteChunks: true } }
  const baseline = await frame(stateDirectory, credentials, request)
  assert.equal(baseline.subscribe?.mode, 'snapshot', JSON.stringify(baseline))
  const { hostId, logId, seq } = baseline.subscribe
  const subscribe = { ...request, known: { hostId, logId, seq } }

  async function read() {
    const status = await frame(stateDirectory, credentials, subscribe)
    assert.equal(status.subscribe?.mode, 'idle', JSON.stringify(status))
    const evidence = await frame(stateDirectory, credentials, trace)
    assert.equal(evidence.desktop?.kind, 'trace', JSON.stringify(evidence))
    assert.equal(evidence.desktop.run, null)
  }

  // Warm both paths once to limit first-connection and JIT costs.
  await read()

  const socketTimes = []
  for (let index = 0; index < SAMPLES; index++) {
    const started = performance.now()
    await read()
    socketTimes.push(performance.now() - started)
  }

  // The same two frames answered in memory: the in-process floor for this view.
  const memoryTimes = []
  const reply = JSON.stringify({ subscribe: { hostId, logId, seq, mode: 'idle' } })
  for (let index = 0; index < SAMPLES; index++) {
    const started = performance.now()
    JSON.parse(reply)
    JSON.parse(JSON.stringify({ desktop: { kind: 'trace', run: null } }))
    memoryTimes.push(performance.now() - started)
  }

  const report = {
    samples: SAMPLES,
    socketP50Ms: Number(percentile(socketTimes, 50).toFixed(2)),
    socketP95Ms: Number(percentile(socketTimes, 95).toFixed(2)),
    inMemoryP50Ms: Number(percentile(memoryTimes, 50).toFixed(2)),
    inMemoryP95Ms: Number(percentile(memoryTimes, 95).toFixed(2)),
    addedP95Ms: Number((percentile(socketTimes, 95) - percentile(memoryTimes, 95)).toFixed(2)),
    budgetMs: 10,
    loadAverage: (await import('node:os')).loadavg().map((value) => Number(value.toFixed(2))),
    cpuCount: (await import('node:os')).cpus().length
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
} finally {
  child.kill('SIGTERM')
  await once(child, 'exit').catch(() => undefined)
}
