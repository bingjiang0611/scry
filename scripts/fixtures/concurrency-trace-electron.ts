// Electron main-only entry for one concurrency trace cell (R5).
//
// No BrowserWindow, no preload, no renderer: this process only drives the accepted R4 fixture, which
// runs the real host reader, the real in-process DesktopRemoteClient peers and the real
// mergeRemoteTrace. Renderer mounts/commits, mirroring, TLS and any Provider process are therefore
// unavailable here by construction, and nothing in this file may report them as measured.
//
// The launcher describes the whole cell in one env value (fixed shape, validated below) and starts this
// file with an explicit --user-data-dir. When the trial result has been written, the entry sends exactly
// one fixed IPC message and then stays alive: the parent captures the process identity and stops it, so
// this process never exits on its own after the notification.
import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, dirname } from 'node:path'
import { runConcurrencyTraceTrial } from './concurrency-trace-trial'
import { TRIAL_ITEMS, TRIAL_LIMITS, TRIAL_READERS, type TrialConfig, type TrialResult }
  from './concurrency-trace-trial-report'

const CONFIG_ENV = 'SCRY_CONCURRENCY_TRACE_TRIAL_CONFIG'
const NOTIFICATION_TYPE = 'concurrency-trace-trial'
const stderr = (message: string): void => { process.stderr.write(`[scry:concurrency-trace] ${message}\n`) }
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

interface LaunchPaths {
  /** The private trial directory every other path must live inside. */
  root: string
  home: string
  userData: string
  sessionData: string
  appTemp: string
  logs: string
  resultPath: string
}

