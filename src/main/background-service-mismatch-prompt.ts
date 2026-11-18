import type { BackgroundServiceActionResult, BackgroundServiceConnection } from '../shared/background-service'
import { MISMATCH_RESTART_BUTTON, reasonMessage, restartFailedNotice, versionMismatchPrompt, type BackgroundServicePrompt } from './background-service-copy'

// The one startup prompt for a daemon of another version (B4-S, approved 2026-11-12).
// Detection is the lazy run surface's own: the first time this App process learns the
// daemon is another version, it is told here. No probe of its own, nothing blocks.
//
// At most one prompt per App process, whatever the answer: 「稍后」 must not come back
// on the next run call, and a restart that failed must not be retried by itself. The
// settings section «后台服务» still explains the mismatch and offers restart.
//
// 「重启后台服务」 is the settings section's restart action (injected), so identity
// re-verification, the confirmation for runs that may be interrupted, the launch hold
// and the failure reasons are the same code, not a second implementation.

export interface VersionMismatchPromptDeps {
  daemonMode: boolean
  /** The native dialog; resolves with the index of the button the user chose. */
  ask(prompt: BackgroundServicePrompt): Promise<number>
  /** The «后台服务» restart action, with the same exclusivity as its channel. */
  restart(): Promise<BackgroundServiceActionResult>
  reportFailure(prompt: BackgroundServicePrompt): Promise<void>
  /** A «后台服务» action is already running; the user is dealing with the service. */
  actionInProgress(): boolean
}

export type VersionMismatchPromptOutcome =
  | { status: 'not-shown'; reason: 'daemon-mode-disabled' | 'not-mismatch' | 'already-shown' | 'action-in-progress' }
  | { status: 'later' }
  | { status: 'restart'; result: BackgroundServiceActionResult }

const RESTART_ERROR = 'background_service_restart_error'

export function createVersionMismatchPrompt(deps: VersionMismatchPromptDeps): (connection: BackgroundServiceConnection) => Promise<VersionMismatchPromptOutcome> {
  let spent = false
  return async (connection) => {
    if (!deps.daemonMode) return { status: 'not-shown', reason: 'daemon-mode-disabled' }
    if (connection.state !== 'version-mismatch') return { status: 'not-shown', reason: 'not-mismatch' }
    if (spent) return { status: 'not-shown', reason: 'already-shown' }
    // Spent before the first await: a second detection while the dialog is open, or
    // after any answer, never shows another one.
    spent = true
    if (deps.actionInProgress()) return { status: 'not-shown', reason: 'action-in-progress' }
    if (await deps.ask(versionMismatchPrompt(connection.running, connection.expected)) !== MISMATCH_RESTART_BUTTON) {
      return { status: 'later' }
    }
    let result: BackgroundServiceActionResult
    try {
      result = await deps.restart()
    } catch {
      // The settings channel would surface a throw to its caller; here nobody else
      // would see it, so it is reported like any other failure.
      result = { status: 'failed', reason: RESTART_ERROR, message: reasonMessage(RESTART_ERROR) }
    }
    if (result.status === 'failed') await deps.reportFailure(restartFailedNotice(result.message))
    return { status: 'restart', result }
  }
}
