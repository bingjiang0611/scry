import { ensureShellEnv } from '../main/shell'
import { readSupervisorProcessConfig, type SupervisorProcessConfig } from './daemon-config'
import { daemonLaunchEnvironment } from './supervisor'

// What the supervisor entry decides before it launches anything, kept apart from the
// entry script so it can be tested without spawning a process. Plain Node only: the
// supervisor runs as ELECTRON_RUN_AS_NODE (daemon-imports.test.ts).

export interface SupervisorLaunchPlan {
  config: SupervisorProcessConfig
  daemonEnv: NodeJS.ProcessEnv
}

/**
 * Throws a machine code (`daemon_config_*`) on a configuration the supervisor must not
 * start with. Fills `SHELL` in `env` first: a service manager or a desktop launcher may
 * start the supervisor without one, and the daemon's shell probe and terminals need it
 * (an existing value is kept).
 */
export function prepareSupervisorLaunch(env: NodeJS.ProcessEnv, options: {
  pid: number
  /** This bundle's App version (scryBundleVersion()); undefined when unbundled. */
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
