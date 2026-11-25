import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

// supervisor (the App, or the login service, P5 §2.1) points its output here, so the
// directory is created owner-only and the file is opened append-only, 0600. Plain Node:
// no Electron, usable by the daemon side.
//
// Rotation happens only when a launcher is about to open the file, never under a running
// writer: a file over DAEMON_LOG_MAX_BYTES becomes daemon.log.1 (older copies shift to .2,
// .3; the oldest is dropped), and the launcher starts a fresh daemon.log. A writer that is
// already running keeps appending to the file it opened, which is the renamed copy, so no
// line is lost; the next launch writes to the new file.

export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024
export const DAEMON_LOG_KEEP = 3

export function daemonLogPath(userDataDir: string): string {
  return join(userDataDir, 'logs', 'daemon.log')
}

function sizeOf(path: string): number | undefined {
  try { return statSync(path).size } catch { return undefined }
}

export function rotateDaemonLog(userDataDir: string, maxBytes = DAEMON_LOG_MAX_BYTES, keep = DAEMON_LOG_KEEP): boolean {
  const path = daemonLogPath(userDataDir)
  const size = sizeOf(path)
  if (size === undefined || size <= maxBytes || keep < 1) return false
  rmSync(`${path}.${keep}`, { force: true })
  for (let index = keep - 1; index >= 1; index--) {
    if (sizeOf(`${path}.${index}`) !== undefined) renameSync(`${path}.${index}`, `${path}.${index + 1}`)
  }
  renameSync(path, `${path}.1`)
  return true
}

export function openDaemonLog(userDataDir: string): number {
  mkdirSync(join(userDataDir, 'logs'), { recursive: true, mode: 0o700 })
  try { rotateDaemonLog(userDataDir) } catch { /* a failed rotation must not stop the launch */ }
  return openSync(daemonLogPath(userDataDir), 'a', 0o600)
}

export function precreateDaemonLog(userDataDir: string): string {
  closeSync(openDaemonLog(userDataDir))
  return daemonLogPath(userDataDir)
}
