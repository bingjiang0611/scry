// The settings section «后台服务» (B4-S S0-1): what the App knows about its local daemon,
// and what each of the four actions did. Every field the App could not establish is
// `null` and is shown as unknown: a daemon that did not answer has no "0 devices".

/** How this App reaches its daemon right now. */
export type BackgroundServiceConnection =
  | { state: 'ready' }
  // The daemon answers but was built from other sources; `running` is null when it
  // refused before saying which version it is.
  | { state: 'version-mismatch'; running: string | null; expected: string }
  // The daemon refused this App's local grant (revoked, or enrolled by another instance).
  | { state: 'device-not-authorized' }
  | { state: 'unavailable'; reason: string }

/** Paired devices only: the App's own local grant is how it reaches the daemon, not a device. */
export type BackgroundServiceDevices =
  | { state: 'remote-disabled' }
  | { state: 'known'; paired: number }

/** What the daemon reports about itself (local op `localBackgroundService:status`). */
export interface BackgroundServiceSelfReport {
  version: string
  pid: number
  /** Epoch milliseconds at which the daemon process started. */
  startedAt: number
  devices: BackgroundServiceDevices
  /** Runs the daemon has not settled yet. */
  activeRuns: number
}

export type BackgroundServiceStatus =
  // Switch off: there is no background service; runs live in this App.
  | { mode: 'in-process'; userDataDir: string }
  | {
    mode: 'daemon'
    userDataDir: string
    connection: BackgroundServiceConnection
    version: string | null
    pid: number | null
    /** Epoch milliseconds; null when the daemon did not say. */
    startedAt: number | null
    devices: BackgroundServiceDevices | null
    activeRuns: number | null
    /** When the App read this, so the section can say how fresh it is. */
    checkedAt: number
  }

export type BackgroundServiceAction = 'restart' | 'quit' | 'reconnect'

export type BackgroundServiceActionResult =
  | { status: 'done' }
  // The user declined the confirmation; nothing was signalled.
  | { status: 'cancelled' }
  // Nothing was done, or the action stopped where it failed; `reason` is a machine code
  // and `message` the readable sentence for it.
  | { status: 'failed'; reason: string; message: string }
