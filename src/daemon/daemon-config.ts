import { join, resolve } from 'node:path'

export interface DaemonProcessConfig {
  stateDirectory: string
  userDataDir: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
}

const REQUIRED = [
  'SCRY_DAEMON_STATE_DIR',
  'SCRY_DAEMON_USER_DATA_DIR',
  'SCRY_DAEMON_APP_PATH',
  'SCRY_DAEMON_RESOURCES_PATH',
  'SCRY_DAEMON_APP_VERSION',
  'SCRY_DAEMON_PACKAGED'
] as const

export function readDaemonProcessConfig(env: NodeJS.ProcessEnv): DaemonProcessConfig {
  for (const key of REQUIRED) {
    if (!env[key]?.trim()) throw new Error(`daemon_config_missing_${key.toLowerCase()}`)
  }
  if (env.SCRY_DAEMON_PACKAGED !== '0' && env.SCRY_DAEMON_PACKAGED !== '1') {
    throw new Error('daemon_config_invalid_scry_daemon_packaged')
  }
  return {
    stateDirectory: resolve(env.SCRY_DAEMON_STATE_DIR!),
    userDataDir: resolve(env.SCRY_DAEMON_USER_DATA_DIR!),
    appPath: resolve(env.SCRY_DAEMON_APP_PATH!),
    resourcesPath: resolve(env.SCRY_DAEMON_RESOURCES_PATH!),
    appVersion: env.SCRY_DAEMON_APP_VERSION!,
    isPackaged: env.SCRY_DAEMON_PACKAGED === '1'
  }
}

export function daemonPrivateCliPath(resourcesPath: string): string {
  return join(resolve(resourcesPath), 'bin', 'scry')
}
