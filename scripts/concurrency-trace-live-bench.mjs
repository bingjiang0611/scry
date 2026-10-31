#!/usr/bin/env node
// Launcher for the live concurrency trace lane (R6.3).
//
// Runs one fixed workload: 16 hidden host runs of the offline `concurrency trace live`
// prompt, each read by 0, 1 or 4 private client peers through the production
// DesktopRemoteClient. The real built App (out/main) hosts loopback TLS; the client is the
// bundled fixture main with the production renderer components.
//
// Nothing here is a test: the launcher writes report.json, host.log and client.log and
// exits non-zero when the run is not completed. Measurement honesty rules live with the
// modules it calls (samples = cumulative CPU deltas with pid identity, missing metrics are
// `unavailable`, views are checked by an independent oracle).
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildLiveFixture, liveWindowOptions } from './concurrency-trace-live-build.mjs'
import { createClientProcess } from './fixtures/concurrency-trace-live-client-process.mjs'
import { createHost } from './fixtures/concurrency-trace-live-host.mjs'
import { lifecycleVerdict } from './fixtures/concurrency-trace-live-lifecycle.mjs'
import { pairAllPeers } from './fixtures/concurrency-trace-live-pairing.mjs'
import {
  describePlan,
  parseBenchArgs,
  planVisits,
  planWaves,
  PROMPT,
  SEED_COUNT,
  TASK_COUNT
} from './fixtures/concurrency-trace-live-plan.mjs'
import { hashFile, hashFiles, hashTree, nodeSample, phaseDeltas } from './fixtures/concurrency-trace-live-samples.mjs'
import { seedWorkspaces } from './fixtures/concurrency-trace-live-workspaces.mjs'
import { summarize } from './fixtures/concurrency-trace-live-summary.mjs'
import { createWaveRecord, runWave } from './fixtures/concurrency-trace-live-wave.mjs'

// Files whose content decides this run's numbers. Hashed before and after the measured
// window so a reviewer can tell whether the code under measurement changed mid-run. The list
// is the runtime import closure of this lane: bench and build, every lane fixture the launcher
// or the client reaches (including dynamically imported ones such as -question and -pairing),
// the shared scripts those fixtures load, and the prompt source. Production modules the host
// and client main bundle are covered by the built-tree hashes (`out`, `liveOut`) instead of
// being listed here.
const LANE_DEPENDENCIES = [
  'scripts/concurrency-trace-live-bench.mjs',
  'scripts/concurrency-trace-live-build.mjs',
  'scripts/fixtures/concurrency-trace-live-client-process.mjs',
  'scripts/fixtures/concurrency-trace-live-client.ts',
  'scripts/fixtures/concurrency-trace-live-commands.ts',
  'scripts/fixtures/concurrency-trace-live-electron.ts',
  'scripts/fixtures/concurrency-trace-live-host.mjs',
  'scripts/fixtures/concurrency-trace-live-lifecycle.mjs',
  'scripts/fixtures/concurrency-trace-live-oracle.mjs',
  'scripts/fixtures/concurrency-trace-live-pairing.mjs',
  'scripts/fixtures/concurrency-trace-live-plan.mjs',
  'scripts/fixtures/concurrency-trace-live-profile.tsx',
  'scripts/fixtures/concurrency-trace-live-protocol.mjs',
  'scripts/fixtures/concurrency-trace-live-question.mjs',
  'scripts/fixtures/concurrency-trace-live-samples.mjs',
  'scripts/fixtures/concurrency-trace-live-summary.mjs',
  'scripts/fixtures/concurrency-trace-live-visit.mjs',
  'scripts/fixtures/concurrency-trace-live-visits.ts',
  'scripts/fixtures/concurrency-trace-live-wave.mjs',
  'scripts/fixtures/concurrency-trace-live-workspaces.mjs',
  'scripts/hidden-electron-windows.cjs',
  'scripts/owned-app-processes.mjs',
  'scripts/performance-report.mjs',
  'scripts/session-concurrency-aggregate.mjs',
  'scripts/session-concurrency-contract.mjs',
  'scripts/session-concurrency-electron.mjs',
  'scripts/session-concurrency-evidence.mjs',
  'src/main/providers/smoke.ts'
]

// Setup is measured on the launcher's own Node process only: the build, the host startup and
// the pairing/window mount are the observer's cost, not the measured lane's.
const SETUP_RANGES = [
  { name: 'buildAndHostStartup', from: 'setup.start', to: 'setup.host-ready', includes: 'fixture build check, host spawn and startup assertions' },
  { name: 'pairingAndWindowMount', from: 'setup.host-ready', to: 'setup.peers-ready', includes: 'peer pairing, host confirmation, peer window mount' },
  { name: 'setup', from: 'setup.start', to: 'setup.peers-ready', includes: 'the whole setup (overlaps the ranges above)' }
]

