import { isAbsolute } from 'node:path'
import { callDaemonChannel } from '../daemon-channel-gate'

// The App owns window selection and file references; the daemon owns project records,
// recent folders, and session directories. Resolve a named project via the daemon's
// agent:setCwd operation without reading a local copy of those stores. Refusal leaves
// selection unchanged; clearing a blank selection does not require a daemon call.

/** Checks for a nonblank directory argument without validating the path. */
export function namesDirectory(dir: unknown): dir is string {
  return typeof dir === 'string' && dir.trim() !== ''
}

/**
 * The daemon's resolveKnownProjectDirectory: the canonical path of a project it knows,
 * or its refusal. A request that names no directory is refused here with the error main's
 * resolver gives it, without a round trip.
 */
export function daemonKnownProjectDirectory(cwd: unknown): Promise<string>
export function daemonKnownProjectDirectory(cwd: unknown, clearIfMissing: boolean): Promise<string | null>
export async function daemonKnownProjectDirectory(cwd: unknown, clearIfMissing = false): Promise<string | null> {
  if (!namesDirectory(cwd)) throw new Error('无效的工作目录')
  const resolved = await callDaemonChannel('agent:setCwd', clearIfMissing ? [cwd, true] : [cwd])
  if (resolved === null && clearIfMissing) return null
  if (typeof resolved !== 'string' || !isAbsolute(resolved)) throw new Error('invalid_daemon_response')
  return resolved
}

export interface DaemonWindowSelection {
  getCurrentCwd: () => string | undefined
  setCurrentCwd: (cwd: string | undefined) => void
  invalidateSessionHistoryLoad: (reason: string) => void
}

/**
 * agent:setCwd in daemon mode. main's handler resolved synchronously, so selections took
 * effect in the order the window sent them; here each waits for the one before it, so a
 * slow daemon reply cannot overwrite a later selection. A refusal leaves the selection as
 * it was and does not hold up the next call.
 */
export function daemonSetCwdHandler(window: DaemonWindowSelection): (event: unknown, dir: unknown, clearIfMissing?: boolean) => Promise<string | null> {
  let previous: Promise<unknown> = Promise.resolve()
  return (_event, dir, clearIfMissing) => {
    const next = previous.then(async () => {
      const selected = namesDirectory(dir) ? await daemonKnownProjectDirectory(dir, clearIfMissing === true) : null
      const cwd = selected ?? undefined
      if (cwd !== window.getCurrentCwd()) window.invalidateSessionHistoryLoad('workspace changed')
      window.setCurrentCwd(cwd)
      return cwd ?? null
    })
    previous = next.catch(() => undefined)
    return next
  }
}
