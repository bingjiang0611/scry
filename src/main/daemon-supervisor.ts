import { sameBuild, type BuildIdentity } from '../shared/build-identity'
import type { DaemonProbeInfo } from './daemon-client'

export type DaemonProbe = () => Promise<DaemonProbeInfo | undefined>
export type DaemonLaunch = () => Promise<{ status: 'started' | 'already-running' | 'failed'; reason?: string }>

export interface DaemonSupervisorOptions {
  probe: DaemonProbe
  launch: DaemonLaunch
  appVersion: string
  /** This App's build id; the same version from another build is a mismatch (A5). */
  appBuild?: string
  /**
   * The named reason this launch already gave up with, if any (daemon-launch-failure.ts).
   * A refusal such as `daemon_userdata_owned` is final; waiting out the timeout would
   * only replace its name with `daemon_ready_timeout`.
   */
  launchFailure?: () => Promise<string | undefined>
  readyTimeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type DaemonSupervisorResult =
  | { status: 'adopted'; version: string }
  | { status: 'started'; version: string }
  // The daemon answers but was built from different sources (another version, or the
  // same version from another build). The App must not talk to it: the user decides
  // whether to restart it. A build field is absent when that side has no build id.
  | { status: 'version-mismatch'; running: string; runningBuild?: string; runningActiveRuns?: number; runningIsPackaged?: boolean; expected: string; expectedBuild?: string; action: 'restart_daemon' }
  | { status: 'unavailable'; reason: string }

export const DAEMON_READY_TIMEOUT_MS = 10_000
const READY_POLL_MS = 250

export async function ensureDaemon(options: DaemonSupervisorOptions): Promise<DaemonSupervisorResult> {
  const first = await probeQuietly(options.probe)
  if (first !== undefined) return adopt(first, options)

  const launched = await options.launch()
  if (launched.status === 'failed') return { status: 'unavailable', reason: launched.reason ?? 'daemon_launch_failed' }

  const timeoutMs = options.readyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS
  const pollMs = options.pollMs ?? READY_POLL_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs
  // A launch that reports 'already-running' raced another starter; either way the
  // daemon itself is the one that answers, so the probe decides, not the report.
  while (now() < deadline) {
    const probed = await probeQuietly(options.probe)
    if (probed !== undefined) {
      const adopted = adopt(probed, options)
      return adopted.status === 'adopted' ? { status: 'started', version: adopted.version } : adopted
    }
    const refused = await options.launchFailure?.()
    if (refused) return { status: 'unavailable', reason: refused }
    await sleep(pollMs)
  }
  return { status: 'unavailable', reason: 'daemon_ready_timeout' }
}

function adopt(probed: DaemonProbeInfo, options: Pick<DaemonSupervisorOptions, 'appVersion' | 'appBuild'>): DaemonSupervisorResult {
  const expected: BuildIdentity = options.appBuild === undefined ? { version: options.appVersion } : { version: options.appVersion, build: options.appBuild }
  if (!sameBuild(expected, probed)) {
    return {
      status: 'version-mismatch',
      running: probed.version, ...(probed.build ? { runningBuild: probed.build } : {}),
      ...(probed.activeRuns !== undefined ? { runningActiveRuns: probed.activeRuns } : {}),
      ...(probed.isPackaged !== undefined ? { runningIsPackaged: probed.isPackaged } : {}),
      expected: expected.version, ...(expected.build ? { expectedBuild: expected.build } : {}),
      action: 'restart_daemon'
    }
  }
  return { status: 'adopted', version: probed.version }
}

// A daemon that is starting, restarting or being replaced is "not there yet", not an
// error to surface: the caller's next step is to launch or wait.
async function probeQuietly(probe: DaemonProbe): Promise<DaemonProbeInfo | undefined> {
  try { return await probe() } catch { return undefined }
}
