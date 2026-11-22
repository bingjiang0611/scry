import type { HostAdminNotice } from '../../shared/host-admin'
import { DaemonClient, DaemonClientError, daemonClientPaths, type DaemonProbeInfo } from '../daemon-client'
import { ensureDaemon, type DaemonLaunch, type DaemonProbe } from '../daemon-supervisor'
import { DaemonRunRuntime, type DaemonRunRuntimeDeps } from '../daemon-run-runtime'
import type { RunTraceRouter } from '../run-trace-router'
import { startDaemonRunEvents } from '../daemon-run-events'
import { DaemonExecutionTargetPump, type AppShellOps } from '../daemon-execution-target-pump'
import type { DesktopRemoteTargetAPI } from '../../shared/desktop-remote'
import type { DockBadgeState } from '../dock-badge'
import { DaemonRunTransport } from '../daemon-run-transport'
import { laneForRequest } from '../remote/desktop-lane'
import { createDaemonRunSurface, type DaemonRunSurface } from './daemon-run-surface'
import { isDefaultAppUserDataDir } from '../daemon-mode-default'

export { appDaemonModeDeps } from './app-daemon-mode-deps'

// The App's own run surface: the App talks to the daemon that owns the ledger and the
// runs; there is no in-process pipeline to fall back to (S3).
//
// Nothing here retries, replaces, or hides a daemon. A version mismatch is the
// user's decision (restart the background service); a missing secret or a grant
// the daemon revoked is reported as such; unsafe credential storage refuses before
// a credential is written.

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
  status: 'ready' | 'version-mismatch' | 'unavailable' | 'credential-unavailable' | 'device-not-authorized'
  surface?: DaemonRunSurface
  version?: string
  running?: string
  expected?: string
  /** version-mismatch: the build ids behind `running` and `expected`, when each side has one (A5). */
  runningBuild?: string
  /** version-mismatch: active runs reported by the running daemon over daemonInfo, when known (W15). */
  runningActiveRuns?: number
  /** version-mismatch: whether the running daemon reported itself as packaged, when known (W15 S2). */
  runningIsPackaged?: boolean
  /** version-mismatch: live daemonInfo activeRuns probe over the existing client before signalling (W15 S1). */
  probeActiveRuns?: () => Promise<number | undefined>
  expectedBuild?: string
  action?: 'restart_daemon'
  reason?: string
  dispose?: () => void
}

export interface DaemonRunModeDeps {
  userDataDir: string
  daemonStateDirectory: string
  appVersion: string
  /** Optional appData + appName for S3 fail-closed test-instance isolation check. */
  appDataDir?: string
  appName?: string
  env?: NodeJS.ProcessEnv
  /** This bundle's build id (shared/build-identity.ts); absent when unbundled. */
  appBuild?: string
  /** Returns the credential cipher, or the reason it must not be used. */
  credentialCipher: () => { ok: true; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string } | { ok: false; reason: string }
  send: (channel: string, payload: unknown) => void
  currentCwd: () => string | undefined
  /** Client-level probe: a thrown DaemonClientError is a refusal, `undefined` is absence. */
  probe?: () => Promise<DaemonProbeInfo | undefined>
  launch?: DaemonLaunch
  /** Fallback direct launch when a service-manager launch timed out waiting for ready (P5 §2.4). */
  launchFallback?: DaemonLaunch
  launchFailure?: () => Promise<string | undefined>
  /** Tests: shorten ensureDaemon's ready wait (defaults to DAEMON_READY_TIMEOUT_MS). */
  readyTimeoutMs?: number
  waitMs?: number
  onWarn?: (message: string, detail?: unknown) => void
  // E1b: this window's badge mirrors the daemon's unread set and decides what was viewed.
  dockBadge?: Pick<DockBadgeState, 'setDaemon' | 'bindDaemon' | 'forgetDaemon' | 'view'>
  isWindowFocused?: () => boolean
  rendererCanReceive?: () => boolean
  // P3f W2: this window's run-level subscriptions also see the runs it follows here.
  runTraces?: NonNullable<DaemonRunRuntimeDeps['runTraces']> & Pick<RunTraceRouter, 'attachRuns' | 'publishStopState'>
  // W10: App-side desktop client that fulfills phone-originated execution-target calls forwarded by the daemon.
  desktopRemoteClient?: () => DesktopRemoteTargetAPI
  // W17: App-side Electron shell ops bridged for remote workbench openPath/trashItem.
  shellOps?: AppShellOps
  // P5-7: host CLI admin notice handler (system notification + open devices).
  onHostAdmin?: (notice: HostAdminNotice) => void
}

