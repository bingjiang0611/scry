import type {
  BackgroundServiceConnection,
  BackgroundServiceDevices,
  BackgroundServiceLaunchedBy,
  BackgroundServiceRelayMode,
  BackgroundServiceRemoteConfig,
  BackgroundServiceRuntimeNotice,
  BackgroundServiceSelfReport,
  BackgroundServiceStatus,
  LoginStartStatus
} from '../shared/background-service'
import type { ProviderId } from '../shared/provider'
import type { CliApprovalStatus, HostCliApprovalSelfReport } from '../shared/host-admin'
import { isAgentPermissionMode } from '../shared/runtime-types'
import { diffRemoteConfigs } from '../daemon/login-start/policy-env'
import type { DaemonRunModeResult } from './bootstrap/daemon-run-mode'
import { mismatchLabels } from '../shared/build-identity'

// The «后台服务» status, composed from what the App can establish itself (its connection
// outcome, the verified daemon.lock holder) and what only the daemon knows (its local op
// `localBackgroundService:status`). A value nobody could establish stays null and the
// section shows it as unknown; the daemon's answer is data and is checked field by field.

export interface BackgroundServiceStatusDeps {
  daemonMode: boolean
  userDataDir: string
  connection(): Promise<BackgroundServiceConnection>
  /** The daemon's own report; called only while the connection is ready. */
  selfReport(): Promise<unknown>
  /** The daemon.lock holder whose identity verifies, if any. */
  lockHolder(): Promise<{ pid: number } | undefined>
  /** Login-start service state for this App/userData (P5 §2.3). */
  loginStart?: () => Promise<LoginStartStatus>
  /** Effective remote policy derived from this App's environment (P5 §2.2). */
  expectedRemoteConfig?: () => BackgroundServiceRemoteConfig
  /** Latest service-launch fallback warning, if any (P5 §2.4). */
  serviceLaunchFallback?: () => BackgroundServiceRuntimeNotice['serviceLaunchFallback']
  /** When true (SCRY_EXPERIMENTAL_HOST_CLI=1), expose CLI approval state in status (P5-5b). */
  hostCliExperimental?: boolean
  /** Absolute packaged `<resources>/bin/scry-host` path for copy-command helper. */
  hostCliPath?: string
  platform?: NodeJS.Platform
  now?: () => number
}

/** The lazy run surface's one outcome, in the words the section uses. */
export function connectionFromMode(result: DaemonRunModeResult, appVersion: string): BackgroundServiceConnection {
  switch (result.status) {
    case 'ready':
      return { state: 'ready' }
    case 'version-mismatch':
      return {
        state: 'version-mismatch',
        // Shown with the build ids only when the versions alone would read as equal (A5).
        ...mismatchLabels(
          { version: result.running && result.running !== 'unknown' ? result.running : null, ...(result.runningBuild ? { build: result.runningBuild } : {}) },
          { version: result.expected ?? appVersion, ...(result.expectedBuild ? { build: result.expectedBuild } : {}) }
        )
      }
    case 'device-not-authorized':
      return { state: 'device-not-authorized' }
    case 'credential-unavailable':
      return { state: 'unavailable', reason: result.reason ? `daemon_credential_unavailable:${result.reason}` : 'daemon_credential_unavailable' }
    case 'disabled':
      return { state: 'unavailable', reason: 'daemon_mode_disabled' }
    default:
      return { state: 'unavailable', reason: result.reason ?? 'daemon_unavailable' }
  }
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function devicesOf(value: unknown): BackgroundServiceDevices | undefined {
  const devices = value as { state?: unknown; paired?: unknown } | null
  if (!devices || typeof devices !== 'object') return undefined
  if (devices.state === 'remote-disabled' && Object.keys(devices).length === 1) return { state: 'remote-disabled' }
  if (devices.state === 'known' && count(devices.paired)) return { state: 'known', paired: devices.paired }
  return undefined
}

const RELAY_MODES: ReadonlySet<string> = new Set<BackgroundServiceRelayMode>(['public', 'custom_ws', 'custom_tcp', 'disabled'])
const PROVIDERS: ReadonlySet<string> = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi', 'antigravity'])

function remoteConfigOf(value: unknown): BackgroundServiceRemoteConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<Record<keyof BackgroundServiceRemoteConfig, unknown>>
  if (typeof raw.remoteHostEnabled !== 'boolean') return undefined
  if (typeof raw.relayMode !== 'string' || !RELAY_MODES.has(raw.relayMode)) return undefined
  if (raw.permissionModeOverride !== null && !isAgentPermissionMode(raw.permissionModeOverride)) return undefined
  if (!Array.isArray(raw.disabledProviders) || !raw.disabledProviders.every((p) => typeof p === 'string' && PROVIDERS.has(p))) return undefined
  if (typeof raw.runControlsEnabled !== 'boolean') return undefined
  if (raw.providerManifestUrl !== null && (typeof raw.providerManifestUrl !== 'string' || raw.providerManifestUrl.length > 2048)) return undefined
  return {
    remoteHostEnabled: raw.remoteHostEnabled,
    relayMode: raw.relayMode as BackgroundServiceRelayMode,
    permissionModeOverride: raw.permissionModeOverride,
    disabledProviders: [...raw.disabledProviders] as ProviderId[],
    runControlsEnabled: raw.runControlsEnabled,
    providerManifestUrl: raw.providerManifestUrl
  }
}

