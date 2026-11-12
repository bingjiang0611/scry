import type { BackgroundServiceAction, BackgroundServiceActionResult, BackgroundServiceConnection } from '../shared/background-service'
import type { DaemonLockRecord } from '../daemon/ledger-lock'
import type { PreparedStop, StopOutcome } from './background-service-stop'
import { reasonMessage } from './background-service-copy'

// The three «后台服务» actions (B4-S S0-1): restart, quit with the service, and reconnect
// after the local grant was revoked. Decisions only; Electron (dialogs, app.quit) and the
// daemon client are injected by bootstrap/background-service.ts.
//
// Order is the rule: identify the holder (daemon.lock + identity) → ask when runs may be
// interrupted → re-verify and signal once (background-service-stop.ts) → only then
// launch or enroll. While a stop is in flight the App launches no daemon of its own
// (holdLaunches), so a retried read cannot bring the old one back mid-stop.

export interface BackgroundServiceActionDeps {
  daemonMode: boolean
  connection(): Promise<BackgroundServiceConnection>
  /** Unsettled runs the daemon reports; undefined when it could not be asked. */
  activeRuns(): Promise<number | undefined>
  prepareStop(): Promise<PreparedStop>
  stop(holder: DaemonLockRecord): Promise<StopOutcome>
  /** The second confirmation (main's dialog); true only when the user confirmed. */
  confirm(action: BackgroundServiceAction, activeRuns: number | null): Promise<boolean>
  /** Refuse daemon launches until the returned release runs. */
  holdLaunches(): () => void
  /** Drop the current daemon outcome and connect again: adopt, launch, enroll. */
  reconnect(): Promise<BackgroundServiceConnection>
  /** Delete the App's stored local credential, which the daemon refused (revoked). */
  discardLocalCredential(): Promise<void>
  /** What the stopped daemon left behind, before the App quits. */
  reportLeftovers(leftovers: string[]): Promise<void>
  quitApp(): void
}

const done: BackgroundServiceActionResult = { status: 'done' }
const cancelled: BackgroundServiceActionResult = { status: 'cancelled' }
const failed = (reason: string): BackgroundServiceActionResult => ({ status: 'failed', reason, message: reasonMessage(reason) })

function connectionResult(connection: BackgroundServiceConnection): BackgroundServiceActionResult {
  if (connection.state === 'ready') return done
  if (connection.state === 'unavailable') return failed(connection.reason)
  return failed(connection.state === 'version-mismatch' ? 'daemon_version_mismatch' : 'daemon_device_not_authorized')
}

async function knownRuns(deps: BackgroundServiceActionDeps): Promise<number | null> {
  try { return (await deps.activeRuns()) ?? null } catch { return null }
}

export async function restartBackgroundService(deps: BackgroundServiceActionDeps): Promise<BackgroundServiceActionResult> {
  if (!deps.daemonMode) return failed('daemon_mode_disabled')
  const prepared = await deps.prepareStop()
  if (prepared.status === 'refused') return failed(prepared.reason)
  if (prepared.status === 'running') {
    const runs = await knownRuns(deps)
    // Ask whenever a run may be interrupted, including when the daemon cannot say.
    if (runs !== 0 && !await deps.confirm('restart', runs)) return cancelled
    const release = deps.holdLaunches()
    let stopped: StopOutcome
    try { stopped = await deps.stop(prepared.holder) } finally { release() }
    if (stopped.status === 'refused') return failed(stopped.reason)
  }
  return connectionResult(await deps.reconnect())
}

export async function quitWithBackgroundService(deps: BackgroundServiceActionDeps): Promise<BackgroundServiceActionResult> {
  if (!deps.daemonMode) return failed('daemon_mode_disabled')
  const prepared = await deps.prepareStop()
  if (prepared.status === 'refused') return failed(prepared.reason)
  if (prepared.status === 'running') {
    const runs = await knownRuns(deps)
    if (runs !== 0 && !await deps.confirm('quit', runs)) return cancelled
    // Held until the App exits: quitting must not start the daemon it just stopped.
    const release = deps.holdLaunches()
    let stopped: StopOutcome
    try { stopped = await deps.stop(prepared.holder) } catch (error) { release(); throw error }
    if (stopped.status === 'refused') {
      // Fail closed: the daemon may still run, so the App stays open and says why.
      release()
      return failed(stopped.reason)
    }
    if (stopped.leftovers.length > 0) await deps.reportLeftovers(stopped.leftovers)
  } else {
    deps.holdLaunches()
  }
  deps.quitApp()
  return done
}

export async function reconnectBackgroundService(deps: BackgroundServiceActionDeps): Promise<BackgroundServiceActionResult> {
  if (!deps.daemonMode) return failed('daemon_mode_disabled')
  // Offered only for a revoked local grant, and never started on the App's own.
  const connection = await deps.connection()
  if (connection.state !== 'device-not-authorized') return failed('daemon_device_authorized')
  const prepared = await deps.prepareStop()
  if (prepared.status === 'refused') return failed(prepared.reason)
  // Always asked: the App holds no grant, so it cannot learn whether runs are active.
  if (!await deps.confirm('reconnect', null)) return cancelled
  const release = deps.holdLaunches()
  try {
    if (prepared.status === 'running') {
      const stopped = await deps.stop(prepared.holder)
      if (stopped.status === 'refused') return failed(stopped.reason)
    }
    // The daemon refused this credential; keeping it would make the next connect present
    // it again instead of enrolling with the new secret the restarted daemon writes.
    await deps.discardLocalCredential()
  } finally {
    release()
  }
  return connectionResult(await deps.reconnect())
}
