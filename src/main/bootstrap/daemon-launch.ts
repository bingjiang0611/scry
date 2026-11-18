import { accessSync, closeSync, constants, mkdirSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { daemonLaunchEnvironment } from '../../daemon/supervisor'

// Starting the background service from the App. The App does not run the daemon
// itself and never owns its lifetime: it starts the supervisor, which owns restart
// policy, and then only talks to the socket. Launching is the one place with a
// packaged/dev difference, so it is resolved here instead of at each caller.

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
    startedBy: `app:${process.pid}`
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
    const directory = join(input.userDataDir, 'logs')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    log = openSync(join(directory, 'daemon.log'), 'a', 0o600)
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
    // A detached child outlives this process, so an error after a successful spawn
    // belongs in the log, not in an unhandled exception.
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