// Answers from the daemon that a launch or a retry cannot change.
const REFUSALS: ReadonlySet<string> = new Set([
  'daemon_version_mismatch', 'daemon_device_not_authorized', 'daemon_local_grant_corrupt', 'daemon_enrollment_unavailable'
])

/**
 * The App picks its run path once, at connect: the P4-3 subscribe path only when the
 * daemon it reached advertises `subscribe: 1` (SCRY_ORCHESTRATION=on); every other
 * daemon keeps the watch / liveRuns path unchanged.
 */
export async function connectForRunMode(
  client: { connect(): Promise<{ version: string }>; readonly subscribeSupported: boolean }
): Promise<{ version: string; subscribeMode: boolean }> {
  const { version } = await client.connect()
  return { version, subscribeMode: client.subscribeSupported === true }
}

export async function createDaemonRunMode(deps: DaemonRunModeDeps): Promise<DaemonRunModeResult> {
  const env = deps.env ?? process.env
  if (env.SCRY_TEST_APP === '1' && deps.appDataDir && deps.appName &&
      isDefaultAppUserDataDir({ userDataDir: deps.userDataDir, appDataDir: deps.appDataDir, appName: deps.appName })) {
    return { status: 'unavailable', reason: 'test_app_requires_isolated_user_data' }
  }
  const mismatch = (
    running: string,
    runningBuild: string | undefined,
    runningActiveRuns?: number,
    runningIsPackaged?: boolean
  ): DaemonRunModeResult => ({
    status: 'version-mismatch', running, expected: deps.appVersion, action: 'restart_daemon',
    ...(runningBuild === undefined ? {} : { runningBuild }),
    ...(runningActiveRuns === undefined ? {} : { runningActiveRuns }),
    ...(runningIsPackaged === undefined ? {} : { runningIsPackaged }),
    ...(deps.appBuild === undefined ? {} : { expectedBuild: deps.appBuild })
  })

  const cipher = deps.credentialCipher()
  if (!cipher.ok) return { status: 'credential-unavailable', reason: cipher.reason }

  const client = new DaemonClient({
    paths: daemonClientPaths(deps.daemonStateDirectory, deps.userDataDir),
    appVersion: deps.appVersion,
    ...(deps.appBuild === undefined ? {} : { appBuild: deps.appBuild }),
    encrypt: cipher.encrypt,
    decrypt: cipher.decrypt
  })
  // The probe answers "is one there, and may we use it?" without spending the grant:
  // `connect()` discards a credential when the daemon does not answer, which would
  // make a daemon that is merely stopped look like a revoked device.
  const connect = async (): Promise<DaemonProbeInfo | undefined> =>
    // Before the first grant the only way to learn the daemon is ready is to enroll;
    // afterwards a stopped daemon must not cost the credential its restart needs.
    client.hasGrant ? await client.daemonInfo() : await client.connect()
  // A refusal is an answer, not "not there yet". The supervisor treats a thrown probe
  // as absent and would launch a daemon that refuses again, so the refusal is
  // remembered here and short-circuits before any launch, or ends the wait for one.
  let refused: DaemonClientError | undefined
  const probe: DaemonProbe = async () => {
    try {
      return deps.probe ? await deps.probe() : await connect()
    } catch (error) {
      if (error instanceof DaemonClientError && REFUSALS.has(error.reason)) refused ??= error
      return undefined
    }
  }
  const refusal = (error: DaemonClientError): DaemonRunModeResult => {
    client.close()
    // Before the first grant the enrollment reply is the only place the daemon says
    // which version it is; without it the version stays unknown, never guessed.
    if (error.reason === 'daemon_version_mismatch') return mismatch(error.running ?? 'unknown', error.runningBuild)
    // A6: a daemon that answers its enrollment socket with no secret for an App without a
    // grant holds a live local grant for another credential (this App's lost one, or
    // another instance's). For the user that is a refused local connection: the same
    // reconnect state, and only the confirmed 「重新连接本机后台服务」 changes it. Launching
    // cannot: the new daemon finds daemon.lock held and exits.
    if (error.reason === 'daemon_device_not_authorized' || error.reason === 'daemon_enrollment_unavailable') {
      return { status: 'device-not-authorized', reason: error.reason }
    }
    return { status: 'unavailable', reason: error.reason }
  }

  await probe()
  if (refused) return refusal(refused)

  const launch: DaemonLaunch = deps.launch ?? (async () => ({ status: 'failed' as const, reason: 'daemon_launch_unavailable' }))
  const supervision = {
    probe, launch, appVersion: deps.appVersion, ...(deps.appBuild === undefined ? {} : { appBuild: deps.appBuild }),
    ...(deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs, pollMs: Math.min(25, deps.readyTimeoutMs) }),
    // Polled while waiting for a launched daemon: a refusal ends the wait by name.
    launchFailure: async (): Promise<string | undefined> => refused?.reason ?? await deps.launchFailure?.()
  }
  let supervised = await ensureDaemon(supervision)
  if (!refused && supervised.status === 'unavailable' && supervised.reason === 'daemon_ready_timeout' && deps.launchFallback) {
    supervised = await ensureDaemon({ ...supervision, launch: deps.launchFallback })
  }
  if (refused) return refusal(refused)
  if (supervised.status === 'version-mismatch') {
    return {
      ...mismatch(supervised.running, supervised.runningBuild, supervised.runningActiveRuns, supervised.runningIsPackaged),
      probeActiveRuns: () => client.daemonInfo().then((info) => info?.activeRuns, () => undefined),
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
  let subscribeMode = false
  try {
    const connected = await connectForRunMode(client)
    version = connected.version
    subscribeMode = connected.subscribeMode
  } catch (error) {
    client.close()
    if (error instanceof DaemonClientError && error.reason === 'daemon_version_mismatch') {
      return mismatch(error.running ?? supervised.version, error.runningBuild)
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
      const again = await ensureDaemon(supervision)
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
    ...(subscribeMode ? { subscribeMode: true } : {}),
    ...(deps.waitMs === undefined ? {} : { waitMs: deps.waitMs }),
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    ...(deps.runTraces ? { runTraces: deps.runTraces } : {})
  })
  const detachRuns = deps.runTraces?.attachRuns({
    get: (runId) => { const run = runtime.runView(runId); return run ? { state: run } : undefined }
  })
  const surface = createDaemonRunSurface({
    transport, runtime, subscribeMode, currentCwd: deps.currentCwd, send: deps.send,
    watchDetail: (key) => events.watchDetail(key)
  })
  const events = startDaemonRunEvents({
    transport, runtime, ...(subscribeMode ? { subscribeMode: true } : {}), send: deps.send, focusedRun: () => surface.focusedRunSnapshot(),
    ...(deps.dockBadge ? { dockBadge: deps.dockBadge } : {}),
    ...(deps.isWindowFocused ? { isWindowFocused: deps.isWindowFocused } : {}),
    ...(deps.rendererCanReceive ? { rendererCanReceive: deps.rendererCanReceive } : {}),
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    ...(deps.runTraces ? { runTraces: deps.runTraces } : {}),
    ...(deps.onHostAdmin ? { onHostAdmin: deps.onHostAdmin } : {})
  })
  const targetPump = deps.desktopRemoteClient || deps.shellOps
    ? new DaemonExecutionTargetPump({
      source: transport,
      ...(deps.desktopRemoteClient ? { client: deps.desktopRemoteClient } : {}),
      ...(deps.shellOps ? { shellOps: deps.shellOps } : {}),
      ...(deps.waitMs !== undefined ? { waitMs: deps.waitMs } : {}),
      ...(deps.onWarn ? { onWarn: deps.onWarn } : {})
    })
    : undefined
  targetPump?.start()
  return {
    status: 'ready',
    version,
    surface,
    dispose: () => { targetPump?.dispose(); events.dispose(); detachRuns?.(); runtime.dispose(); client.close() }
  }
}
