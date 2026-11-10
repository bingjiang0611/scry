import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { DaemonClient, DaemonClientError, daemonClientPaths } from '../daemon-client'
import { daemonLaunchTarget, spawnDaemonSupervisor } from './daemon-launch'
import { unsafeCredentialStorageReason } from './remote-connections'
import { ensureDaemon, type DaemonLaunch, type DaemonProbe } from '../daemon-supervisor'
import { readDaemonLaunchFailure } from '../daemon-launch-failure'
import { DaemonRunRuntime, type DaemonRunRuntimeDeps } from '../daemon-run-runtime'
import type { RunTraceRouter } from '../run-trace-router'
import { startDaemonRunEvents } from '../daemon-run-events'
import type { DockBadgeState } from '../dock-badge'
import { DaemonRunTransport } from '../daemon-run-transport'
import { laneForRequest } from '../remote/desktop-lane'
import { createDaemonRunSurface, type DaemonRunSurface } from './daemon-run-surface'

// Daemon mode for the App's own run surface. One switch, one decision: either the
// App talks to the daemon that owns the ledger and the runs, or it does not start
// this path at all and the caller keeps the in-process pipeline.
//
// Nothing here retries, replaces, or hides a daemon. A version mismatch is the
// user's decision (restart the background service); a missing secret or a grant
// the daemon revoked is reported as such; unsafe credential storage refuses before
// a credential is written.

// The switch itself lives beside the IPC gate, which must not import this assembly.
import { DAEMON_MODE_ENV, daemonModeEnabled } from '../daemon-channel-gate'
export { DAEMON_MODE_ENV, daemonModeEnabled }

/**
 * Whether a failed request may be retried after the daemon is relaunched. A read the
 * caller declared replayable can be asked again — it changes nothing. A write cannot:
 * its reply may have been lost after the daemon already applied it.
 */
export function retryAfterReconnect(error: unknown, replayable: boolean): boolean {
  if (!replayable) return false
  const reason = (error as { reason?: unknown } | null)?.reason
  return reason === 'daemon_not_running' || reason === 'daemon_outcome_unknown'
}

export interface DaemonRunModeResult {
  status: 'disabled' | 'ready' | 'version-mismatch' | 'unavailable' | 'credential-unavailable' | 'device-not-authorized'
  surface?: DaemonRunSurface
  version?: string
  running?: string
  expected?: string
  action?: 'restart_daemon'
  reason?: string
  dispose?: () => void
}

export interface DaemonRunModeDeps {
  userDataDir: string
  daemonStateDirectory: string
  appVersion: string
  /** Returns the credential cipher, or the reason it must not be used. */
  credentialCipher: () => { ok: true; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string } | { ok: false; reason: string }
  send: (channel: string, payload: unknown) => void
  currentCwd: () => string | undefined
  /** Client-level probe: a thrown DaemonClientError is a refusal, `undefined` is absence. */
  probe?: () => Promise<{ version: string } | undefined>
  launch?: DaemonLaunch
  launchFailure?: () => Promise<string | undefined>
  waitMs?: number
  onWarn?: (message: string, detail?: unknown) => void
  // E1b: this window's badge mirrors the daemon's unread set and decides what was viewed.
  dockBadge?: Pick<DockBadgeState, 'setDaemon' | 'bindDaemon' | 'forgetDaemon' | 'view'>
  isWindowFocused?: () => boolean
  // P3f W2: this window's run-level subscriptions also see the runs it follows here.
  runTraces?: NonNullable<DaemonRunRuntimeDeps['runTraces']> & Pick<RunTraceRouter, 'attachRuns' | 'publishStopState'>
}

