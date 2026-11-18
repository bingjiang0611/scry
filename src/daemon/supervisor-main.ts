import { dirname, join, resolve } from 'node:path'
import { daemonLaunchEnvironment, launchDaemonOnce, superviseDaemon } from './supervisor'
import { readDaemonProcessConfig } from './daemon-config'

let config: ReturnType<typeof readDaemonProcessConfig>
try { config = readDaemonProcessConfig(process.env) } catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(2)
}
const { stateDirectory, userDataDir, appPath, resourcesPath, appVersion, isPackaged } = config
const supervisorEntry = resolve(process.argv[1] ?? '')
const daemonEntry = resolve(process.env.SCRY_DAEMON_ENTRY ?? join(dirname(supervisorEntry), 'daemon.js'))
const executable = process.execPath
// A stop request (from a service manager, or Ctrl-C) is forwarded to the daemon once;
// the supervisor then waits for the daemon's exit, bounded, before it leaves itself.
const abort = new AbortController()
process.on('SIGTERM', () => abort.abort())
process.on('SIGINT', () => abort.abort())

const env = daemonLaunchEnvironment({
  stateDirectory,
  userDataDir,
  appPath,
  resourcesPath,
  appVersion,
  isPackaged,
  startedBy: `supervisor:${process.pid}`
})
const result = await superviseDaemon({
  directory: stateDirectory,
  stopSignal: abort.signal,
  launch: () => launchDaemonOnce({ executable, daemonEntry, env, signal: abort.signal })
})
if (result.status === 'stop-timeout') {
  process.stderr.write('daemon_stop_timeout\n')
  process.exit(1)
}
if (result.status === 'exhausted' || result.status === 'failed') process.exit(1)
process.exit(0)