const RESIDUAL_RISKS = [
  'CPU ranges are per-process cumulative deltas over nested, overlapping windows; they are never summed and the observer range is outside the visit range.',
  'ipcBytes stays unavailable: the private client reports bytes through no production counter, so none are invented.',
  'Renderer mount/round cost comes from the peer renderer PID only; client-main, host-main and launcher CPU are separate scopes and a filtered renderer delta reports the sampler main CPU as unavailable (outside_filtered_scope), never 0.',
  'Two rAF settles layout, not paint; no paint or GPU cost is claimed.',
  'Host log lines are the App\'s own stderr; they are evidence, not a metric.'
]

async function ensureLiveBuild({ liveOut, appRoot, log }) {
  const expected = { index: join(liveOut, 'index.html'), preload: join(liveOut, 'preload.cjs'), main: join(liveOut, 'main', 'main.cjs') }
  const missing = Object.entries(expected).filter(([, path]) => !existsSync(path))
  if (missing.length === 0) return expected
  log('bench', `live fixture is incomplete (${missing.map(([key]) => key).join(', ')}), building it from ${appRoot}`)
  const built = await buildLiveFixture({ outDir: liveOut, root: appRoot, mainEntry: join(appRoot, 'scripts/fixtures/concurrency-trace-live-electron.ts') })
  if (!built.main) throw new Error('buildLiveFixture returned no client main entry')
  return { index: built.index, preload: built.preload, main: built.main }
}

