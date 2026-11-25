import { accessSync, closeSync, constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { daemonLaunchEnvironment } from '../../daemon/supervisor'
import { openDaemonLog } from '../../daemon/daemon-log'

// Direct launch starts the supervisor, not the daemon. The supervisor owns restart
// policy; the App talks to the daemon over its socket. Resolve the packaged or
// development supervisor entry here rather than at each caller.

export interface DaemonLaunchTarget {
  executable: string
  supervisorEntry: string
}

export function daemonLaunchTarget(input: {
  isPackaged: boolean
  appPath: string
  execPath: string
}): DaemonLaunchTarget {
  // Packaged: the App binary re-runs as Node and the entries live inside the asar.
  // Development: the same shape, resolved from the built output.
  return {
    executable: input.execPath,
    supervisorEntry: join(input.appPath, 'out', 'main', 'daemon-supervisor.js')
  }
}

export interface DaemonLaunchResult {
  status: 'started' | 'failed'
  reason?: string
  pid?: number
}

export function spawnDaemonSupervisor(input: {
  target: DaemonLaunchTarget
  stateDirectory: string
  userDataDir: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
}): DaemonLaunchResult {
  const environment = daemonLaunchEnvironment({
    ...(input.env ? { source: input.env } : {}),
    stateDirectory: input.stateDirectory,
    userDataDir: input.userDataDir,
    appPath: input.appPath,
    resourcesPath: input.resourcesPath,
    appVersion: input.appVersion,
    isPackaged: input.isPackaged,
    startedBy: `app:${process.pid}`,
    launchedBy: 'app'
  })
  // Check the two files before spawning: a missing executable would otherwise be an
  // unhandled 'error' event on a detached child, not a reported failure.
  const missing = [input.target.executable, input.target.supervisorEntry].find((path) => {
    try { accessSync(path, constants.R_OK); return false } catch { return true }
  })
  if (missing) return { status: 'failed', reason: `daemon_launch_target_missing:${missing === input.target.executable ? 'executable' : 'supervisor'}` }
  // The daemon outlives the App, so its output cannot go to a pipe this process
  // owns. One append-only file per user data directory, readable by the user only.
  let log: number
  try {
    log = openDaemonLog(input.userDataDir)
  } catch (error) {
    return { status: 'failed', reason: `daemon_log_unavailable:${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}` }
  }
  try {
    const child = spawn(input.target.executable, [input.target.supervisorEntry], {
      env: environment,
      stdio: ['ignore', log, log],
      detached: true,
      windowsHide: true
    })
    // Consume the child error event; only stdout and stderr are redirected to the log.
    child.once('error', () => undefined)
    if (child.pid === undefined) return { status: 'failed', reason: 'daemon_spawn_failed' }
    child.unref()
    return { status: 'started', pid: child.pid }
  } catch (error) {
    return { status: 'failed', reason: `daemon_spawn_failed:${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}` }
  } finally {
    // The child owns its copy of the descriptor.
    closeSync(log)
  }
}