export async function createDaemonRunMode(deps: DaemonRunModeDeps): Promise<DaemonRunModeResult> {
  if (!daemonModeEnabled()) return { status: 'disabled' }

  const cipher = deps.credentialCipher()
  if (!cipher.ok) return { status: 'credential-unavailable', reason: cipher.reason }

  const client = new DaemonClient({
    paths: daemonClientPaths(deps.daemonStateDirectory, deps.userDataDir),
    appVersion: deps.appVersion,
    encrypt: cipher.encrypt,
    decrypt: cipher.decrypt
  })
  // The probe answers "is one there, and may we use it?" without spending the grant:
  // `connect()` discards a credential when the daemon does not answer, which would
  // make a daemon that is merely stopped look like a revoked device.
  const connect = async (): Promise<string | undefined> =>
    // Before the first grant the only way to learn the daemon is ready is to enroll;
    // afterwards a stopped daemon must not cost the credential its restart needs.
    client.hasGrant ? await client.daemonInfo() : (await client.connect()).version
  // A refusal is an answer, not "not there yet". The supervisor treats a thrown probe
  // as absent and would launch a daemon that refuses again, so the refusal is
  // remembered here and short-circuits before any launch.
  let refused: DaemonClientError | undefined
  const probe: DaemonProbe = async () => {
    try {
      const probed = deps.probe ? await deps.probe() : await connect().then((version) => version === undefined ? undefined : { version })
      return probed
    } catch (error) {
      if (error instanceof DaemonClientError &&
          (error.reason === 'daemon_version_mismatch' || error.reason === 'daemon_device_not_authorized' || error.reason === 'daemon_local_grant_corrupt')) {
        refused ??= error
      }
      return undefined
    }
  }

  await probe()
  if (refused) {
    client.close()
    if (refused.reason === 'daemon_version_mismatch') {
      return { status: 'version-mismatch', running: 'unknown', expected: deps.appVersion, action: 'restart_daemon' }
    }
    return refused.reason === 'daemon_device_not_authorized'
      ? { status: 'device-not-authorized', reason: refused.reason }
      : { status: 'unavailable', reason: refused.reason }
  }

  const launch: DaemonLaunch = deps.launch ?? (async () => ({ status: 'failed' as const, reason: 'daemon_launch_unavailable' }))
  const supervised = await ensureDaemon({ probe, launch, appVersion: deps.appVersion, launchFailure: deps.launchFailure })
  if (supervised.status === 'version-mismatch') {
    return {
      status: 'version-mismatch', running: supervised.running, expected: supervised.expected, action: supervised.action,
      dispose: () => client.close()
    }
  }
  if (supervised.status === 'unavailable') {
    client.close()
    return { status: 'unavailable', reason: supervised.reason }
  }
  // The supervisor only adopted what it probed; this second connect is what loads
  // the stored grant and refuses a daemon built from other sources.
  let version: string
  try {
    version = (await client.connect()).version
  } catch (error) {
    client.close()
    if (error instanceof DaemonClientError && error.reason === 'daemon_version_mismatch') {
      return { status: 'version-mismatch', running: supervised.version, expected: deps.appVersion, action: 'restart_daemon' }
    }
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'daemon_connect_failed' }
  }

  // A daemon that exited takes its channels with it. The supervisor adopts or launches
  // one, and the client reconnects against the grant it already holds. Only a request
  // the caller declared replayable is retried: a write whose outcome is unknown is
  // reported, never resubmitted (the device lane has the same rule).
  let reconnecting: Promise<void> | undefined
  const reconnect = async (): Promise<void> => {
    reconnecting ??= (async () => {
      // The channels to the daemon that exited are dead sockets; keeping them would
      // fail every retried read on a lane that can never answer.
      client.close()
      const again = await ensureDaemon({ probe, launch, appVersion: deps.appVersion, launchFailure: deps.launchFailure })
      if (again.status === 'unavailable' || again.status === 'version-mismatch') {
        throw new DaemonClientError('daemon_not_running')
      }
      await client.connect()
    })()
    try { await reconnecting } finally { reconnecting = undefined }
  }
  const transport = new DaemonRunTransport(async (request, options) => {
    const call = async (): Promise<unknown> => await client.request(
      laneForRequest(request), request,
      { replayable: options?.replayable ?? false, ...(options?.signal ? { signal: options.signal } : {}) }
    )
    try {
      return await call()
    } catch (error) {
      if (!retryAfterReconnect(error, options?.replayable ?? false)) throw error
      await reconnect()
      return await call()
    }
  })
  const runtime = new DaemonRunRuntime({
    transport,
    send: deps.send,
    ...(deps.waitMs === undefined ? {} : { waitMs: deps.waitMs }),
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    ...(deps.runTraces ? { runTraces: deps.runTraces } : {})
  })
  const detachRuns = deps.runTraces?.attachRuns({
    get: (runId) => { const run = runtime.runView(runId); return run ? { state: run } : undefined }
  })
  const surface = createDaemonRunSurface({ transport, runtime, currentCwd: deps.currentCwd })
  const events = startDaemonRunEvents({
    transport, runtime, send: deps.send, focusedRun: () => surface.focusedRunSnapshot(),
    ...(deps.dockBadge ? { dockBadge: deps.dockBadge } : {}),
    ...(deps.isWindowFocused ? { isWindowFocused: deps.isWindowFocused } : {}),
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    ...(deps.runTraces ? { runTraces: deps.runTraces } : {})
  })
  return {
    status: 'ready',
    version,
    surface,
    dispose: () => { events.dispose(); detachRuns?.(); runtime.dispose(); client.close() }
  }
}

