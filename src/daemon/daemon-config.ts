import { join, resolve } from 'node:path'

export interface DaemonProcessConfig {
  stateDirectory: string
  userDataDir: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
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
  // Same order as before the split, so the first missing key reported is unchanged.
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

/** The daemon's configuration: its launcher (the supervisor) always names the version. */
export function readDaemonProcessConfig(env: NodeJS.ProcessEnv): DaemonProcessConfig {
  return { ...readCommon(env, true), appVersion: env[VERSION]! }
}

/**
 * The supervisor's configuration. Its version is its own bundle's (`bundleVersion`), so
 * a service file carries none and stays valid across upgrades; a version in the
 * environment must agree with it, since the daemon would otherwise announce a version
 * this build is not. Unbundled code has no bundle version and still requires one.
 */
export function readSupervisorProcessConfig(env: NodeJS.ProcessEnv, bundleVersion: string | undefined): DaemonProcessConfig {
  const common = readCommon(env, bundleVersion === undefined)
  const given = present(env[VERSION]) ? env[VERSION] : undefined
  if (bundleVersion !== undefined && given !== undefined && given !== bundleVersion) {
    throw new Error('daemon_config_version_conflict')
  }
  return { ...common, appVersion: bundleVersion ?? given! }
}

export function daemonPrivateCliPath(resourcesPath: string): string {
  return join(resolve(resourcesPath), 'bin', 'scry')
}
