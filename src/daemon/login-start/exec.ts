import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

// Fixed-path, shell-free external command runner for launchctl / systemctl / loginctl
// (P5-headless-host §2.3). Timeout bounded to 10 s.

export const MACOS_LAUNCHCTL = '/bin/launchctl'
export const LINUX_SYSTEMCTL = '/usr/bin/systemctl'
export const LINUX_LOGINCTL = '/usr/bin/loginctl'
export const SERVICE_COMMAND_TIMEOUT_MS = 10_000

export interface CommandResult {
  exitCode: number | null
  stdout: string
  timedOut: boolean
  notFound: boolean
}

export type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<CommandResult>

export function executableExists(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const runFixedCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (!error) {
        resolve({ exitCode: 0, stdout: String(stdout ?? ''), timedOut: false, notFound: false })
        return
      }
      const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number | null; signal?: NodeJS.Signals | null }
      const notFound = err.code === 'ENOENT'
      const timedOut = Boolean(err.killed) && err.signal === 'SIGTERM'
      const exitCode = typeof err.code === 'number' ? err.code : null
      resolve({ exitCode, stdout: String(stdout ?? ''), timedOut, notFound })
    })
  })

export function commandFailure(
  baseReason: string,
  result: CommandResult
): { ok: false; reason: string; exitCode?: number } {
  if (result.timedOut) return { ok: false, reason: `${baseReason}_timeout` }
  if (result.notFound) return { ok: false, reason: 'login_start_command_missing' }
  return { ok: false, reason: baseReason, ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}) }
}