/**
 * The App's own wiring for daemon mode: the same credential rule paired devices use,
 * a log file the daemon owns, and the supervisor launched through the packaged or
 * development entry. Kept here so the main entry only decides whether to use it.
 */
export function appDaemonModeDeps(input: {
  send: (channel: string, payload: unknown) => void
  currentCwd: () => string | undefined
  dockBadge?: DaemonRunModeDeps['dockBadge']
  isWindowFocused?: () => boolean
  runTraces?: DaemonRunModeDeps['runTraces']
  env?: NodeJS.ProcessEnv
}): DaemonRunModeDeps {
  const userDataDir = app.getPath('userData')
  const daemonStateDirectory = join(userDataDir, 'daemon')
  const appVersion = app.getVersion()
  const appPath = app.getAppPath()
  const isPackaged = app.isPackaged
  let launchedAt = Number.POSITIVE_INFINITY
  return {
    userDataDir,
    daemonStateDirectory,
    appVersion,
    credentialCipher: () => {
      // Acceptance only. A dev Electron cannot answer the macOS "Safe Storage" Keychain
      // prompt, and isEncryptionAvailable() blocks on it, so an isolated test instance
      // would hang before its window loads. This codec keeps the same 0600 file and the
      // same envelope but stores base64; it needs SCRY_TEST_APP=1 plus an explicit
      // variable, so a normal install never reaches it.
      if (process.env.SCRY_TEST_APP === '1' && process.env.SCRY_DAEMON_CREDENTIAL_PLAINTEXT === '1') {
        return {
          ok: true as const,
          encrypt: (value: string) => Buffer.from(value, 'utf8'),
          decrypt: (value: Buffer) => value.toString('utf8')
        }
      }
      const unsafe = unsafeCredentialStorageReason({
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        storageBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined
      })
      if (unsafe) return { ok: false, reason: 'unsafe_credential_storage' }
      return {
        ok: true,
        encrypt: (value: string) => safeStorage.encryptString(value),
        decrypt: (value: Buffer) => safeStorage.decryptString(value)
      }
    },
    send: input.send,
    currentCwd: input.currentCwd,
    ...(input.dockBadge ? { dockBadge: input.dockBadge } : {}),
    ...(input.isWindowFocused ? { isWindowFocused: input.isWindowFocused } : {}),
    ...(input.runTraces ? { runTraces: input.runTraces } : {}),
    // The pump stops on its own after a failure; without this line the reason would be
    // dropped and the window would just never update.
    onWarn: (message, detail) => {
      console.error(`[scry] ${message}`, detail instanceof Error ? `${detail.name}: ${detail.message}` : detail ?? '')
    },
    launchFailure: () => readDaemonLaunchFailure(daemonStateDirectory, launchedAt),
    launch: async () => {
      launchedAt = Date.now()
      const started = spawnDaemonSupervisor({
        target: daemonLaunchTarget({ isPackaged, appPath, execPath: process.execPath }),
        stateDirectory: daemonStateDirectory,
        userDataDir,
        appPath,
        resourcesPath: process.resourcesPath,
        appVersion,
        isPackaged,
        ...(input.env ? { env: input.env } : {})
      })
      return started.status === 'started' ? { status: 'started' as const } : { status: 'failed' as const, reason: started.reason ?? 'daemon_spawn_failed' }
    }
  }
}
