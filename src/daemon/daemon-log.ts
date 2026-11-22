import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'


export function daemonLogPath(userDataDir: string): string {
  return join(userDataDir, 'logs', 'daemon.log')
}

export function openDaemonLog(userDataDir: string): number {
  mkdirSync(join(userDataDir, 'logs'), { recursive: true, mode: 0o700 })
  return openSync(daemonLogPath(userDataDir), 'a', 0o600)
}

export function precreateDaemonLog(userDataDir: string): string {
  closeSync(openDaemonLog(userDataDir))
  return daemonLogPath(userDataDir)
}
