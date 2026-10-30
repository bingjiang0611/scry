// Fixed 50k Electron main trial entry (measurement only).
//
// One process, no BrowserWindow, no renderer, no TLS, no client and no Provider: this entry measures exactly
// the single-run main projection/revision work that scripts/fixtures/concurrency-trace-main-trial.ts defines,
// through the timed sample in scripts/fixtures/concurrency-trace-main-50k-sample.ts. DesktopRemoteClient caps
// one read at 10000 items, so this stays a host-side projection/revision claim and never a client or
// capability claim.
//
// Ownership contract with the launcher: this process writes one report, sends exactly one fixed-schema
// notification, and then stays alive. It never quits on its own, so the owner's stopOwnedApp sees a live tree
// and can capture it; the only exit is the owner's SIGTERM, which exits with code 0. For the same reason an
// unexpected BrowserWindow is recorded as a fault instead of exiting: exiting would leave the tree uncaptured.
//
// Path setup follows the R5 entry: every Electron path is set before ready, activation is prohibited on
// darwin, and each configured path must be absolute and inside the launcher's private directory.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { app } from 'electron'
import type { MainTrialNegativeControl } from './concurrency-trace-main-trial'
import { MAIN_50K_FIXED_ITEMS, assembleReport, runTimedSample, type TrialReport } from './concurrency-trace-main-50k-sample'

const CONFIG_ENV = 'SCRY_CONCURRENCY_TRACE_MAIN_50K_CONFIG'
export const MAIN_50K_NOTIFICATION = 'concurrency-trace-main-50k'
export { MAIN_50K_FIXED_ITEMS }

export interface Main50kPaths {
  /** The private trial directory every other path must live inside. */
  root: string
  home: string
  userData: string
  sessionData: string
  appTemp: string
  logs: string
  resultPath: string
}

export interface Main50kConfig {
  schema: 1
  k: number
  negativeControl: MainTrialNegativeControl | null
  paths: Main50kPaths
}

export interface Main50kRuntime {
  pid: number
  electron: string
  node: string
  v8: string
  chrome: string
  platform: string
  arch: string
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const stderr = (message: string): void => { process.stderr.write(`[scry:concurrency-trace-main-50k] ${message}\n`) }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Lexical layout check only (resolve + relative): it does not resolve symlinks and is not an isolation
// boundary against another process running as the same user. It stops a misconfigured run from writing
// outside the tree it reports, nothing more.
function requireInside(root: string, value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  const resolved = resolve(value)
  const inside = relative(root, resolved)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`${label} must live inside the private trial directory`)
  }
  return resolved
}

export function parseMain50kConfig(raw: string | undefined): Main50kConfig {
  if (!raw) throw new Error(`missing ${CONFIG_ENV}`)
  const parsed: unknown = JSON.parse(raw)
  if (!record(parsed) || !record(parsed.paths)) throw new Error(`${CONFIG_ENV} must be an object with paths`)
  if (parsed.schema !== 1) throw new Error(`config schema must be 1, got ${JSON.stringify(parsed.schema)}`)
  // Fixed workload: any other item count would be a different measurement wearing this entry's name.
  if (parsed.k !== MAIN_50K_FIXED_ITEMS) throw new Error(`this entry always runs k=${MAIN_50K_FIXED_ITEMS}, got ${JSON.stringify(parsed.k)}`)
  const rawControl = parsed.negativeControl
  if (rawControl !== undefined && rawControl !== null && rawControl !== 'corrupt-body') {
    throw new Error(`unknown negative control ${JSON.stringify(rawControl)}`)
  }
  const control: MainTrialNegativeControl | null = rawControl ?? null
  const rawPaths = parsed.paths
  if (typeof rawPaths.root !== 'string' || !isAbsolute(rawPaths.root)) throw new Error('paths.root must be an absolute private directory')
  const root = resolve(rawPaths.root)
  return {
    schema: 1,
    k: MAIN_50K_FIXED_ITEMS,
    negativeControl: control,
    paths: {
      root,
      home: requireInside(root, rawPaths.home, 'paths.home'),
      userData: requireInside(root, rawPaths.userData, 'paths.userData'),
      sessionData: requireInside(root, rawPaths.sessionData, 'paths.sessionData'),
      appTemp: requireInside(root, rawPaths.appTemp, 'paths.appTemp'),
      logs: requireInside(root, rawPaths.logs, 'paths.logs'),
      resultPath: requireInside(root, rawPaths.resultPath, 'paths.resultPath')
    }
  }
}

