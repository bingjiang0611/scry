import { ensureShellEnv } from '../main/shell'
import { readSupervisorProcessConfig, type SupervisorProcessConfig } from './daemon-config'
import { daemonLaunchEnvironment } from './supervisor'


export interface SupervisorLaunchPlan {
  config: SupervisorProcessConfig
  daemonEnv: NodeJS.ProcessEnv
}

export function prepareSupervisorLaunch(env: NodeJS.ProcessEnv, options: {
  pid: number
  bundleVersion: string | undefined
  platform?: NodeJS.Platform
}): SupervisorLaunchPlan {
  ensureShellEnv(env, options.platform)
  const config = readSupervisorProcessConfig(env, options.bundleVersion)
  const daemonEnv = daemonLaunchEnvironment({
    source: env,
    stateDirectory: config.stateDirectory,
    userDataDir: config.userDataDir,
    appPath: config.appPath,
    resourcesPath: config.resourcesPath,
    appVersion: config.appVersion,
    isPackaged: config.isPackaged,
    startedBy: `supervisor:${options.pid}`,
    ...(config.launchedBy ? { launchedBy: config.launchedBy } : {})
  })
  return { config, daemonEnv }
}
