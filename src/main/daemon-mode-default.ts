import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Packaged builds, development builds (`npm run dev`), and `SCRY_TEST_APP=1` test
// instances all default to daemon mode unless `SCRY_HOST_DAEMON` is explicitly set
// (W15 / P3-s3-plan §1). Explicit `SCRY_HOST_DAEMON=0` remains the in-process escape
// hatch for one release cycle. This module is imported first by the main entry so every
// later reader of `daemonModeEnabled` sees the resolved value.

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

export function applyDaemonModeDefault(
  env: NodeJS.ProcessEnv,
  input?: { isPackaged?: boolean; userDataDir?: string; appDataDir?: string; appName?: string; platform?: NodeJS.Platform }
): void {
  if (input?.userDataDir && input?.appDataDir && input?.appName) {
    assertIsolatedTestUserData(env, {
      userDataDir: input.userDataDir,
      appDataDir: input.appDataDir,
      appName: input.appName,
      ...(input.platform ? { platform: input.platform } : {})
    })
  }
  if (env.SCRY_HOST_DAEMON !== undefined) return
  env.SCRY_HOST_DAEMON = '1'
}