async function main() {
  const plan = parseBenchArgs(process.argv.slice(2))
  const startedAt = Date.now()
  mkdirSync(plan.work, { recursive: true })
  const logLines = { bench: [], host: [], client: [] }
  const log = (channel, line) => {
    const text = `${new Date().toISOString()} ${channel} ${line}`
    logLines[channel]?.push(text)
    if (logLines[channel]?.length === 2000) logLines[channel].shift()
    process.stderr.write(`${text}\n`)
  }
  const require = createRequire(import.meta.url)
  const electron = require('electron')
  if (typeof electron !== 'string') throw new Error('electron binary path is not available')
  const gitHome = join(plan.work, 'git-home')
  const gitTmp = join(plan.work, 'git-tmp')
  mkdirSync(gitHome, { recursive: true })
  mkdirSync(gitTmp, { recursive: true })
  const workspaces = seedWorkspaces({ work: plan.work, count: TASK_COUNT, gitHome, tmp: gitTmp, log })

  const report = {
    status: 'failed',
    lane: plan.lane,
    ok: false,
    issues: [],
    plan: describePlan(plan),
    environment: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      electron: String(electron),
      appRoot: resolve(plan.appRoot),
      liveOut: resolve(plan.liveOut),
      work: resolve(plan.work),
      startedAt: new Date(startedAt).toISOString(),
      prompt: PROMPT,
      taskCount: TASK_COUNT,
      seedCount: SEED_COUNT
    },
    identity: { dependencies: LANE_DEPENDENCIES, before: null, after: null, stable: {}, treeBefore: {}, treeAfter: {} },
    host: { startup: null, settlement: null, lifecycle: null, log: null },
    client: { startup: null, lifecycle: null, log: null, faults: [] },
    peers: [],
    waves: [],
    setup: { marks: {}, phases: [] },
    summary: null,
    residualRisks: RESIDUAL_RISKS,
    completedAt: null
  }

  const write = () => {
    report.summary = summarize(report, plan)
    report.completedAt = new Date().toISOString()
    report.durationMs = Date.now() - startedAt
    writeFileSync(plan.reportPath, `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(join(plan.work, 'host.log'), `${logLines.host.join('\n')}\n`)
    writeFileSync(join(plan.work, 'client.log'), `${logLines.client.join('\n')}\n`)
    writeFileSync(join(plan.work, 'bench.log'), `${logLines.bench.join('\n')}\n`)
  }

  const setupMarks = {}
  const markSetup = (label) => { setupMarks[label] = nodeSample(`driver:setup:${label}`) }
  markSetup('setup.start')
  const fixture = await ensureLiveBuild({ liveOut: plan.liveOut, appRoot: plan.appRoot, log })
  const fileHashes = () => Object.fromEntries(LANE_DEPENDENCIES.map((file) => [file, hashFile(join(plan.appRoot, file))]))
  // Identities are taken before the measured window and again after it, never inside it.
  report.identity.before = { digest: hashFiles(plan.appRoot, LANE_DEPENDENCIES), files: fileHashes() }
  report.identity.treeBefore = { out: hashTree(join(plan.appRoot, 'out')), liveOut: hashTree(plan.liveOut) }
  const windowOptions = JSON.stringify(liveWindowOptions(fixture.preload))
  const host = createHost({ root: plan.appRoot, electron, temp: plan.work, workspaces, log })
  const client = createClientProcess({
    electron,
    mainEntry: fixture.main,
    temp: plan.work,
    indexPath: fixture.index,
    preloadPath: fixture.preload,
    windowOptions,
    hiddenWindowsPath: join(plan.appRoot, 'scripts/hidden-electron-windows.cjs'),
    log,
    deadlines: plan.deadlines
  })

  try {
    await host.spawn()
    await host.ready()
    report.host.startup = host.record.ready
    markSetup('setup.host-ready')
    if (plan.peers > 0) {
      await client.spawn()
      await client.ready()
      // Each peer is its own real pairing attempt; ids stay integers for the client validators.
      const paired = await pairAllPeers({ count: plan.peers, client, host, stateRoot: client.stateRoot, report, log })
      plan.peerConnections = paired.connections
      plan.peerRenderers = paired.renderers
    } else {
      plan.peerConnections = []
      plan.peerRenderers = []
    }
    markSetup('setup.peers-ready')

    for (const wave of planVisits({ limit: plan.limit, peers: plan.peers })) {
      const record = createWaveRecord({ wave, peerCount: plan.peers })
      // Registered before the wave runs so a failing wave is still in the report.
      report.waves.push(record)
      await runWave({ wave, record, workspaces, host, client, peerCount: plan.peers, plan, userData: host.userData })
      log('bench', `wave ${wave.waveIndex} ${record.status} (${record.failures[0]?.error ?? 'no failure'})`)
      if (record.status !== 'completed') break
    }

    // Settlement: the only place the whole-run projection and SQLite are read.
    report.host.settlement = await host.settle().then((value) => ({ status: 'measured', ...value }), (error) => ({ status: 'unavailable', reason: String(error) }))
  } catch (error) {
    report.issues.push(`bench: ${error instanceof Error ? error.message : String(error)}`)
    log('bench', `run failed before completion: ${report.issues.at(-1)}`)
  } finally {
    const hostShutdown = await host.shutdown('launcher').catch((error) => ({ error: String(error) }))
    report.host.lifecycle = hostShutdown
    const clientShutdown = await client.shutdown('launcher').catch((error) => ({ error: String(error) }))
    report.client.lifecycle = clientShutdown?.record ?? null
    report.client.startup = client.record?.ready ?? null
    report.client.log = clientShutdown?.log ?? null
    report.client.faults = clientShutdown?.faults ?? []
    report.host.log = { text: logLines.host.slice(-400).join('\n'), lines: logLines.host.length }
    report.setup.marks = setupMarks
    report.setup.phases = phaseDeltas(setupMarks, SETUP_RANGES, { pids: [process.pid], scope: 'launcher-node' })
    report.identity.after = { digest: hashFiles(plan.appRoot, LANE_DEPENDENCIES), files: fileHashes() }
    report.identity.treeAfter = { out: hashTree(join(plan.appRoot, 'out')), liveOut: hashTree(plan.liveOut) }
    report.identity.stable = {
      digest: report.identity.before.digest === report.identity.after.digest ? 'stable' : 'changed',
      files: Object.fromEntries(LANE_DEPENDENCIES.map((file) => [file, report.identity.before.files[file] === report.identity.after.files[file] ? 'stable' : 'changed'])),
      out: report.identity.treeBefore.out === report.identity.treeAfter.out ? 'stable' : 'changed',
      liveOut: report.identity.treeBefore.liveOut === report.identity.treeAfter.liveOut ? 'stable' : 'changed'
    }

    const lifecycle = lifecycleVerdict([host.record, client.record].filter(Boolean))
    report.issues.push(...lifecycle.issues)
    for (const wave of report.waves) for (const failure of wave.failures) report.issues.push(`wave ${wave.waveIndex} ${failure.phase}: ${failure.error}`)
    for (const [name, state] of Object.entries(report.identity.stable.files)) {
      if (state !== 'stable') report.issues.push(`${name} changed during the run (before/after hashes differ)`)
    }
    for (const name of ['digest', 'out', 'liveOut']) {
      if (report.identity.stable[name] !== 'stable') report.issues.push(`${name} changed during the run (before/after hashes differ)`)
    }

    const expectedWaves = planWaves(plan.limit).length
    if (report.waves.length !== expectedWaves) report.issues.push(`only ${report.waves.length}/${expectedWaves} waves ran`)
    for (const wave of report.waves) {
      if (wave.status !== 'completed') report.issues.push(`wave ${wave.waveIndex} did not complete`)
      const expectedVisits = plan.peers * wave.taskIndices.length
      if (wave.visits.length !== expectedVisits) report.issues.push(`wave ${wave.waveIndex} ran ${wave.visits.length}/${expectedVisits} visits`)
      if (wave.archive && wave.archive.missing.length > 0) report.issues.push(`wave ${wave.waveIndex} archive missing: ${wave.archive.missing.join(', ')}`)
    }
    if (report.host.settlement?.status !== 'measured') report.issues.push('host settlement was not measured')
    report.issues = [...new Set(report.issues)]
    report.ok = report.issues.length === 0
    report.status = report.ok ? 'completed' : 'failed'
    write()
    log('bench', `report written to ${plan.reportPath}: ${report.status} (${report.issues.length} issue(s))`)
  }
  process.exitCode = report.ok ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`concurrency-trace-live: fatal ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
