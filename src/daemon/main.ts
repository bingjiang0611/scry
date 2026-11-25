import { resolve } from 'node:path'
import { startDaemon, exitCodeForStartup } from './lifecycle'
import { createDaemonHostProcess } from './host-process'
import { readDaemonProcessConfig } from './daemon-config'
import { createDaemonSignalShutdown } from './signal-shutdown'
import { classifyDaemonStartupFailure } from './startup-failure'
import { ensureShellEnv } from '../main/shell'

ensureShellEnv()

let config: ReturnType<typeof readDaemonProcessConfig>
try { config = readDaemonProcessConfig(process.env) } catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(2)
}
const { stateDirectory, userDataDir, appPath, resourcesPath, appVersion, isPackaged } = config

const shutdown = createDaemonSignalShutdown()
process.on('SIGTERM', () => { shutdown.stop() })
process.on('SIGINT', () => { shutdown.stop() })

const startedBy = process.env.SCRY_DAEMON_STARTED_BY ?? 'unknown'
const daemonEntry = resolve(process.argv[1] ?? '')
const result = await startDaemon({
  stateDirectory,
  userDataDir,
  startedBy,
  daemonEntry,
  startHost: () => createDaemonHostProcess({
    userDataDir,
    daemonStateDirectory: stateDirectory,
    appPath,
    resourcesPath,
    appVersion,
    isPackaged
  })
}).catch((error: unknown) => {
  const failure = classifyDaemonStartupFailure(error)
  process.stderr.write(`${failure.reason ?? (error instanceof Error ? error.message : 'daemon_startup_failed')}\n`)
  process.exit(failure.code)
})
if (result.status !== 'started') process.exit(exitCodeForStartup(result))
shutdown.ready(result.dispose)
