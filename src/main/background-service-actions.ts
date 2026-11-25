import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackgroundServiceAction, BackgroundServiceActionResult, BackgroundServiceConnection } from '../shared/background-service'
import type { DaemonLockRecord } from '../daemon/ledger-lock'
import type { LoginStartMutationResult } from '../daemon/login-start'
import type { PreparedStop, StopOutcome } from './background-service-stop'
import { loginStartFailureMessage, reasonMessage } from './background-service-copy'

// The three «后台服务» actions (B4-S S0-1): restart, quit with the service, and reconnect
// after the local grant was revoked. Decisions only; Electron (dialogs, app.quit) and the
// daemon client are injected by bootstrap/background-service.ts.
//
// Order is the rule: identify the holder (daemon.lock + identity) → ask when runs may be
// interrupted → re-verify and signal once (background-service-stop.ts) → only then
// launch or enroll. Reconnect also covers a credential the App lost (A6). While a stop is in flight the App launches no daemon of its own
// (holdLaunches), so a retried read cannot bring the old one back mid-stop.

export interface BackgroundServiceActionDeps {
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
  /**
   * Ask the next daemon start for an enrollment secret although a local grant is live
   * (daemon/local-enrollment-request.ts). Written only here: confirmed, daemon stopped.
   */
  requestLocalEnrollment(): Promise<void>
  /** Whether the App still has its stored local credential (the file, not its validity). */
  hasLocalCredential(): Promise<boolean>
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
  const prepared = await deps.prepareStop()
  if (prepared.status === 'refused') return failed(prepared.reason)
  if (prepared.status === 'running') {
    const runs = await knownRuns(deps)
    // Ask whenever a run may be interrupted, including when the daemon cannot say.
    if (runs !== 0 && !await deps.confirm('restart', runs)) return cancelled
    const release = deps.holdLaunches()
    let stopped: StopOutcome
    try {
      stopped = await deps.stop(prepared.holder)
      if (stopped.status === 'stopped') await requestIfNoCredential(deps)
    } finally { release() }
    if (stopped.status === 'refused') return failed(stopped.reason)
  } else if (!await deps.hasLocalCredential()) {
    const release = deps.holdLaunches()
    try { await deps.requestLocalEnrollment() } finally { release() }
  }
  return connectionResult(await deps.reconnect())
}

// An App with no stored credential cannot enroll with a daemon that holds a live local
// grant (an enrollment-time mismatch spent the secret, or the credential was lost), and
// the restarted daemon would write no secret. The user asked for this restart, and the
// daemon was stopped after its identity was verified: ask the next start for one, as the
// reconnect action does (maintainer 2026-11-12).
async function requestIfNoCredential(deps: BackgroundServiceActionDeps): Promise<void> {
  if (!await deps.hasLocalCredential()) await deps.requestLocalEnrollment()
}

export async function quitWithBackgroundService(deps: BackgroundServiceActionDeps): Promise<BackgroundServiceActionResult> {
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
    // A revoked grant leaves no live local grant, so the restarted daemon writes a secret
    // anyway. A grant the App lost (credential deleted) or another instance holds is still
    // live, and without this request the restarted daemon would write none (A6). The new
    // enrollment then revokes that grant, as the confirmation said.
    await deps.requestLocalEnrollment()
  } finally {
    release()
  }
  return connectionResult(await deps.reconnect())
}

export type LoginStartPrecheck =
  | { ok: true; policyEnvKeys: string[] }
  | { ok: false; reason: string; otherUserDataDir?: string; otherExecutable?: string }

export interface LoginStartActionDeps {
  precheckEnable(): LoginStartPrecheck
  confirmEnable(policyEnvKeys: readonly string[]): Promise<boolean>
  isDaemonRunning(): Promise<boolean>
  enable(options: { daemonRunning: boolean }): Promise<LoginStartMutationResult>
  disable(options: { daemonRunning: boolean }): Promise<LoginStartMutationResult>
}

export async function setBackgroundServiceLoginStart(
  enabled: boolean,
  deps: LoginStartActionDeps
): Promise<BackgroundServiceActionResult> {
  if (enabled) {
    const precheck = deps.precheckEnable()
    if (!precheck.ok) {
      return {
        status: 'failed',
        reason: precheck.reason,
        message: loginStartFailureMessage(precheck)
      }
    }
    if (!await deps.confirmEnable(precheck.policyEnvKeys)) return cancelled
    const daemonRunning = await deps.isDaemonRunning()
    const outcome = await deps.enable({ daemonRunning })
    if (!outcome.ok) {
      return { status: 'failed', reason: outcome.reason, message: loginStartFailureMessage(outcome) }
    }
    return done
  }
  const daemonRunning = await deps.isDaemonRunning()
  const outcome = await deps.disable({ daemonRunning })
  if (!outcome.ok) {
    return { status: 'failed', reason: outcome.reason, message: loginStartFailureMessage(outcome) }
  }
  return done
}

export interface HostCliApprovalActionDeps {
  experimentalEnabled: boolean
  connection(): Promise<BackgroundServiceConnection>
  confirmEnable(): Promise<boolean>
  apply(enabled: boolean): Promise<void>
}

export async function setHostCliApproval(
  enabled: boolean,
  deps: HostCliApprovalActionDeps
): Promise<BackgroundServiceActionResult> {
  // N1: enabling requires App to carry SCRY_EXPERIMENTAL_HOST_CLI=1 (and native confirmation),
  // whereas disabling is always allowed so a user can turn off a daemon that carries the flag.
  if (enabled && !deps.experimentalEnabled) return failed('host_cli_experimental_disabled')
  const conn = await deps.connection()
  if (conn.state !== 'ready') return connectionResult(conn)
  if (enabled && !await deps.confirmEnable()) return cancelled
  try {
    await deps.apply(enabled)
    return done
  } catch (error) {
    const reason = error instanceof Error && /^[a-z0-9_:]+$/.test(error.message) ? error.message : 'host_admin_failed'
    return failed(reason)
  }
}

/**
 * C4: automatic resume spends the user's quota, so it is off until the user turns it on in the settings
 * section «后台服务». The switch is one small file under userData because two processes need it: main
 * writes it here, and the daemon reads it when its scheduler decides whether to resume.
 *
 * Not in `shared`: the renderer imports those modules, and a file system import there breaks its build.
 * Read on every decision rather than cached, because a cache would let the App show a switch that no
 * longer matches what the daemon will do.
 */
export const USAGE_LIMIT_RESUME_FILE = 'usage-limit-resume.json'

export interface UsageLimitResumeSwitch {
  enabled: boolean
}

export function usageLimitResumePath(userDataDir: string): string {
  return join(userDataDir, USAGE_LIMIT_RESUME_FILE)
}

/** A missing, unreadable or shapeless file means off: the default never spends anything. */
export function readUsageLimitResumeSwitch(userDataDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(usageLimitResumePath(userDataDir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return false
    return (parsed as { enabled?: unknown }).enabled === true
  } catch {
    return false
  }
}

/** Written under a private mode and renamed into place: a reader sees the old value or the new one. */
export function writeUsageLimitResumeSwitch(userDataDir: string, enabled: boolean): void {
  const target = usageLimitResumePath(userDataDir)
  const temporary = `${target}.${process.pid}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(temporary, `${JSON.stringify({ enabled } satisfies UsageLimitResumeSwitch)}\n`, { mode: 0o600, flag: 'w' })
  chmodSync(temporary, 0o600)
  renameSync(temporary, target)
}