/** The daemon's report, or undefined when any field is not what the op promises. */
export function parseSelfReport(value: unknown): BackgroundServiceSelfReport | undefined {
  const report = value as Partial<Record<keyof BackgroundServiceSelfReport, unknown>> | null
  if (!report || typeof report !== 'object' || Array.isArray(report)) return undefined
  const devices = devicesOf(report.devices)
  if (typeof report.version !== 'string' || report.version.length === 0 || report.version.length > 128) return undefined
  if (!Number.isSafeInteger(report.pid) || (report.pid as number) <= 1) return undefined
  if (!count(report.startedAt) || !count(report.activeRuns) || !devices) return undefined
  let launchedBy: BackgroundServiceLaunchedBy | undefined
  if (report.launchedBy !== undefined) {
    if (report.launchedBy !== 'app' && report.launchedBy !== 'service') return undefined
    launchedBy = report.launchedBy
  }
  let supervisorPid: number | undefined
  if (report.supervisorPid !== undefined) {
    if (!Number.isSafeInteger(report.supervisorPid) || (report.supervisorPid as number) <= 1) return undefined
    supervisorPid = report.supervisorPid as number
  }
  let remoteConfig: BackgroundServiceRemoteConfig | undefined
  if (report.remoteConfig !== undefined) {
    remoteConfig = remoteConfigOf(report.remoteConfig)
    if (!remoteConfig) return undefined
  }
  let cliApproval: HostCliApprovalSelfReport | undefined
  if (report.cliApproval !== undefined) {
    const raw = report.cliApproval as Partial<HostCliApprovalSelfReport> | null
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.enabled !== 'boolean') return undefined
    if (raw.updatedAt !== null && !count(raw.updatedAt)) return undefined
    cliApproval = { enabled: raw.enabled, updatedAt: raw.updatedAt as number | null }
  }
  let orchestration: BackgroundServiceSelfReport['orchestration']
  if (report.orchestration !== undefined) {
    const raw = report.orchestration as Partial<NonNullable<BackgroundServiceSelfReport['orchestration']>> | null
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    if (raw.mode === 'on') {
      if (typeof raw.h1FallbackUnavailable !== 'boolean') return undefined
      if (raw.h1FallbackReason !== undefined && typeof raw.h1FallbackReason !== 'string') return undefined
      orchestration = {
        mode: 'on',
        h1FallbackUnavailable: raw.h1FallbackUnavailable,
        ...(raw.h1FallbackReason !== undefined ? { h1FallbackReason: raw.h1FallbackReason } : {})
      }
    }
    // Unknown orchestration.mode values are ignored rather than discarding the entire self-report.
  }
  return {
    version: report.version, pid: report.pid as number, startedAt: report.startedAt, devices, activeRuns: report.activeRuns,
    ...(launchedBy ? { launchedBy } : {}),
    ...(supervisorPid !== undefined ? { supervisorPid } : {}),
    ...(remoteConfig ? { remoteConfig } : {}),
    ...(cliApproval ? { cliApproval } : {}),
    ...(orchestration ? { orchestration } : {})
  }
}

