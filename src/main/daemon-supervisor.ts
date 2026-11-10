// App-side supervision of the local daemon: probe, adopt, launch, wait for ready.
//
// The daemon is a separate process on purpose - it keeps serving paired devices and
// runs while the App is closed - so this supervisor never owns killing it. Every
// step is injected, because the interesting behaviour is the ordering (never launch a
// second daemon, never treat "still starting" as ready) and the version rule.
export type DaemonProbe = () => Promise<{ version: string } | undefined>
export type DaemonLaunch = () => Promise<{ status: 'started' | 'already-running' | 'failed'; reason?: string }>

export interface DaemonSupervisorOptions {
  probe: DaemonProbe
  launch: DaemonLaunch
  appVersion: string
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
  // A daemon was already serving this socket; nothing was launched.
  | { status: 'adopted'; version: string }
  | { status: 'started'; version: string }
  // The daemon answers but was built from different sources. The App must not talk
  // to it: the user decides whether to restart it.
  | { status: 'version-mismatch'; running: string; expected: string; action: 'restart_daemon' }
  | { status: 'unavailable'; reason: string }

export const DAEMON_READY_TIMEOUT_MS = 10_000
const READY_POLL_MS = 250

/** Bring up a usable daemon, or explain exactly why there is none. */
export async function ensureDaemon(options: DaemonSupervisorOptions): Promise<DaemonSupervisorResult> {
  const first = await probeQuietly(options.probe)
  if (first !== undefined) return adopt(first, options.appVersion)

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
      const adopted = adopt(probed, options.appVersion)
      return adopted.status === 'adopted' ? { status: 'started', version: adopted.version } : adopted
    }
    const refused = await options.launchFailure?.()
    if (refused) return { status: 'unavailable', reason: refused }
    await sleep(pollMs)
  }
  return { status: 'unavailable', reason: 'daemon_ready_timeout' }
}

function adopt(probed: { version: string }, appVersion: string): DaemonSupervisorResult {
  if (probed.version !== appVersion) return { status: 'version-mismatch', running: probed.version, expected: appVersion, action: 'restart_daemon' }
  return { status: 'adopted', version: probed.version }
}

// A daemon that is starting, restarting or being replaced is "not there yet", not an
// error to surface: the caller's next step is to launch or wait.
async function probeQuietly(probe: DaemonProbe): Promise<{ version: string } | undefined> {
  try { return await probe() } catch { return undefined }
}