interface Launch {
  config: TrialConfig
  paths: LaunchPaths
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cellNumber = (value: unknown, allowed: readonly number[], label: string): number => {
  if (typeof value !== 'number' || !allowed.includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`)
  }
  return value
}

// Layout check only: the launcher creates this private directory and describes the tree through an env
// value, so the entry confirms that every configured path sits under that root before using it. The check
// is lexical (resolve + relative): it does not resolve symlinks and it is not an isolation boundary against
// another process running as the same user. It stops a misconfigured cell from writing outside the tree it
// reports, nothing more.
function requireInside(root: string, value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  const resolved = resolve(value)
  const inside = relative(root, resolved)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`${label} must live inside the private trial directory`)
  }
  return resolved
}

function readLaunch(env: Record<string, string | undefined>): Launch {
  const encoded = env[CONFIG_ENV]
  if (encoded === undefined) throw new Error(`${CONFIG_ENV} is missing: the launcher has to describe this cell`)
  const parsed: unknown = JSON.parse(encoded)
  if (!record(parsed) || !record(parsed.config) || !record(parsed.paths)) {
    throw new Error(`${CONFIG_ENV} must be an object with config and paths`)
  }
  const raw = parsed.paths
  if (typeof raw.root !== 'string' || !isAbsolute(raw.root)) throw new Error('paths.root must be an absolute private directory')
  const root = resolve(raw.root)
  const paths: LaunchPaths = {
    root,
    home: requireInside(root, raw.home, 'paths.home'),
    userData: requireInside(root, raw.userData, 'paths.userData'),
    sessionData: requireInside(root, raw.sessionData, 'paths.sessionData'),
    appTemp: requireInside(root, raw.appTemp, 'paths.appTemp'),
    logs: requireInside(root, raw.logs, 'paths.logs'),
    resultPath: requireInside(root, raw.resultPath, 'paths.resultPath')
  }
  return {
    config: {
      limit: cellNumber(parsed.config.limit, TRIAL_LIMITS, 'config.limit') as TrialConfig['limit'],
      readers: cellNumber(parsed.config.readers, TRIAL_READERS, 'config.readers') as TrialConfig['readers'],
      items: cellNumber(parsed.config.items, TRIAL_ITEMS, 'config.items') as TrialConfig['items']
    },
    paths
  }
}

// Exactly one message with a fixed shape: a completion status and the result path. There is no command,
// no path request and no reply channel for the parent to drive this process with.
function notify(payload: { status: string, resultPath?: string, error?: string }): void {
  if (typeof process.send !== 'function' || process.connected === false) {
    stderr('completion notification channel is not connected; the parent will see the result file only')
    return
  }
  process.send({ type: NOTIFICATION_TYPE, schema: 1, ...payload })
}

interface CellPayload {
  schema: 1
  status: 'measured' | 'incomplete' | 'error'
  runtime: Record<string, string | undefined>
  config: TrialConfig
  memory: { before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage, scope: string }
  durations: { trialStartedAtMs: number, trialEndedAtMs: number, trialWallMs: number }
  trial: TrialResult | null
  error: string | null
  isolation: LaunchPaths
}

// Before/after process.memoryUsage() of this Electron main process. The samples include the in-process
// clients and the trial checks; they are not a peak, not physical memory and not post-GC residency.
const MEMORY_SCOPE = 'before/after process.memoryUsage() snapshots of this Electron main process, including in-process clients and trial checks; not a continuous peak, not physical memory, not post-GC residency'

async function runCell(launch: Launch): Promise<void> {
  const memoryBefore = process.memoryUsage()
  const trialStartedAtMs = performance.now()
  let trial: TrialResult | null = null
  let failure: string | null = null
  try {
    trial = await runConcurrencyTraceTrial(launch.config)
  } catch (error) {
    failure = errorMessage(error)
  }
  const trialEndedAtMs = performance.now()
  const memoryAfter = process.memoryUsage()
  const status = failure !== null ? 'error' : trial !== null && trial.status === 'measured' ? 'measured' : 'incomplete'
  const payload: CellPayload = {
    schema: 1,
    status,
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      v8: process.versions.v8,
      // Recorded process facts, not a release claim for the desktop App.
      arch: process.arch,
      platform: process.platform
    },
    config: launch.config,
    memory: { before: memoryBefore, after: memoryAfter, scope: MEMORY_SCOPE },
    durations: { trialStartedAtMs, trialEndedAtMs, trialWallMs: trialEndedAtMs - trialStartedAtMs },
    trial,
    error: failure,
    isolation: launch.paths
  }
  try {
    await mkdir(dirname(launch.paths.resultPath), { recursive: true })
    await writeFile(launch.paths.resultPath, JSON.stringify(payload))
  } catch (writeError) {
    const writeMessage = errorMessage(writeError) || 'the trial result could not be written'
    // The write error always reaches stderr. The notification keeps an earlier trial failure, because that
    // is the failure being investigated, and only falls back to the write error when there is none.
    stderr(`could not write the trial result: ${writeMessage}`)
    notify({ status: 'error', error: failure === null || failure === '' ? writeMessage : failure })
    return
  }
  // The parent's validator rejects an error notification that carries no error text, so a failed trial has
  // to send the original failure here; a measured or incomplete result must not invent one.
  notify(failure === null
    ? { status, resultPath: launch.paths.resultPath }
    : { status, resultPath: launch.paths.resultPath, error: failure })
}

function boot(launch: Launch): void {
  // Paths are set before ready; the browser process also received --user-data-dir from the launcher.
  app.setPath('userData', launch.paths.userData)
  app.setPath('sessionData', launch.paths.sessionData)
  app.setPath('temp', launch.paths.appTemp)
  app.setPath('logs', launch.paths.logs)
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  // This cell has no window at all; a created window means the measurement is not what it claims.
  app.on('browser-window-created', () => {
    stderr('a BrowserWindow was created although this cell is main-only')
    app.exit(1)
  })
  // SIGTERM from the parent's identity-checked stop is a normal end of this fixture process.
  process.on('SIGTERM', () => { app.exit(0) })
  // An IPC listener keeps this process reachable for the parent after the single notification.
  process.on('message', () => {})
  app.whenReady().then(async () => { await runCell(launch) }).catch((error: unknown) => {
    stderr(`trial entry failed: ${errorMessage(error)}`)
    notify({ status: 'error', error: errorMessage(error) })
  })
}

function main(): void {
  let launch: Launch
  try {
    launch = readLaunch(process.env)
  } catch (error) {
    stderr(`invalid launch description: ${errorMessage(error)}`)
    app.exit(1)
    return
  }
  boot(launch)
}

main()
