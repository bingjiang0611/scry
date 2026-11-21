import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

/**
 * S2 guard: verify a daemon process command line belongs to this dev checkout's
 * `<appPath>/out/main/daemon.js` entry (bounded by path/token boundaries so `/repo`
 * cannot match `/repo-other` or `/Applications/Scry.app/...`).
 */
export function daemonCommandBelongsToCheckout(command: string, appPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const trimmed = command.trim()
  const root = appPath.trim()
  if (!trimmed || !root) return false
  const candidates = new Set<string>()
  const add = (base: string): void => {
    const abs = resolve(base)
    candidates.add(join(abs, 'out', 'main', 'daemon.js'))
    try { candidates.add(join(realpathSync(abs), 'out', 'main', 'daemon.js')) } catch { /* ignore */ }
  }
  add(root)
  const hay = platform === 'darwin' || platform === 'win32' ? trimmed.toLowerCase() : trimmed
  for (const entry of candidates) {
    const needle = platform === 'darwin' || platform === 'win32' ? entry.toLowerCase() : entry
    let at = hay.indexOf(needle)
    while (at >= 0) {
      const before = at === 0 ? ' ' : hay[at - 1]
      const after = at + needle.length >= hay.length ? ' ' : hay[at + needle.length]
      if (/[\s"'=]/.test(before) && /[\s"']/.test(after)) return true
      at = hay.indexOf(needle, at + 1)
    }
  }
  return false
}

export interface VersionMismatchMeta {
  activeRuns?: number
  isPackaged?: boolean
  probeActiveRuns?: () => Promise<number | undefined>
}

export interface VersionMismatchPromptDeps {
  daemonMode: boolean
  /**
   * Development builds only (`!app.isPackaged`): when true and the mismatched daemon
   * proves it is unpackaged / belongs to this checkout AND has `activeRuns === 0`
   * immediately before signalling, restart automatically without a blocking dialog (W15).
   * Packaged builds always keep this false.
   */
  autoRestartIdle?: boolean
  /**
   * S2 ownership check: must resolve `true` (daemon reported `isPackaged: false` or lock
   * holder belongs to this dev checkout) before auto-restart is permitted. Fail closed.
   */
  canAutoRestartTarget?(meta?: { isPackaged?: boolean }): Promise<boolean>
  /**
   * S1 live re-check immediately before auto-restart: must resolve strictly `0`,
   * otherwise fall back to the confirmation dialog.
   */
  recheckActiveRuns?(): Promise<number | undefined>
  /** The native dialog; resolves with the index of the button the user chose. */
  ask(prompt: BackgroundServicePrompt): Promise<number>
  /** The «后台服务» restart action, with the same exclusivity as its channel. */
  restart(): Promise<BackgroundServiceActionResult>
  /** Restart path used only after S2 + S1 pass; still re-checks live activeRuns before SIGTERM. */
  restartIdle?(probeActiveRuns?: () => Promise<number | undefined>): Promise<BackgroundServiceActionResult>
  reportFailure(prompt: BackgroundServicePrompt): Promise<void>
  /** A «后台服务» action is already running; the user is dealing with the service. */
  actionInProgress(): boolean
}

export type VersionMismatchPromptOutcome =
  | { status: 'not-shown'; reason: 'daemon-mode-disabled' | 'not-mismatch' | 'already-shown' | 'action-in-progress' }
  | { status: 'later' }
  | { status: 'restart'; result: BackgroundServiceActionResult }

const RESTART_ERROR = 'background_service_restart_error'

export function createVersionMismatchPrompt(
  deps: VersionMismatchPromptDeps
): (connection: BackgroundServiceConnection, meta?: VersionMismatchMeta) => Promise<VersionMismatchPromptOutcome> {
  let spent = false
  return async (connection, meta) => {
    if (!deps.daemonMode) return { status: 'not-shown', reason: 'daemon-mode-disabled' }
    if (connection.state !== 'version-mismatch') return { status: 'not-shown', reason: 'not-mismatch' }
    if (spent) return { status: 'not-shown', reason: 'already-shown' }
    // Spent before the first await: a second detection while the dialog is open, or
    // after any answer, never shows another one.
    spent = true
    if (deps.actionInProgress()) return { status: 'not-shown', reason: 'action-in-progress' }
    let idleAutoRestart = false
    const probeRuns = meta?.probeActiveRuns ?? deps.recheckActiveRuns
    if (deps.autoRestartIdle && meta?.activeRuns === 0 && deps.restartIdle && deps.canAutoRestartTarget && probeRuns) {
      const targetAllowed = await deps.canAutoRestartTarget({ isPackaged: meta.isPackaged }).catch(() => false)
      if (targetAllowed) {
        // S1: re-verify live activeRuns immediately before skipping the dialog.
        const liveRuns = await probeRuns().catch(() => undefined)
        idleAutoRestart = liveRuns === 0
      }
    }
    if (!idleAutoRestart && await deps.ask(versionMismatchPrompt(connection.running, connection.expected)) !== MISMATCH_RESTART_BUTTON) {
      return { status: 'later' }
    }
    let result: BackgroundServiceActionResult
    try {
      result = idleAutoRestart ? await deps.restartIdle!(probeRuns) : await deps.restart()
    } catch {
      // The settings channel would surface a throw to its caller; here nobody else
      // would see it, so it is reported like any other failure.
      result = { status: 'failed', reason: RESTART_ERROR, message: reasonMessage(RESTART_ERROR) }
    }
    if (result.status === 'failed') await deps.reportFailure(restartFailedNotice(result.message))
    return { status: 'restart', result }
  }
}
