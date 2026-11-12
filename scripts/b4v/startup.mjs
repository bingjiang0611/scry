// One App startup sample for S0-6 (b4s-startup-timing.mjs). Three cases share one code
// path and differ only in what exists before the App is spawned:
//
//   daemon-cold     switch on, no daemon for this userData (stopped and verified gone)
//   daemon-running  switch on, the daemon a previous App started is still running
//   switch-off      control: the in-process App
//
// Times are wall-clock epoch milliseconds from one machine: the spawn is stamped here,
// navigation start and run-surface readiness are stamped in the renderer
// (performance.timeOrigin + performance.now()). The CDP target time is polled and only
// coarse (about 100 ms), so it is reported but never used for a conclusion.
import { readFileSync } from 'node:fs'
import { attempt, openApp, quitApp, sleep } from './app.mjs'
import { collectLiveIsolation, daemonHolder, fixtureDaemonProcesses, stopFixtureDaemon } from './fixture.mjs'
import { readIdentity, readLockRecord } from './process-identity.mjs'

export const CASES = Object.freeze(['daemon-cold', 'daemon-running', 'switch-off'])
export const caseMode = (name) => name === 'switch-off' ? 'switch-off' : 'daemon'

// Retries only while the App itself reports the daemon is not ready yet (the lazy
// surface's unavailable rule): that wait is part of what the user sees.
export const READINESS_EXPRESSION = `(async () => {
  const deadline = Date.now() + 120000
  let attempts = 0
  let lastError = null
  while (Date.now() < deadline) {
    attempts++
    try {
      await window.scry.activeRuns()
      return { readyAt: performance.timeOrigin + performance.now(), navigationStart: performance.timeOrigin, attempts }
    } catch (error) {
      lastError = String(error && error.message || error)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return { readyAt: null, navigationStart: performance.timeOrigin, attempts, lastError }
})()`

/** `[scry:perf]` lines the App main wrote for its own startup trace (SCRY_PERF_LOG=1). */
export function startupTraceFromLog(text) {
  for (const line of String(text).split('\n').reverse()) {
    if (!line.startsWith('[scry:perf] ')) continue
    try {
      const sample = JSON.parse(line.slice('[scry:perf] '.length))
      if (sample.name !== 'app.startup') continue
      return {
        totalMs: typeof sample.durationMs === 'number' ? sample.durationMs : null,
        checkpoints: Object.fromEntries((sample.checkpoints ?? []).map((checkpoint) => [checkpoint.stage, checkpoint.elapsedMs]))
      }
    } catch { /* a torn line is not a trace */ }
  }
  return null
}

/** What must be true before a sample of this case may be taken. */
export function precondition(name, fixture) {
  const processes = fixtureDaemonProcesses(fixture)
  if (processes.status !== 'available') return { ok: false, reason: `process_scan_unavailable:${processes.reason}` }
  const holder = daemonHolder(fixture)
  if (name === 'daemon-running') {
    return holder.verdict === 'verified' && processes.daemon.length === 1
      ? { ok: true, daemon: { pid: holder.lock.pid, identityKey: holder.lock.identityKey } }
      : { ok: false, reason: `expected one running daemon, holder=${holder.verdict} daemons=${processes.daemon.length}` }
  }
  return holder.verdict !== 'verified' && processes.daemon.length === 0 && processes.supervisor.length === 0
    ? { ok: true }
    : { ok: false, reason: `expected no daemon, holder=${holder.verdict} daemons=${processes.daemon.length} supervisors=${processes.supervisor.length}` }
}

