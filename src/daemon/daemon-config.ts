import { join, resolve } from 'node:path'

export interface DaemonProcessConfig {
  stateDirectory: string
  userDataDir: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
}

export type DaemonLaunchedBy = 'app' | 'service'

export interface SupervisorProcessConfig extends DaemonProcessConfig {
  launchedBy?: DaemonLaunchedBy
}

const PATHS = [
  'SCRY_DAEMON_STATE_DIR',
  'SCRY_DAEMON_USER_DATA_DIR',
  'SCRY_DAEMON_APP_PATH',
  'SCRY_DAEMON_RESOURCES_PATH'
] as const
const VERSION = 'SCRY_DAEMON_APP_VERSION'
const PACKAGED = 'SCRY_DAEMON_PACKAGED'

const present = (value: string | undefined): value is string => Boolean(value?.trim())

function missing(key: string): Error {
  return new Error(`daemon_config_missing_${key.toLowerCase()}`)
}

function readCommon(env: NodeJS.ProcessEnv, requireVersion: boolean): Omit<DaemonProcessConfig, 'appVersion'> {
  for (const key of PATHS) if (!present(env[key])) throw missing(key)
  if (requireVersion && !present(env[VERSION])) throw missing(VERSION)
  if (!present(env[PACKAGED])) throw missing(PACKAGED)
  if (env[PACKAGED] !== '0' && env[PACKAGED] !== '1') {
    throw new Error('daemon_config_invalid_scry_daemon_packaged')
  }
  return {
    stateDirectory: resolve(env.SCRY_DAEMON_STATE_DIR!),
    userDataDir: resolve(env.SCRY_DAEMON_USER_DATA_DIR!),
    appPath: resolve(env.SCRY_DAEMON_APP_PATH!),
    resourcesPath: resolve(env.SCRY_DAEMON_RESOURCES_PATH!),
    isPackaged: env[PACKAGED] === '1'
  }
}

export function readDaemonProcessConfig(env: NodeJS.ProcessEnv): DaemonProcessConfig {
  return { ...readCommon(env, true), appVersion: env[VERSION]! }
}

export function readSupervisorProcessConfig(env: NodeJS.ProcessEnv, bundleVersion: string | undefined): SupervisorProcessConfig {
  const common = readCommon(env, bundleVersion === undefined)
  const given = present(env[VERSION]) ? env[VERSION] : undefined
  if (bundleVersion !== undefined && given !== undefined && given !== bundleVersion) {
    throw new Error('daemon_config_version_conflict')
  }
  const launchedBy = env.SCRY_DAEMON_LAUNCHED_BY
  if (launchedBy !== undefined && launchedBy !== 'app' && launchedBy !== 'service') {
    throw new Error('daemon_config_invalid_scry_daemon_launched_by')
  }
  return { ...common, appVersion: bundleVersion ?? given!, ...(launchedBy ? { launchedBy } : {}) }
}

export function daemonPrivateCliPath(resourcesPath: string): string {
  return join(resolve(resourcesPath), 'bin', 'scry')
}