export async function readBackgroundServiceStatus(deps: BackgroundServiceStatusDeps): Promise<BackgroundServiceStatus> {
  if (!deps.daemonMode) return { mode: 'in-process', userDataDir: deps.userDataDir }
  const connection = await deps.connection()
  const checkedAt = (deps.now ?? Date.now)()
  let report: BackgroundServiceSelfReport | undefined
  if (connection.state === 'ready') {
    try { report = parseSelfReport(await deps.selfReport()) } catch { report = undefined }
  }
  let loginStart: LoginStartStatus | undefined
  if (deps.loginStart) {
    try { loginStart = await deps.loginStart() } catch { loginStart = { state: 'unavailable', reason: 'login_start_status_failed' } }
  }
  const fallback = deps.serviceLaunchFallback?.()
  const platform = deps.platform ?? process.platform
  if (report) {
    const expected = deps.expectedRemoteConfig?.()
    const diffs = report.launchedBy === 'service' && report.remoteConfig && expected
      ? diffRemoteConfigs(expected, report.remoteConfig)
      : []
    const runtimeNotice: BackgroundServiceRuntimeNotice | undefined =
      fallback || diffs.length > 0
        ? {
          ...(fallback ? { serviceLaunchFallback: fallback } : {}),
          ...(diffs.length > 0 && expected && report.remoteConfig
            ? { remoteConfigMismatch: { diffs, expected, actual: report.remoteConfig } }
            : {})
        }
        : undefined
    const launchedByVerified = platform === 'linux' && report.launchedBy === 'service'
      ? loginStart?.state === 'enabled' && loginStart.linuxMainPid !== undefined && loginStart.linuxMainPid !== null &&
        report.supervisorPid !== undefined && loginStart.linuxMainPid === report.supervisorPid
      : false
    // N1: whenever the daemon reports cliApproval (e.g. a login-start daemon launched with
    // SCRY_EXPERIMENTAL_HOST_CLI=1 while this App started without it), always surface the row
    // so the user can inspect it and turn CLI approval off.
    const cliApproval: CliApprovalStatus | undefined = report.cliApproval
      ? {
        state: report.cliApproval.enabled ? 'enabled' : 'disabled',
        updatedAt: report.cliApproval.updatedAt,
        ...(deps.hostCliPath ? { hostCliPath: deps.hostCliPath } : {})
      }
      : deps.hostCliExperimental
        ? { state: 'unavailable', reason: 'daemon_host_cli_unavailable' }
        : undefined
    return {
      mode: 'daemon', userDataDir: deps.userDataDir, connection, checkedAt,
      version: report.version, pid: report.pid, startedAt: report.startedAt, devices: report.devices, activeRuns: report.activeRuns,
      ...(report.launchedBy !== undefined ? { launchedBy: report.launchedBy } : {}),
      ...(report.launchedBy === 'service' ? { launchedByVerified } : {}),
      ...(report.remoteConfig ? { remoteConfig: report.remoteConfig } : {}),
      ...(loginStart ? { loginStart } : {}),
      ...(cliApproval ? { cliApproval } : {}),
      ...(report.orchestration ? { orchestration: report.orchestration } : {}),
      ...(runtimeNotice ? { runtimeNotice } : {})
    }
  }
  // Without the daemon's answer only the verified lock holder is known. A mismatched
  // daemon may have said its version while refusing; nothing else is guessed.
  let pid: number | null = null
  try { pid = (await deps.lockHolder())?.pid ?? null } catch { pid = null }
  const cliApprovalUnavailable: CliApprovalStatus | undefined = deps.hostCliExperimental
    ? { state: 'unavailable', reason: connection.state === 'unavailable' ? connection.reason : `daemon_${connection.state.replaceAll('-', '_')}` }
    : undefined
  return {
    mode: 'daemon', userDataDir: deps.userDataDir, connection, checkedAt,
    version: connection.state === 'version-mismatch' ? connection.running : null,
    pid, startedAt: null, devices: null, activeRuns: null,
    ...(loginStart ? { loginStart } : {}),
    ...(cliApprovalUnavailable ? { cliApproval: cliApprovalUnavailable } : {}),
    ...(fallback ? { runtimeNotice: { serviceLaunchFallback: fallback } } : {})
  }
}