export async function takeSample({ root, fixture, name, index, warmup = false }) {
  const label = `${name}-${warmup ? 'warmup' : index}`
  const before = precondition(name, fixture)
  const sample = { case: name, index, warmup, valid: false, precondition: before, metrics: {} }
  if (!before.ok) { sample.invalidReason = 'precondition'; return sample }
  const app = await openApp({ root, fixture, mode: caseMode(name), label, waitReady: false, env: { SCRY_PERF_LOG: '1' } })
  try {
    const ready = await attempt(app, READINESS_EXPRESSION)
    sample.readiness = ready.ok ? { attempts: ready.value.attempts, lastError: ready.value.lastError ?? null } : ready
    if (ready.ok && typeof ready.value.readyAt === 'number') {
      sample.metrics.navigationStartMs = Number((ready.value.navigationStart - app.spawnedAt).toFixed(2))
      sample.metrics.runSurfaceReadyMs = Number((ready.value.readyAt - app.spawnedAt).toFixed(2))
      sample.metrics.readyAfterNavigationMs = Number((ready.value.readyAt - ready.value.navigationStart).toFixed(2))
    }
    sample.coarse = { cdpTargetMs: app.targetAt - app.spawnedAt }
    if (caseMode(name) === 'daemon') {
      const holder = daemonHolder(fixture)
      sample.daemon = { verdict: holder.verdict, pid: holder.lock?.pid ?? null, startedBy: holder.lock?.startedBy ?? null }
      if (name === 'daemon-running' && holder.lock?.identityKey !== before.daemon.identityKey) sample.invalidReason = 'daemon_replaced_during_sample'
      if (name === 'daemon-cold' && holder.verdict !== 'verified') sample.invalidReason = 'no_daemon_after_cold_start'
    } else {
      const lock = readLockRecord(`${fixture.userDataDir}/scry-userdata.lock`)
      if (lock?.role !== 'app' || lock.pid !== app.pid) sample.invalidReason = 'switch_off_not_in_process'
    }
  } finally {
    sample.quit = await quitApp(app, fixture)
  }
  try { sample.appStartup = startupTraceFromLog(readFileSync(app.logPath, 'utf8')) } catch { sample.appStartup = null }
  if (name === 'daemon-cold') {
    sample.daemonStop = await stopFixtureDaemon(fixture)
    if (sample.daemonStop.remaining.length > 0) sample.invalidReason ??= 'daemon_not_stopped'
  }
  sample.valid = !sample.invalidReason && typeof sample.metrics.runSurfaceReadyMs === 'number' && sample.quit.graceful === true
  if (!sample.valid && !sample.invalidReason) sample.invalidReason = typeof sample.metrics.runSurfaceReadyMs === 'number' ? 'quit_not_graceful' : 'never_ready'
  return sample
}

/** Whether the timing lock at the fixed path is held by this process or one of its ancestors. */
export function timingLockHolder({ lockOwnerPath = '/tmp/scry-performance-timing.lock/owner.json', pid = process.pid } = {}) {
  let owner
  try { owner = JSON.parse(readFileSync(lockOwnerPath, 'utf8')) } catch { return { held: false, reason: 'no_lock' } }
  let current = pid
  for (let depth = 0; depth < 12 && current > 1; depth++) {
    if (current === owner.pid) return { held: true, owner }
    const row = readIdentity(current)
    if (!row) break
    current = row.ppid
  }
  return { held: false, reason: 'lock_held_by_another_process', owner }
}

/**
 * Unmeasured first launch per case. Asserts isolation while the App is alive; leaves the
 * daemon running for "daemon-running" (the samples reuse it) and stops it for "daemon-cold".
 */
export async function warmUp({ root, fixture, name }) {
  const mode = caseMode(name)
  const app = await openApp({ root, fixture, mode, label: `${name}-warmup`, waitReady: true })
  const result = { ok: false, ready: app.ready ?? null }
  try {
    if (!app.ready?.ok) { result.reason = 'never_ready'; return result }
    let live = collectLiveIsolation(fixture, { mode, appPid: app.pid })
    for (let waited = 0; !live.ok && waited < 150; waited++) {
      await sleep(100)
      live = collectLiveIsolation(fixture, { mode, appPid: app.pid })
    }
    result.isolation = live.checks
    result.ok = live.ok
    if (!live.ok) result.reason = 'live_isolation_failed'
    return result
  } finally {
    result.quit = await quitApp(app, fixture)
    if (name === 'daemon-cold') result.daemonStop = await stopFixtureDaemon(fixture)
    if (result.quit.graceful !== true) { result.ok = false; result.reason ??= 'warmup_quit_not_graceful' }
  }
}
