import { isAbsolute } from 'node:path'
import { callDaemonChannel } from '../daemon-channel-gate'

// Daemon mode: the known projects (recent folders, project records, session cwds) are the
// daemon's userData. The window selection (agent:setCwd) and the known-project file
// channels stay in the App, which has the window and main's read-only file references,
// but whether a directory is a known project is the daemon's answer, asked on every call
// (workspaceSelection:setCwd: the daemon's resolveKnownProjectDirectory, persisting
// nothing). Nothing here reads or caches the App's own copy of those stores, and a
// daemon that cannot answer refuses the call.

/** main's agent:setCwd test for "names a directory"; anything else clears the selection. */
export function namesDirectory(dir: unknown): dir is string {
  return typeof dir === 'string' && dir.trim() !== ''
}

/**
 * The daemon's resolveKnownProjectDirectory: the canonical path of a project it knows,
 * or its refusal. A request that names no directory is refused here with the error main's
 * resolver gives it, without a round trip.
 */
export async function daemonKnownProjectDirectory(cwd: unknown): Promise<string> {
  if (!namesDirectory(cwd)) throw new Error('无效的工作目录')
  const resolved = await callDaemonChannel('agent:setCwd', [cwd])
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
export function daemonSetCwdHandler(window: DaemonWindowSelection): (event: unknown, dir: unknown) => Promise<string | null> {
  let previous: Promise<unknown> = Promise.resolve()
  return (_event, dir) => {
    const next = previous.then(async () => {
      const cwd = namesDirectory(dir) ? await daemonKnownProjectDirectory(dir) : undefined
      if (cwd !== window.getCurrentCwd()) window.invalidateSessionHistoryLoad('workspace changed')
      window.setCurrentCwd(cwd)
      return cwd ?? null
    })
    previous = next.catch(() => undefined)
    return next
  }
}
