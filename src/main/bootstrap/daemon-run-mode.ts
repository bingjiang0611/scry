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
  runningBuild?: string
  runningActiveRuns?: number
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
  appBuild?: string
  credentialCipher: () => { ok: true; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string } | { ok: false; reason: string }
  send: (channel: string, payload: unknown) => void
  currentCwd: () => string | undefined
  /** Client-level probe: `undefined` means no daemon info; only recognized refusal errors are preserved. */
  probe?: () => Promise<DaemonProbeInfo | undefined>
  launch?: DaemonLaunch
  /** Fallback direct launch when a service-manager launch timed out waiting for ready (P5 §2.4). */
  launchFallback?: DaemonLaunch
  launchFailure?: () => Promise<string | undefined>
  readyTimeoutMs?: number
  waitMs?: number
  onWarn?: (message: string, detail?: unknown) => void
  dockBadge?: Pick<DockBadgeState, 'setDaemon' | 'bindDaemon' | 'forgetDaemon' | 'view'>
  isWindowFocused?: () => boolean
  rendererCanReceive?: () => boolean
  runTraces?: NonNullable<DaemonRunRuntimeDeps['runTraces']> & Pick<RunTraceRouter, 'attachRuns' | 'publishStopState'>
  desktopRemoteClient?: () => DesktopRemoteTargetAPI
  shellOps?: AppShellOps
  onHostAdmin?: (notice: HostAdminNotice) => void
}

const REFUSALS: ReadonlySet<string> = new Set([
  'daemon_version_mismatch', 'daemon_device_not_authorized', 'daemon_local_grant_corrupt', 'daemon_enrollment_unavailable'
])

/** The App requires the daemon’s authoritative subscription before entering run mode. */
export async function connectForRunMode(
  client: { connect(): Promise<{ version: string }>; readonly subscribeSupported: boolean }
): Promise<{ version: string }> {
  const connected = await client.connect()
  if (!client.subscribeSupported) throw new Error('daemon_subscribe_unavailable')
  return connected
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
  const connect = async (): Promise<DaemonProbeInfo | undefined> =>
    client.hasGrant ? await client.daemonInfo() : await client.connect()
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
    if (error.reason === 'daemon_version_mismatch') return mismatch(error.running ?? 'unknown', error.runningBuild)
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
  let version: string
  try {
    const connected = await connectForRunMode(client)
    version = connected.version
  } catch (error) {
    client.close()
    if (error instanceof DaemonClientError && error.reason === 'daemon_version_mismatch') {
      return mismatch(error.running ?? supervised.version, error.runningBuild)
    }
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'daemon_connect_failed' }
  }

  let reconnecting: Promise<void> | undefined
  const reconnect = async (): Promise<void> => {
    reconnecting ??= (async () => {
      client.close()
      const again = await ensureDaemon(supervision)
      if (again.status === 'unavailable' || again.status === 'version-mismatch') {
        throw new DaemonClientError('daemon_not_running')
      }
      await connectForRunMode(client)
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
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    ...(deps.runTraces ? { runTraces: deps.runTraces } : {})
  })
  const detachRuns = deps.runTraces?.attachRuns({
    get: (runId) => { const run = runtime.runView(runId); return run ? { state: run } : undefined }
  })
  const surface = createDaemonRunSurface({
    transport, runtime, currentCwd: deps.currentCwd, send: deps.send,
    watchDetail: (key) => events.watchDetail(key)
  })
  const events = startDaemonRunEvents({
    transport, runtime, send: deps.send, focusedRun: () => surface.focusedRunSnapshot(),
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
