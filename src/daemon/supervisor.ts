import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_DETERMINISTIC_STARTUP } from './startup-failure'
import type { DaemonLaunchedBy } from './daemon-config'

export interface DaemonExit {
  code: number | null
  signal: NodeJS.Signals | null
  runtimeMs?: number
  /** Sanitized machine code only; never stderr text. */
  reason?: string
  /** The exit followed a stop request: never a reason to restart. */
  stopRequested?: boolean
}
export interface SupervisorOptions {
  directory: string
  launch(): Promise<DaemonExit>
  maxRestarts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  stableRunMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Aborted when the supervisor itself is asked to stop: no further launch after it. */
  stopSignal?: AbortSignal
}
export type SupervisorResult =
  | { status: 'stopped'; attempts: number }
  /** The daemon was asked to stop and was still running at the bound. */
  | { status: 'stop-timeout'; attempts: number }
  | { status: 'already-running'; attempts: number }
  | { status: 'failed'; attempts: number; reason: string }
  | { status: 'exhausted'; attempts: number }

const FAILURE_FILE = 'supervisor-failure.json'
const STOP_TIMEOUT_REASON = 'daemon_stop_timeout'

/**
 * How long a stopping supervisor waits for the daemon after forwarding SIGTERM. Below the
 * 30 s a service manager allows (systemd TimeoutStopSec, launchd ExitTimeOut) so the
 * supervisor leaves before it is killed, and long enough for the daemon's dispose
 * (terminal recording, remote release, both locks).
 */
export const DAEMON_STOP_TIMEOUT_MS = 25_000

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

export async function superviseDaemon(options: SupervisorOptions): Promise<SupervisorResult> {
  const maxRestarts = options.maxRestarts ?? 4
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 8_000
  const stableRunMs = options.stableRunMs ?? 60_000
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })

  let attempts = 0
  let restarts = 0
  let lastExit: DaemonExit = { code: null, signal: null }
  while (true) {
    if (options.stopSignal?.aborted) return { status: 'stopped', attempts }
    attempts += 1
    lastExit = await options.launch()
    // A stop is not a crash and not a launch failure: no restart and no failure record,
    // which the App reads as "this launch failed" (daemon-launch-failure.ts).
    if (lastExit.stopRequested) return { status: lastExit.reason === STOP_TIMEOUT_REASON ? 'stop-timeout' : 'stopped', attempts }
    if (lastExit.code === 0) return { status: 'stopped', attempts }
    if (lastExit.code === 3) return { status: 'already-running', attempts }
    if (lastExit.code === 2) {
      const reason = lastExit.reason ?? 'daemon_configuration_failed'
      atomicJson(join(options.directory, FAILURE_FILE), { version: 1, failedAt: now(), attempts, lastExit: { code: lastExit.code, signal: lastExit.signal }, reason })
      return { status: 'failed', attempts, reason }
    }
    if (lastExit.code === EXIT_DETERMINISTIC_STARTUP) {
      const reason = lastExit.reason ?? 'daemon_startup_blocked'
      atomicJson(join(options.directory, FAILURE_FILE), { version: 1, failedAt: now(), attempts, lastExit: { code: lastExit.code, signal: lastExit.signal }, reason })
      return { status: 'failed', attempts, reason }
    }
    if ((lastExit.runtimeMs ?? 0) >= stableRunMs) restarts = 0
    if (restarts >= maxRestarts) break
    const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** restarts))
    restarts += 1
    await sleep(delay)
  }

  atomicJson(join(options.directory, FAILURE_FILE), {
    version: 1,
    failedAt: now(),
    attempts,
    lastExit: { code: lastExit.code, signal: lastExit.signal },
    ...(lastExit.reason ? { reason: lastExit.reason } : {})
  })
  return { status: 'exhausted', attempts }
}

const FORWARDED_ENV = [
  'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LOGNAME', 'USER', 'SHELL', 'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'SCRY_REMOTE_HOST', 'SCRY_REMOTE_PERMISSION_MODE', 'SCRY_REMOTE_RELAY_ENABLED',
  'SCRY_REMOTE_RELAY_WS', 'SCRY_DISABLED_PROVIDERS',
  'SCRY_RUN_CONTROLS', 'SCRY_PROVIDER_MANIFEST_URL',
  // Acceptance only: lets the daemon serve the packaged smoke Provider fixture. The
  // fixture still requires this explicit variable AND a daemon process (see
  // provider-runtime), so a normal install can never enable it by inheriting an env.
  'SCRY_DAEMON_SMOKE_PROVIDER',
  // Measurement only: writes per-stage wall-clock marks that the timing script folds
  // into one timeline. Off unless the variable is set; no product behavior changes.
  'SCRY_RUN_TIMING',
  // P4 orchestration switch & measurement controls (read only by the daemon).
  'SCRY_ORCHESTRATION_FULLFSYNC',
  'SCRY_ORCHESTRATION_PENDING_TTL_MS',
  // P5 Step 2 host CLI experimental switch (default off; forwards only when explicitly set).
  'SCRY_EXPERIMENTAL_HOST_CLI'
] as const

/**
 * Acceptance only: the smoke Provider fixture's own inputs (which fixture set, the files it
 * reads prompts from and records calls to, the native identity, the history reader). The
 * in-process App used to read them itself; since S3 the fixture runs in the daemon, so an
 * isolated test App hands them on. Forwarded only when the daemon's fixture was asked for
 * (`SCRY_DAEMON_SMOKE_PROVIDER=1`) by a test instance (`SCRY_TEST_APP=1`, the App's hop) or
 * by a supervisor whose environment this function built with the fixture handed on
 * (SMOKE_FIXTURE_HOP, the supervisor's hop). Every daemon environment carries
 * `SCRY_DAEMON_STATE_DIR`, so that is no proof of a fixture hop; only the marker is, and
 * only this function sets it. A normal launch never carries them.
 */
