import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { loginStartTargetFromBundle, type LoginStartTarget } from './login-start'


const APP_DATA_NAME = 'Scry'

export function defaultHostUserDataDir(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', APP_DATA_NAME)
  }
  const xdg = env.XDG_CONFIG_HOME?.trim()
  const base = xdg && isAbsolute(xdg) ? xdg : join(homeDir, '.config')
  return join(base, APP_DATA_NAME)
}

export function resolveHostCliTarget(options: {
  executable?: string
  userDataDir?: string
  platform?: NodeJS.Platform
  homeDir?: string
  env?: NodeJS.ProcessEnv
} = {}): LoginStartTarget {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const env = options.env ?? process.env
  const userDataDir = options.userDataDir ?? defaultHostUserDataDir(platform, homeDir, env)
  const executable = options.executable ?? process.execPath
  return loginStartTargetFromBundle(executable, userDataDir, platform)
}
