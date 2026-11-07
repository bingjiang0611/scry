import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { DaemonClient, DaemonClientError, daemonClientPaths } from '../daemon-client'
import { daemonLaunchTarget, spawnDaemonSupervisor } from './daemon-launch'
import { unsafeCredentialStorageReason } from './remote-connections'
import { ensureDaemon, type DaemonLaunch, type DaemonProbe } from '../daemon-supervisor'
import { DaemonRunRuntime } from '../daemon-run-runtime'
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

export const DAEMON_MODE_ENV = 'SCRY_HOST_DAEMON'

export function daemonModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DAEMON_MODE_ENV] === '1'
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
  waitMs?: number
  onWarn?: (message: string, detail?: unknown) => void
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
  const connect = async (): Promise<string | undefined> => (await client.connect()).version
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

  const supervised = await ensureDaemon({
    probe,
    launch: deps.launch ?? (async () => ({ status: 'failed' as const, reason: 'daemon_launch_unavailable' })),
    appVersion: deps.appVersion
  })
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

  const transport = new DaemonRunTransport((request, options) => client.request(
    laneForRequest(request), request,
    { replayable: options?.replayable ?? false, ...(options?.signal ? { signal: options.signal } : {}) }
  ))
  const runtime = new DaemonRunRuntime({
    transport,
    send: deps.send,
    ...(deps.waitMs === undefined ? {} : { waitMs: deps.waitMs }),
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {})
  })
  const surface = createDaemonRunSurface({ transport, runtime, currentCwd: deps.currentCwd })
  return {
    status: 'ready',
    version,
    surface,
    dispose: () => { runtime.dispose(); client.close() }
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
  env?: NodeJS.ProcessEnv
}): DaemonRunModeDeps {
  const userDataDir = app.getPath('userData')
  const daemonStateDirectory = join(userDataDir, 'daemon')
  const appVersion = app.getVersion()
  const appPath = app.getAppPath()
  const isPackaged = app.isPackaged
  return {
    userDataDir,
    daemonStateDirectory,
    appVersion,
    credentialCipher: () => {
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
    launch: async () => {
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