export const SMOKE_FIXTURE_ENV = [
  'SCRY_ELECTRON_SMOKE_CONVERSATIONS',
  'SCRY_ELECTRON_SMOKE_SIDE_CHAT',
  'SCRY_ELECTRON_SMOKE_INPUTS',
  'SCRY_ELECTRON_SMOKE_CALLS',
  'SCRY_ELECTRON_SMOKE_IDENTITY',
  'SCRY_ELECTRON_SMOKE_READER',
  'SCRY_ELECTRON_SMOKE_READS',
  // The concurrent-performance fixture's measurement inputs: its hook children load the
  // probe (`--require`) and log to the bench's file, and the managed hook needs the CLI
  // the bench built. Without them the daemon's hook children got `--require=undefined`.
  'SCRY_CONCURRENT_PROBE',
  'SCRY_CONCURRENT_LOG',
  'SCRY_CONCURRENT_ROLE',
  'SCRY_CLI_PATH'
] as const

/** Set by daemonLaunchEnvironment alone, and only on a hop it handed the fixture env to. */
export const SMOKE_FIXTURE_HOP = 'SCRY_DAEMON_SMOKE_FIXTURE_HOP'

export function smokeFixtureEnvironment(source: NodeJS.ProcessEnv, hop: 'app' | 'supervisor' = 'app'): NodeJS.ProcessEnv {
  if (source.SCRY_DAEMON_SMOKE_PROVIDER !== '1') return {}
  // Each hop has its own proof: the App's is a test instance, the supervisor's is the
  // marker the App's hop set. Neither stands in for the other.
  if (hop === 'app' ? source.SCRY_TEST_APP !== '1' : source[SMOKE_FIXTURE_HOP] !== '1') return {}
  const env: NodeJS.ProcessEnv = { [SMOKE_FIXTURE_HOP]: '1' }
  for (const key of SMOKE_FIXTURE_ENV) if (source[key] !== undefined) env[key] = source[key]
  return env
}

export function daemonLaunchEnvironment(input: {
  source?: NodeJS.ProcessEnv
  stateDirectory: string
  userDataDir: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
  startedBy: string
  /**
   * Set explicitly by whoever starts the supervisor, never inherited: the name is not in
   * FORWARDED_ENV, so a value in the caller's environment cannot leak through.
   */
  launchedBy?: DaemonLaunchedBy
  /** Which launch this is: the App starting a supervisor, or a supervisor its daemon. */
  hop?: 'app' | 'supervisor'
}): NodeJS.ProcessEnv {
  const source = input.source ?? process.env
  const env: NodeJS.ProcessEnv = {}
  for (const key of FORWARDED_ENV) if (source[key] !== undefined) env[key] = source[key]
  return {
    ...env,
    ...smokeFixtureEnvironment(source, input.hop),
    ELECTRON_RUN_AS_NODE: '1',
    SCRY_DAEMON_STATE_DIR: input.stateDirectory,
    SCRY_DAEMON_USER_DATA_DIR: input.userDataDir,
    SCRY_DAEMON_APP_PATH: input.appPath,
    SCRY_DAEMON_RESOURCES_PATH: input.resourcesPath,
    SCRY_DAEMON_APP_VERSION: input.appVersion,
    SCRY_DAEMON_PACKAGED: input.isPackaged ? '1' : '0',
    SCRY_DAEMON_STARTED_BY: input.startedBy,
    ...(input.launchedBy ? { SCRY_DAEMON_LAUNCHED_BY: input.launchedBy } : {})
  }
}

export function launchDaemonOnce(input: {
  executable: string
  daemonEntry: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  stopTimeoutMs?: number
}): Promise<DaemonExit> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(input.executable, [input.daemonEntry], {
      env: input.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let diagnostic = ''
    child.stderr?.on('data', (chunk) => {
      if (diagnostic.length < 4096) diagnostic += String(chunk).slice(0, 4096 - diagnostic.length)
    })
    let stopRequested = false
    let stopTimer: NodeJS.Timeout | undefined
    // Stopping forwards exactly one SIGTERM to this child (the pid spawn returned), then
    // waits for its exit: the daemon's own handler runs its cleanup once. No second
    // signal and no SIGKILL; past the bound the service manager owns what is left.
    const stop = (): void => {
      if (stopRequested) return
      stopRequested = true
      child.kill('SIGTERM')
      stopTimer = setTimeout(() => {
        resolve({ code: null, signal: null, runtimeMs: Date.now() - startedAt, reason: STOP_TIMEOUT_REASON, stopRequested })
      }, input.stopTimeoutMs ?? DAEMON_STOP_TIMEOUT_MS)
    }
    child.once('error', (error) => {
      // After a stop request only the exit or the bound settles: a failed kill is
      // followed by the exit of a child that was already gone.
      if (!stopRequested) reject(error)
    })
    child.once('exit', (code, signal) => {
      if (stopTimer) clearTimeout(stopTimer)
      input.signal?.removeEventListener('abort', stop)
      const reason = diagnostic.match(/(?:^|\n)((?:daemon|remote)_[a-z0-9_]+)/)?.[1]
      resolve({ code, signal, runtimeMs: Date.now() - startedAt, ...(reason ? { reason } : {}), ...(stopRequested ? { stopRequested } : {}) })
    })
    if (input.signal?.aborted) stop()
    else input.signal?.addEventListener('abort', stop, { once: true })
  })
}
