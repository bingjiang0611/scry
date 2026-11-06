import { dirname, join, resolve } from 'node:path'
import { daemonLaunchEnvironment, launchDaemonOnce, superviseDaemon } from './supervisor'

const stateDirectory = process.env.SCRY_DAEMON_STATE_DIR
const userDataDir = process.env.SCRY_DAEMON_USER_DATA_DIR
if (!stateDirectory || !userDataDir) {
  process.stderr.write('daemon_supervisor_paths_missing: set SCRY_DAEMON_STATE_DIR and SCRY_DAEMON_USER_DATA_DIR\n')
  process.exit(2)
}
const supervisorEntry = resolve(process.argv[1] ?? '')
const daemonEntry = resolve(process.env.SCRY_DAEMON_ENTRY ?? join(dirname(supervisorEntry), 'daemon.js'))
const executable = process.execPath
const abort = new AbortController()
process.on('SIGTERM', () => abort.abort())
process.on('SIGINT', () => abort.abort())

const env = daemonLaunchEnvironment({
  stateDirectory,
  userDataDir,
  appPath: resolve(process.env.SCRY_DAEMON_APP_PATH ?? process.cwd()),
  resourcesPath: resolve(process.env.SCRY_DAEMON_RESOURCES_PATH ?? join(process.cwd(), 'resources')),
  appVersion: process.env.SCRY_DAEMON_APP_VERSION ?? '0.2.237',
  isPackaged: process.env.SCRY_DAEMON_PACKAGED === '1',
  startedBy: `supervisor:${process.pid}`
})
const result = await superviseDaemon({
  directory: stateDirectory,
  launch: () => launchDaemonOnce({ executable, daemonEntry, env, signal: abort.signal })
})
if (result.status === 'exhausted') process.exit(1)
process.exit(0)
