import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

// The background service's one log file, `<userData>/logs/daemon.log`. Whoever starts the
// supervisor (the App today, a login service later, P5 §2.1) points its output here, so
// the directory is created owner-only and the file is opened append-only, 0600. Existing
// content is kept; there is no rotation. Plain Node: no Electron, usable by the daemon side.

export function daemonLogPath(userDataDir: string): string {
  return join(userDataDir, 'logs', 'daemon.log')
}

/** Opens the log for appending, creating `logs` (0700) and the file (0600) when absent. */
export function openDaemonLog(userDataDir: string): number {
  mkdirSync(join(userDataDir, 'logs'), { recursive: true, mode: 0o700 })
  return openSync(daemonLogPath(userDataDir), 'a', 0o600)
}

/**
 * Creates the directory and file a service manager will append to, then closes it: a
 * service manager would otherwise create them with its own umask. Returns the path.
 */
export function precreateDaemonLog(userDataDir: string): string {
  closeSync(openDaemonLog(userDataDir))
  return daemonLogPath(userDataDir)
}
