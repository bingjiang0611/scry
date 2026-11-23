import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Startup guards the main entry runs first (daemon-mode-default-entry.ts). Every App
// build talks to the background service, which owns runs: S3 removed the in-process
// runtime from Electron main, and with it the `SCRY_HOST_DAEMON=0` escape hatch. An
// explicit `SCRY_HOST_DAEMON` other than `1` is now ignored with a one-line warning.

export interface AppUserDataPaths {
  userDataDir: string
  appDataDir: string
  appName: string
  platform?: NodeJS.Platform
}

function canonicalOrResolved(target: string): string {
  const abs = resolve(target)
  try { return realpathSync(abs) } catch { return abs }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const left = canonicalOrResolved(a)
  const right = canonicalOrResolved(b)
  return platform === 'darwin' || platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/**
 * True when `userDataDir` points at Electron's default `appData/<appName>` (or `appData/scry`)
 * instead of an isolated test directory.
 */
export function isDefaultAppUserDataDir(paths: AppUserDataPaths): boolean {
  const platform = paths.platform ?? process.platform
  return samePath(paths.userDataDir, join(paths.appDataDir, paths.appName), platform)
    || samePath(paths.userDataDir, join(paths.appDataDir, 'scry'), platform)
}

/**
 * S3 fail-closed guard: `SCRY_TEST_APP=1` must never reuse Electron's default userData
 * directory (`appData/<name>`), where it would attach to or launch a daemon against the
 * user's daily ledger and sockets.
 */
export function assertIsolatedTestUserData(env: NodeJS.ProcessEnv, paths?: AppUserDataPaths): void {
  if (env.SCRY_TEST_APP !== '1' || !paths) return
  if (isDefaultAppUserDataDir(paths)) {
    throw new Error(`test_app_requires_isolated_user_data: SCRY_TEST_APP=1 refuses default userData (${paths.userDataDir})`)
  }
}

/** The retired switch; read only to say that it no longer does anything. */
export const RETIRED_DAEMON_MODE_ENV = 'SCRY_HOST_DAEMON'

export function retiredDaemonModeWarning(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[RETIRED_DAEMON_MODE_ENV]
  if (value === undefined || value === '1') return undefined
  return `[scry] ${RETIRED_DAEMON_MODE_ENV}=${JSON.stringify(value.slice(0, 32))} is ignored: the in-process runtime was removed and the background service always runs Agents`
}

export function applyAppStartupGuards(
  env: NodeJS.ProcessEnv,
  input?: { userDataDir?: string; appDataDir?: string; appName?: string; platform?: NodeJS.Platform },
  warn: (line: string) => void = (line) => { console.warn(line) }
): void {
  if (input?.userDataDir && input?.appDataDir && input?.appName) {
    assertIsolatedTestUserData(env, {
      userDataDir: input.userDataDir,
      appDataDir: input.appDataDir,
      appName: input.appName,
      ...(input.platform ? { platform: input.platform } : {})
    })
  }
  const retired = retiredDaemonModeWarning(env)
  if (retired) warn(retired)
}