const runtimeFacts = (): Main50kRuntime => ({
  pid: process.pid,
  electron: process.versions.electron ?? 'unavailable',
  node: process.versions.node,
  v8: process.versions.v8,
  chrome: process.versions.chrome ?? 'unavailable',
  platform: process.platform,
  arch: process.arch
})

/** Exactly one message with a fixed shape: a status, the result path and, for a failure, its original text. */
function notify(payload: { status: string, resultPath?: string, error?: string }): void {
  if (typeof process.send !== 'function' || process.connected === false) {
    stderr('completion notification channel is not connected; the owner will see the result file only')
    return
  }
  process.send({ type: MAIN_50K_NOTIFICATION, schema: 1, ...payload })
}

interface CellPayload extends TrialReport {
  runtime: Main50kRuntime
  paths: Main50kPaths
  windowFaults: string[]
}

function writeReport(payload: CellPayload, resultPath: string): void {
  mkdirSync(dirname(resultPath), { recursive: true })
  writeFileSync(resultPath, `${JSON.stringify(payload, null, 2)}\n`)
}

function runSample(config: Main50kConfig, windowFaults: readonly string[]): void {
  const measurement = runTimedSample({ negativeControl: config.negativeControl })
  const assembled = assembleReport({ controlRequested: config.negativeControl, measurement })
  // An unexpected window does not change the sample, but this run is no longer the main-only measurement it
  // claims to be, so it cannot be reported as measured.
  const report: TrialReport = windowFaults.length === 0
    ? assembled
    : { ...assembled, status: 'failed', failure: assembled.failure ?? { phase: null, step: null, error: windowFaults.join('; ') } }
  const payload: CellPayload = { ...report, runtime: runtimeFacts(), paths: config.paths, windowFaults: [...windowFaults] }
  try {
    writeReport(payload, config.paths.resultPath)
  } catch (error) {
    const writeMessage = `could not write the trial report: ${describe(error)}`
    stderr(writeMessage)
    notify({ status: 'error', error: report.failure === null ? writeMessage : report.failure.error })
    return
  }
  notify(report.failure === null
    ? { status: report.status, resultPath: config.paths.resultPath }
    : { status: report.status, resultPath: config.paths.resultPath, error: report.failure.error })
  stderr(`${report.status} reported; staying alive for the owner stop`)
}

function boot(config: Main50kConfig): void {
  const windowFaults: string[] = []
  // Paths are set before ready; the launcher also passes --user-data-dir to the browser process.
  app.setPath('userData', config.paths.userData)
  app.setPath('sessionData', config.paths.sessionData)
  app.setPath('temp', config.paths.appTemp)
  app.setPath('logs', config.paths.logs)
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  // This entry has no window at all; a created window means the measurement is not what it claims. It is
  // recorded and reported, never exited on: an exit here would leave the process tree uncaptured.
  app.on('browser-window-created', () => {
    windowFaults.push('a BrowserWindow was created although this entry is main-only')
    stderr('a BrowserWindow was created although this entry is main-only')
  })
  process.on('SIGTERM', () => { app.exit(0) })
  // An IPC listener keeps this process reachable for the owner after the single notification.
  process.on('message', () => {})
  app.whenReady().then(() => { runSample(config, windowFaults) }).catch((error: unknown) => {
    stderr(`sample entry failed: ${describe(error)}`)
    notify({ status: 'error', error: `sample entry failed: ${describe(error)}` })
  })
}

function main(): void {
  let config: Main50kConfig
  try {
    config = parseMain50kConfig(process.env[CONFIG_ENV])
  } catch (error) {
    stderr(`invalid launch description: ${describe(error)}`)
    app.exit(1)
    return
  }
  boot(config)
}

main()
