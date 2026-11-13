import type { BackgroundServiceConnection, BackgroundServiceDevices, BackgroundServiceSelfReport, BackgroundServiceStatus } from '../shared/background-service'
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

/** The daemon's report, or undefined when any field is not what the op promises. */
export function parseSelfReport(value: unknown): BackgroundServiceSelfReport | undefined {
  const report = value as Partial<Record<keyof BackgroundServiceSelfReport, unknown>> | null
  if (!report || typeof report !== 'object' || Array.isArray(report)) return undefined
  const devices = devicesOf(report.devices)
  if (typeof report.version !== 'string' || report.version.length === 0 || report.version.length > 128) return undefined
  if (!Number.isSafeInteger(report.pid) || (report.pid as number) <= 1) return undefined
  if (!count(report.startedAt) || !count(report.activeRuns) || !devices) return undefined
  return { version: report.version, pid: report.pid as number, startedAt: report.startedAt, devices, activeRuns: report.activeRuns }
}

export async function readBackgroundServiceStatus(deps: BackgroundServiceStatusDeps): Promise<BackgroundServiceStatus> {
  if (!deps.daemonMode) return { mode: 'in-process', userDataDir: deps.userDataDir }
  const connection = await deps.connection()
  const checkedAt = (deps.now ?? Date.now)()
  let report: BackgroundServiceSelfReport | undefined
  if (connection.state === 'ready') {
    try { report = parseSelfReport(await deps.selfReport()) } catch { report = undefined }
  }
  if (report) {
    return {
      mode: 'daemon', userDataDir: deps.userDataDir, connection, checkedAt,
      version: report.version, pid: report.pid, startedAt: report.startedAt, devices: report.devices, activeRuns: report.activeRuns
    }
  }
  // Without the daemon's answer only the verified lock holder is known. A mismatched
  // daemon may have said its version while refusing; nothing else is guessed.
  let pid: number | null = null
  try { pid = (await deps.lockHolder())?.pid ?? null } catch { pid = null }
  return {
    mode: 'daemon', userDataDir: deps.userDataDir, connection, checkedAt,
    version: connection.state === 'version-mismatch' ? connection.running : null,
    pid, startedAt: null, devices: null, activeRuns: null
  }
}
